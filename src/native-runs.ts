import type { PluginContext, PluginIssueRunSummary } from "@paperclipai/plugin-sdk";
import { readAdmission, recordUnadmittedRun, type AdmissionUsage, type AdmissionRemainingExposure } from "./admission.js";
import { councilNativeRequest } from "./decision-adapter.js";
import { exactRunUsageUnits, readNativeG4Profile, suppressedBeforeProvider, type NativeRunReadback } from "./g4-native.js";
import { MissionError, type MissionRecord } from "./missions.js";
import { nativeRunBindings } from "./native-run-bindings.js";
import type { NativeWakePolicy } from "./native-wake-policy.js";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function issueRuns(ctx: PluginContext, companyId: string, issueId: string) {
  const summary = await ctx.issues.summaries.getOrchestration({ companyId, issueId, includeSubtree: false });
  if (summary.companyId !== companyId || summary.issueId !== issueId || summary.runs.length > 256
      || new Set(summary.runs.map(run => run.id)).size !== summary.runs.length
      || summary.runs.some(run => run.issueId !== issueId || !uuid.test(run.id) || !uuid.test(run.agentId))) {
    throw new MissionError(409, "native_run_inventory_unqualified", "Exact bounded issue/run inventory required before another launch");
  }
  return summary.runs;
}

export async function initialNativeWakePolicy(ctx: PluginContext, companyId: string, rootIssueId: string, runLimit?: unknown): Promise<NativeWakePolicy> {
  if (runLimit !== undefined && (!Number.isSafeInteger(runLimit) || Number(runLimit) < 1 || Number(runLimit) > 256)) {
    throw new MissionError(422, "native_run_limit_invalid", "Optional nativeRunLimit must be an explicit integer from 1 to 256");
  }
  const runs = await issueRuns(ctx, companyId, rootIssueId);
  if (runs.some(run => !terminal.has(run.status))) throw new MissionError(409, "native_root_already_running", "A new Council mandate cannot adopt an active unadmitted root run");
  return { protocol: "council-native-wake-v2", rootBaseline: runs.map(run => ({ runId: run.id, agentId: run.agentId })),
    ...(runLimit !== undefined ? { runLimit: Number(runLimit) } : {}) };
}

function unadmittedUsage(run: NativeRunReadback | null, summary: PluginIssueRunSummary): {
  usage: AdmissionUsage; remainingExposure: AdmissionRemainingExposure;
} {
  const source = `paperclip:GET-heartbeat-run:terminal-token-ledger;run=${summary.id};agent=${summary.agentId};issue=${summary.issueId}`;
  const total = run && (suppressedBeforeProvider(run) ? 0 : exactRunUsageUnits(run));
  return { usage: total === null ? { status: "unknown", reason: "Exact terminal per_run native usage is unavailable; preserve this run hold" }
      : { status: "known", source, units: total },
    remainingExposure: run && terminal.has(run.status) && run.startedAt && run.finishedAt
      ? { status: "known", source: `${source};terminal=${run.status}`, units: 0 }
      : { status: "unknown", reason: "Native run has no qualified terminal state; no exposure ceiling is inferred" } };
}

async function exceptionRun(ctx: PluginContext, m: MissionRecord, summary: PluginIssueRunSummary) {
  const response = await councilNativeRequest(ctx, m.companyId, `/api/heartbeat-runs/${summary.id}`).catch(() => ({ status: 0, body: null }));
  const run = response.body as NativeRunReadback | null;
  const bindings = { id: summary.id, companyId: m.companyId, agentId: summary.agentId };
  return response.status === 200 && run && Object.entries(bindings).every(([key, value]) => run[key as keyof typeof bindings] === value)
    && run.contextSnapshot?.issueId === summary.issueId ? run : null;
}

/** Observation may stop subsequent launches; it cannot intercept every external provider departure. */
export async function assertNativeRunInventory(ctx: PluginContext, m: MissionRecord, newDeparture = false) {
  const policy = m.aggregate.nativeWakePolicy;
  if (policy?.protocol !== "council-native-wake-v2") return;
  const bindings = nativeRunBindings(m);
  const issueIds = [...new Set([m.rootIssueId, ...bindings.map(binding => binding.issueId)])];
  if (issueIds.length > 64) throw new MissionError(409, "native_run_inventory_bound", "Owned issue inventory exceeds its observation bound; no launch permitted");
  const summaries = (await Promise.all(issueIds.map(id => issueRuns(ctx, m.companyId, id)))).flat();
  const { periodKey } = (await readNativeG4Profile(ctx, m.companyId)) ?? {};
  if (!periodKey) throw new MissionError(409, "native_run_accounting_profile", "Pinned native inventory requires its configured token accounting period");
  if (m.aggregate.n1?.periodKey && m.aggregate.n1.periodKey !== periodKey) throw new MissionError(409, "native_run_period_drift", "The accounting period changed; retain the mission's original ledger");
  let envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey });
  const reserved = bindings.filter(binding => envelope?.reservations.some(r => r.missionId === m.missionId && r.reservationId === binding.reservationId));
  const baseline = (run: PluginIssueRunSummary) => run.issueId === m.rootIssueId && policy.rootBaseline.some(old => old.runId === run.id && old.agentId === run.agentId);
  const foreign = summaries.filter(run => !reserved.some(binding => binding.runId === run.id && binding.issueId === run.issueId && binding.agentId === run.agentId) && !baseline(run));
  for (const summary of foreign) {
    if (reserved.some(binding => binding.pending && binding.issueId === summary.issueId && binding.agentId === summary.agentId)) {
      throw new MissionError(409, "native_wake_binding_unknown", "An admitted wake remains unbound; reconcile its existing identity before classifying or repeating it");
    }
    const run = await exceptionRun(ctx, m, summary);
    await recordUnadmittedRun(ctx, { companyId: m.companyId, periodKey, missionId: m.missionId,
      runId: summary.id, issueId: summary.issueId!, agentId: summary.agentId, nativeStatus: run?.status ?? summary.status,
      ...unadmittedUsage(run, summary) });
  }
  envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey });
  if (foreign.length || envelope?.unadmittedRuns?.length) {
    throw new MissionError(409, "unadmitted_native_run", "Native runs without admission are retained in the period ledger; stop new departures and resolve the exact exception", {
      runIds: envelope?.unadmittedRuns?.map(run => run.runId) ?? foreign.map(run => run.id) });
  }
  if (newDeparture && policy.runLimit !== undefined && summaries.filter(run => !baseline(run)).length >= policy.runLimit) {
    throw new MissionError(409, "native_run_limit_exceeded", "Observed mission runs consume the existing native run limit; no additional departure permitted");
  }
}
