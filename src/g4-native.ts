import type { PluginContext, PluginIssueOrchestrationSummary } from "@paperclipai/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import { councilNativeRequest } from "./decision-adapter.js";
import {
  AdmissionError,
  readAdmission,
  settleAdmission,
  type AdmissionConfigureInput,
  type AdmissionResult,
  type AdmissionSnapshot,
} from "./admission.js";

const PROFILE_KIND = "paperclip-orchestration-tokens-v1";
const MEASUREMENT_SOURCE = "paperclip:issues.summaries.getOrchestration:terminal-token-ledger";
const ALLOWANCE_SOURCE = "plugin-config:n1OperatingProfile";
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export type NativeRunReadback = {
  id: string; companyId: string; agentId: string; status: string; nativeIssueId: string;
  startedAt: string | null; finishedAt: string | null;
  logBytes?: number | null;
  resultJson?: { summary?: unknown; truncated?: boolean; truncationReason?: string; nativeResult?: { summary?: unknown } };
  contextSnapshot: Record<string, unknown>; usageJson: Record<string, unknown> | null;
};

export async function readNativeRun(ctx: PluginContext, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
}): Promise<NativeRunReadback> {
  const response = await councilNativeRequest(ctx, input.companyId, `/api/heartbeat-runs/${input.runId}`);
  const run = response.body as NativeRunReadback | null;
  if (response.status !== 200 || !run || run.id !== input.runId || run.companyId !== input.companyId
      || run.agentId !== input.agentId || run.nativeIssueId !== input.issueId
      || run.contextSnapshot?.issueId !== input.issueId) {
    throw new AdmissionError(409, "g4_run_identity_unqualified", "Public native run identity does not match its reservation binding");
  }
  return run;
}

/** CLI task identity is its persisted context; no native runner card is implied. */
export async function readOrdinaryRun(ctx: PluginContext, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
}): Promise<NativeRunReadback> {
  const response = await councilNativeRequest(ctx, input.companyId, `/api/heartbeat-runs/${input.runId}`);
  const run = response.body as NativeRunReadback | null;
  if (response.status !== 200 || !run || run.id !== input.runId || run.companyId !== input.companyId
      || run.agentId !== input.agentId || run.contextSnapshot?.issueId !== input.issueId
      || run.nativeIssueId != null || run.contextSnapshot.nativeReviewInteractionId) {
    throw new AdmissionError(409, "g4_run_identity_unqualified", "Public CLI run identity differs from its admitted ordinary task");
  }
  return run;
}

export async function settleOrdinaryRunUsage(ctx: PluginContext, input: {
  commandId: string; companyId: string; issueId: string; runId: string; agentId: string;
  periodKey: string; reservationId: string; expectedVersion: number;
}): Promise<AdmissionResult> {
  return settleExactUsage(ctx, input, await readOrdinaryRun(ctx, input));
}

/** Independent reservations permit native reviewer admission before source cost persistence. */
export async function settleNativeExactRunUsage(ctx: PluginContext, input: {
  commandId: string; companyId: string; issueId: string; runId: string; agentId: string;
  periodKey: string; reservationId: string; expectedVersion: number;
}): Promise<AdmissionResult> {
  return settleExactUsage(ctx, input, await readNativeRun(ctx, input));
}

async function settleExactUsage(ctx: PluginContext, input: {
  commandId: string; companyId: string; issueId: string; runId: string; agentId: string;
  periodKey: string; reservationId: string; expectedVersion: number;
}, run: NativeRunReadback): Promise<AdmissionResult> {
  if (!TERMINAL_RUN_STATUSES.has(run.status) || !run.startedAt || !run.finishedAt) {
    throw new AdmissionError(409, "g4_run_not_terminal", "Exact native run must have started and reached its terminal state");
  }
  const usage = run.usageJson;
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  const cached = usage?.cachedInputTokens ?? 0;
  if (usage?.usageSource !== "per_run" || ![inputTokens, outputTokens, cached].every(value => Number.isSafeInteger(value) && Number(value) >= 0)
      || Number(cached) > Number(inputTokens) || !Number.isSafeInteger(Number(inputTokens) + Number(outputTokens))
      || Number(inputTokens) + Number(outputTokens) <= 0) {
    throw new AdmissionError(409, "g4_usage_unavailable", "Exact terminal run usage remains unknown; its reservation remains held");
  }
  const source = `paperclip:GET-heartbeat-run:terminal-token-ledger;run=${run.id};agent=${run.agentId};issue=${input.issueId}`;
  return settleAdmission(ctx, { commandId: input.commandId, companyId: input.companyId,
    periodKey: input.periodKey, reservationId: input.reservationId, expectedVersion: input.expectedVersion,
    usage: { status: "known", source, units: Number(inputTokens) + Number(outputTokens) },
    remainingExposure: { status: "known", source: `${source};terminal=${run.status}`, units: 0 } });
}

export type NativeG4Profile = {
  kind: typeof PROFILE_KIND;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  periodAllowanceUnits: number;
  runReservationUnits: number;
  initialKnownUsageUnits: number;
  initialExposureUnits: number;
  initialTokenAccountingSource: string;
  maxCorrections: 0 | 1;
};

function requiredString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim() || value.length > max) {
    throw new AdmissionError(422, "g4_profile_invalid", `${label} must be a nonempty bounded string`);
  }
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new AdmissionError(422, "g4_profile_invalid", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new AdmissionError(422, "g4_profile_invalid", `${label} must be a nonnegative safe integer`);
  }
  return Number(value);
}

function initialAccountingSource(profile: NativeG4Profile): string {
  return `${ALLOWANCE_SOURCE}:initial-token-accounting:${profile.initialTokenAccountingSource}`;
}

function isoTimestamp(value: unknown, label: string): string {
  const raw = requiredString(value, label, 100);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) {
    throw new AdmissionError(422, "g4_profile_invalid", `${label} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

export async function readNativeG4Profile(
  ctx: PluginContext,
  companyId: string,
): Promise<NativeG4Profile | null> {
  const config = await ctx.config.get(companyId);
  const raw = config.n1OperatingProfile;
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AdmissionError(422, "g4_profile_invalid", "n1OperatingProfile must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== PROFILE_KIND) {
    throw new AdmissionError(422, "g4_profile_invalid", `n1OperatingProfile.kind must be ${PROFILE_KIND}`);
  }
  const periodStart = isoTimestamp(record.periodStart, "n1OperatingProfile.periodStart");
  const periodEnd = isoTimestamp(record.periodEnd, "n1OperatingProfile.periodEnd");
  if (periodEnd <= periodStart) {
    throw new AdmissionError(422, "g4_profile_invalid", "n1OperatingProfile.periodEnd must be later than periodStart");
  }
  const periodAllowanceUnits = positiveInteger(record.periodAllowanceUnits, "n1OperatingProfile.periodAllowanceUnits");
  const runReservationUnits = positiveInteger(record.runReservationUnits, "n1OperatingProfile.runReservationUnits");
  const initialKnownUsageUnits = nonnegativeInteger(record.initialKnownUsageUnits, "n1OperatingProfile.initialKnownUsageUnits");
  const initialExposureUnits = nonnegativeInteger(record.initialExposureUnits, "n1OperatingProfile.initialExposureUnits");
  const maxCorrections = record.maxCorrections === undefined ? 0 : record.maxCorrections;
  if (maxCorrections !== 0 && maxCorrections !== 1) {
    throw new AdmissionError(422, "g4_profile_invalid", "n1OperatingProfile.maxCorrections must be zero or one");
  }
  const initialCommittedUnits = initialKnownUsageUnits + initialExposureUnits + runReservationUnits;
  if (!Number.isSafeInteger(initialCommittedUnits) || initialCommittedUnits > periodAllowanceUnits) {
    throw new AdmissionError(422, "g4_profile_invalid", "Initial token usage, exposure, and one run reservation exceed the period allowance");
  }
  return {
    kind: PROFILE_KIND,
    periodKey: requiredString(record.periodKey, "n1OperatingProfile.periodKey"),
    periodStart,
    periodEnd,
    periodAllowanceUnits,
    runReservationUnits,
    initialKnownUsageUnits,
    initialExposureUnits,
    initialTokenAccountingSource: requiredString(record.initialTokenAccountingSource, "n1OperatingProfile.initialTokenAccountingSource"),
    maxCorrections,
  };
}

export function nativeAdmissionConfiguration(
  profile: NativeG4Profile,
  companyId: string,
  commandId: string,
): AdmissionConfigureInput {
  const accountingSource = initialAccountingSource(profile);
  return {
    commandId,
    companyId,
    periodKey: profile.periodKey,
    periodStart: profile.periodStart,
    periodEnd: profile.periodEnd,
    measurement: { status: "known", source: MEASUREMENT_SOURCE, unit: "tokens" },
    allowance: {
      status: "known",
      source: accountingSource,
      periodUnits: profile.periodAllowanceUnits,
      taskUnits: profile.runReservationUnits,
      knownUsageUnits: profile.initialKnownUsageUnits,
    },
    exposure: { status: "known", source: accountingSource, units: profile.initialExposureUnits },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: profile.maxCorrections },
  };
}

export function assertNativeEnvelope(
  envelope: AdmissionSnapshot,
  profile: NativeG4Profile,
): void {
  const accountingSource = initialAccountingSource(profile);
  const knownUsageUnits = envelope.allowance.status === "known"
    ? envelope.allowance.knownUsageUnits
    : null;
  const mismatch = envelope.periodKey !== profile.periodKey
    || envelope.periodStart !== profile.periodStart
    || envelope.periodEnd !== profile.periodEnd
    || envelope.measurement.status !== "known"
    || envelope.measurement.source !== MEASUREMENT_SOURCE
    || envelope.measurement.unit !== "tokens"
    || envelope.allowance.status !== "known"
    || envelope.allowance.source !== accountingSource
    || envelope.allowance.periodUnits !== profile.periodAllowanceUnits
    || envelope.allowance.taskUnits !== profile.runReservationUnits
    || !Number.isSafeInteger(knownUsageUnits)
    || knownUsageUnits! < profile.initialKnownUsageUnits
    || envelope.exposure.status !== "known"
    || envelope.exposure.source !== accountingSource
    || envelope.exposure.units !== profile.initialExposureUnits
    || envelope.limits.maxConcurrent !== 2
    || envelope.limits.maxRetries !== 0
    || envelope.limits.maxCorrections !== profile.maxCorrections;
  if (mismatch) {
    throw new AdmissionError(409, "g4_profile_mismatch", "Admission envelope does not match the configured native N1 operating profile");
  }
}

export function assertNativeConfigurationRequest(
  supplied: AdmissionConfigureInput,
  expected: AdmissionConfigureInput,
): void {
  if (!isDeepStrictEqual(supplied, expected)) {
    throw new AdmissionError(422, "g4_profile_mismatch", "Admission configuration must exactly match n1OperatingProfile");
  }
}

async function readNativeOrchestration(
  ctx: PluginContext,
  input: { companyId: string; issueId: string },
): Promise<PluginIssueOrchestrationSummary> {
  return ctx.issues.summaries.getOrchestration({
    companyId: input.companyId,
    issueId: input.issueId,
    includeSubtree: false,
  });
}

function orchestrationUsageUnits(summary: PluginIssueOrchestrationSummary): number {
  // Codex CLI reports cached input as a detail already included in inputTokens.
  // Keep cachedInputTokens in the native summary/evidence, but do not count it twice.
  const { inputTokens, cachedInputTokens, outputTokens } = summary.costs;
  const counters = [inputTokens, cachedInputTokens, outputTokens];
  if (!counters.every((counter) => Number.isSafeInteger(counter) && counter >= 0)
    || cachedInputTokens > inputTokens) {
    throw new AdmissionError(409, "g4_usage_unavailable", "Paperclip issue token counters are inconsistent or not nonnegative safe integers");
  }
  const usageUnits = inputTokens + outputTokens;
  if (!Number.isSafeInteger(usageUnits)) {
    throw new AdmissionError(409, "g4_usage_unavailable", "Paperclip issue token usage exceeds the safe integer range");
  }
  return usageUnits;
}

export async function assertNativeLaunchAllowed(
  ctx: PluginContext,
  input: { companyId: string; issueId: string; priorRunId?: string },
): Promise<number> {
  const summary = await readNativeOrchestration(ctx, input);
  if (summary.invocationBlocks.length > 0) {
    throw new AdmissionError(422, "native_invocation_blocked", "Paperclip reports an invocation budget block", {
      invocationBlocks: summary.invocationBlocks,
    });
  }
  if (summary.openBudgetIncidents.length > 0) {
    throw new AdmissionError(422, "native_budget_incident_open", "Paperclip reports an open budget incident", {
      openBudgetIncidents: summary.openBudgetIncidents,
    });
  }
  const resumed = input.priorRunId && summary.runs.length === 1
    && summary.runs[0].id === input.priorRunId && summary.runs[0].issueId === input.issueId
    && summary.runs[0].status === "succeeded" && summary.runs[0].finishedAt;
  if (input.priorRunId ? !resumed : summary.runs.length > 0) {
    throw new AdmissionError(409, "native_run_already_exists", "The target issue already has a native run; a new launch is not admissible");
  }
  return orchestrationUsageUnits(summary);
}

export async function settleNativeRunUsage(
  ctx: PluginContext,
  input: {
    commandId: string;
    companyId: string;
    issueId: string;
    runId: string;
    baselineUsageUnits: number;
    periodKey: string;
    reservationId: string;
    expectedVersion: number;
  },
): Promise<AdmissionResult> {
  if (!Number.isSafeInteger(input.baselineUsageUnits) || input.baselineUsageUnits < 0) {
    throw new AdmissionError(409, "g4_usage_baseline_unavailable", "Native run usage requires the issue token baseline recorded before wakeup");
  }
  const existingEnvelope = await readAdmission(ctx, {
    companyId: input.companyId,
    periodKey: input.periodKey,
  });
  const existingReservation = existingEnvelope?.reservations
    .find((reservation) => reservation.reservationId === input.reservationId);
  const existingReceipt = existingReservation?.settlementReceipts
    .find((receipt) => receipt.commandId === input.commandId);
  if (existingReservation && existingReceipt) {
    const usageSourcePrefix = `${MEASUREMENT_SOURCE};run=${input.runId};issue-baseline=${input.baselineUsageUnits};`;
    const terminalSourcePrefix = `${MEASUREMENT_SOURCE};terminal=`;
    const replayUsage = existingReceipt.settlement?.usage ?? existingReservation.usage;
    const replayExposure = existingReceipt.settlement?.remainingExposure ?? existingReservation.remainingExposure;
    const terminalStatus = replayExposure.status === "known"
      && replayExposure.source.startsWith(terminalSourcePrefix)
      ? replayExposure.source.slice(terminalSourcePrefix.length)
      : null;
    if (existingReceipt.command !== "settle"
        || replayUsage?.status !== "known"
        || !replayUsage.source.startsWith(usageSourcePrefix)
        || replayExposure.status !== "known"
        || replayExposure.units !== 0
        || !terminalStatus || !TERMINAL_RUN_STATUSES.has(terminalStatus)) {
      throw new AdmissionError(409, "command_identity_conflict",
        "commandId was already used with another native run settlement binding");
    }
    return settleAdmission(ctx, {
      commandId: input.commandId,
      companyId: input.companyId,
      periodKey: input.periodKey,
      reservationId: input.reservationId,
      usage: replayUsage,
      remainingExposure: replayExposure,
      expectedVersion: input.expectedVersion,
    });
  }
  const summary = await readNativeOrchestration(ctx, input);
  const issueRuns = summary.runs.filter((run) => run.issueId === input.issueId);
  if (summary.runs.length !== 1 || issueRuns.length !== 1 || issueRuns[0].id !== input.runId) {
    throw new AdmissionError(409, "g4_run_identity_unqualified", "Token usage cannot be attributed to exactly one expected native issue run", {
      expectedRunId: input.runId,
      observedRunIds: issueRuns.map((run) => run.id),
    });
  }
  const run = issueRuns[0];
  if (!TERMINAL_RUN_STATUSES.has(run.status) || !run.finishedAt) {
    throw new AdmissionError(409, "g4_run_not_terminal", "Native run usage remains unsettled until the run is terminal");
  }
  const cumulativeUsageUnits = orchestrationUsageUnits(summary);
  const usageUnits = cumulativeUsageUnits - input.baselineUsageUnits;
  if (!Number.isSafeInteger(usageUnits) || usageUnits <= 0) {
    throw new AdmissionError(409, "g4_usage_unavailable", "A terminal run without a positive issue-token delta does not prove its consumption", {
      runId: run.id,
      baselineUsageUnits: input.baselineUsageUnits,
      cumulativeUsageUnits,
      costCents: summary.costs.costCents,
    });
  }
  const pricing = summary.costs.costCents > 0
    ? `priced-cost-cents=${summary.costs.costCents}`
    : "monetary-cost=unpriced";
  return settleAdmission(ctx, {
    commandId: input.commandId,
    companyId: input.companyId,
    periodKey: input.periodKey,
    reservationId: input.reservationId,
    usage: {
      status: "known",
      source: `${MEASUREMENT_SOURCE};run=${run.id};issue-baseline=${input.baselineUsageUnits};${pricing}`,
      units: usageUnits,
    },
    remainingExposure: {
      status: "known",
      source: `${MEASUREMENT_SOURCE};terminal=${run.status}`,
      units: 0,
    },
    expectedVersion: input.expectedVersion,
  });
}

export type NativeSequentialUsageBaseline = {
  runIds: string[];
  tokenTotal: number;
};

function tokenTotal(summary: PluginIssueOrchestrationSummary): number {
  return orchestrationUsageUnits(summary);
}

export async function readNativeSequentialUsageBaseline(
  ctx: PluginContext,
  input: { companyId: string; issueId: string },
): Promise<NativeSequentialUsageBaseline> {
  const summary = await readNativeOrchestration(ctx, input);
  const runs = summary.runs.filter((run) => run.issueId === input.issueId);
  if (new Set(runs.map((run) => run.id)).size !== runs.length) {
    throw new AdmissionError(409, "g4_run_identity_unqualified", "Native orchestration returned duplicate run identities");
  }
  return { runIds: runs.map((run) => run.id).sort(), tokenTotal: tokenTotal(summary) };
}

/**
 * Attributes one sequential native run from a previously persisted issue-level
 * checkpoint. The host exposes aggregate issue tokens, so an unexpected extra
 * run makes the delta unattributable and fails closed.
 */
export async function settleNativeSequentialRunUsage(
  ctx: PluginContext,
  input: {
    commandId: string;
    companyId: string;
    issueId: string;
    expectedRunId: string;
    baseline: NativeSequentialUsageBaseline;
    periodKey: string;
    reservationId: string;
    expectedVersion: number;
  },
): Promise<AdmissionResult> {
  if (!Number.isSafeInteger(input.baseline.tokenTotal) || input.baseline.tokenTotal < 0
      || new Set(input.baseline.runIds).size !== input.baseline.runIds.length
      || input.baseline.runIds.includes(input.expectedRunId)) {
    throw new AdmissionError(422, "g4_baseline_invalid", "Sequential usage baseline is malformed or already contains the expected run");
  }
  const summary = await readNativeOrchestration(ctx, input);
  const issueRuns = summary.runs.filter((run) => run.issueId === input.issueId);
  const expectedIds = [...input.baseline.runIds, input.expectedRunId].sort();
  const observedIds = issueRuns.map((run) => run.id).sort();
  if (!isDeepStrictEqual(observedIds, expectedIds)) {
    throw new AdmissionError(409, "g4_run_identity_unqualified", "Sequential usage requires exactly one expected run beyond the persisted baseline", {
      expectedRunId: input.expectedRunId,
      baselineRunIds: input.baseline.runIds,
      observedRunIds: observedIds,
    });
  }
  const run = issueRuns.find((item) => item.id === input.expectedRunId)!;
  if (!TERMINAL_RUN_STATUSES.has(run.status) || !run.finishedAt) {
    throw new AdmissionError(409, "g4_run_not_terminal", "Native run usage remains unsettled until the expected run is terminal");
  }
  const currentTotal = tokenTotal(summary);
  const delta = currentTotal - input.baseline.tokenTotal;
  if (!Number.isSafeInteger(delta) || delta <= 0) {
    throw new AdmissionError(409, "g4_usage_unavailable", "The expected terminal run has no positive attributable token delta", {
      runId: run.id,
      baselineTokenTotal: input.baseline.tokenTotal,
      currentTokenTotal: currentTotal,
    });
  }
  const pricing = summary.costs.costCents > 0
    ? `aggregate-priced-cost-cents=${summary.costs.costCents}`
    : "monetary-cost=unpriced";
  return settleAdmission(ctx, {
    commandId: input.commandId,
    companyId: input.companyId,
    periodKey: input.periodKey,
    reservationId: input.reservationId,
    usage: {
      status: "known",
      source: `${MEASUREMENT_SOURCE};sequential-run=${run.id};baseline-tokens=${input.baseline.tokenTotal};${pricing}`,
      units: delta,
    },
    remainingExposure: {
      status: "known",
      source: `${MEASUREMENT_SOURCE};terminal=${run.status}`,
      units: 0,
    },
    expectedVersion: input.expectedVersion,
  });
}
