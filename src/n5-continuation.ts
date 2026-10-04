import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { n2CommandCas, nativeN2Profile, reserveN2Run, runtimeUuid } from "./n2-missions.js";
import { readNativeRun } from "./g4-native.js";
import { readN5Plan } from "./n5-native.js";
import { acceptedN5Submission } from "./n5-preflight.js";

function requiredReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new MissionError(422, "n5_correction_reason", "A bounded substantive correction/replan reason is required");
  return value.trim();
}

/** Consumes the existing mission's sole correction; it never resets N2 or changes its accepted round. */
export function prepareN5Continuation(m: MissionRecord, input: { requestId: string; reservationId: string; reason: string; criteria: string[]; actorId: string; periodKey: string }) {
  acceptedN5Submission(m);
  const n2 = m.aggregate.n2!; const n5 = m.aggregate.n5; const p = n5?.publication;
  if (n2.correctionsUsed >= n2.correctionLimit || n2.rounds.length !== 1 || n5?.continuation) throw new MissionError(409, "correction_limit_exceeded", "The mission's single cumulative correction is already consumed; new product authority would be required");
  if (!n5 || !n2.native || !p?.settledAt || !p.observation || p.state !== "opened" || p.observation.state !== "open") throw new MissionError(409, "n5_correction_publication_required", "Settled native publication and an observed open PR are required");
  const continuation = { requestId: input.requestId, reason: input.reason, criteria: input.criteria, requestedBy: input.actorId,
    requestedAt: new Date().toISOString(), periodKey: input.periodKey, previousApplication: structuredClone(n2.application),
    previousPlan: structuredClone(n5.plan), previousPublication: structuredClone(p), reopen: { state: "claimed" as const, reservationId: input.reservationId } };
  return { ...m.aggregate, phase: "correction_requested" as const, control: { status: "active" as const },
    n5: { ...n5, continuation }, n2: { ...n2, correctionsUsed: 1 as const, status: "correction_requested" as const,
      correction: { requestedByOperationId: input.requestId, criteria: input.criteria, reasons: [input.reason],
        executorAgentId: m.aggregate.responsibilities.integrationLeadAgentId, runId: null, reservationId: input.reservationId, wakeState: "claimed" as const },
      native: { ...n2.native, releaseState: "claimed" as const } },
    journal: [...m.aggregate.journal, { action: "n5_post_acceptance_correction", requestId: input.requestId,
      acceptedSubmissionId: p.submission.submissionId, reservationId: input.reservationId, actorId: input.actorId, reason: input.reason }] };
}

export async function requestN5Correction(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  if (m.version !== body.expectedVersion) throw new MissionError(409, "version_conflict", "Fresh mission version required before reserving correction");
  const requestId = runtimeUuid(body.commandId, "commandId"); const reservationId = runtimeUuid(body.reservationId, "reservationId");
  const reason = requiredReason(body.reason); const criteria = body.criteria;
  if (!Array.isArray(criteria) || criteria.length < 1 || criteria.length > 20 || criteria.some(item => typeof item !== "string" || !item.trim() || item.length > 1000)) throw new MissionError(422, "n5_correction_criteria", "Explicit bounded correction criteria are required");
  const { profile } = await nativeN2Profile(ctx, m);
  const aggregate = prepareN5Continuation(m, { requestId, reservationId, reason, criteria, actorId, periodKey: profile.periodKey });
  const root = await ctx.issues.get(m.rootIssueId, m.companyId);
  if (root?.status !== "done" || root.assigneeAgentId !== m.aggregate.responsibilities.integrationLeadAgentId) throw new MissionError(409, "n5_reopen_target", "Accepted native root must remain done under its integration lead");
  await reserveN2Run(ctx, m, { reservationId, effectId: requestId, kind: "correction" });
  const result = await n2CommandCas(ctx, m, body, "user", actorId, aggregate);
  return { ...result, effectPermission: result.outcome === "applied" ? "execute" : "none",
    nativeAction: { actor: "same_authenticated_owner", method: "PATCH", path: `/api/issues/${m.rootIssueId}`,
      body: { resume: true, comment: `Council correction ${requestId}: ${reason}` },
      instruction: "Execute once using your own native authority. Native resume owns the wake. An uncertain response must be inspected, never retried through another key." } };
}

export async function rebindN5Plan(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const lead = m.aggregate.responsibilities.integrationLeadAgentId; const n5 = m.aggregate.n5;
  const runId = input.actor.runId;
  const admittedRuns = [m.aggregate.n1?.rootDispatchRunId, m.aggregate.n2?.native?.transmission.runId, m.aggregate.n2?.correction?.runId,
    ...m.aggregate.n3?.rounds.map(round => round.transmission?.runId) ?? []];
  if (!n5 || input.actor.actorType !== "agent" || input.actor.agentId !== lead || input.params.issueId !== m.rootIssueId
      || !runId || !admittedRuns.includes(runId)) throw new MissionError(403, "n5_plan_actor", "Exact admitted root lead run required for plan rebinding");
  const run = await readNativeRun(ctx, { companyId: m.companyId, issueId: m.rootIssueId, agentId: lead, runId });
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "n5_plan_run", "Plan rebinding requires its active native lead run");
  const reason = requiredReason(body.reason);
  const plan = await readN5Plan(ctx, m, runtimeUuid(body.planRevisionId, "planRevisionId"));
  for (const field of ["mandateHash", "plannerAgentId", "orchestratorAgentId", "integrationLeadAgentId", "qaAgentId"] as const) {
    if (plan[field] !== n5.plan[field]) throw new MissionError(409, "n5_plan_authority_changed", "Plan rebinding cannot change the mandate or delegated role identities");
  }
  if (canonicalPayloadHash(plan) === canonicalPayloadHash(n5.plan)) throw new MissionError(409, "n5_plan_unchanged", "A new native plan revision is required");
  return n2CommandCas(ctx, m, body, "agent", lead, { ...m.aggregate, n5: { ...n5, plan,
    planHistory: [...n5.planHistory ?? [], { plan: n5.plan, reason, runId, at: new Date().toISOString() }] } });
}
