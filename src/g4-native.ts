import type { PluginContext, PluginIssueOrchestrationSummary } from "@paperclipai/plugin-sdk";
import { isDeepStrictEqual } from "node:util";
import {
  AdmissionError,
  settleAdmission,
  type AdmissionConfigureInput,
  type AdmissionResult,
  type AdmissionSnapshot,
} from "./admission.js";

const PROFILE_KIND = "paperclip-orchestration-tokens-v1";
const MEASUREMENT_SOURCE = "paperclip:issues.summaries.getOrchestration:terminal-token-ledger";
const ALLOWANCE_SOURCE = "plugin-config:n1OperatingProfile";
const EXPOSURE_SOURCE = "plugin-config:n1OperatingProfile:no-prior-exposure";
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export type NativeG4Profile = {
  kind: typeof PROFILE_KIND;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  periodAllowanceUnits: number;
  runReservationUnits: number;
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
  if (runReservationUnits > periodAllowanceUnits) {
    throw new AdmissionError(422, "g4_profile_invalid", "Run reservation exceeds the period allowance");
  }
  return {
    kind: PROFILE_KIND,
    periodKey: requiredString(record.periodKey, "n1OperatingProfile.periodKey"),
    periodStart,
    periodEnd,
    periodAllowanceUnits,
    runReservationUnits,
  };
}

export function nativeAdmissionConfiguration(
  profile: NativeG4Profile,
  companyId: string,
  commandId: string,
): AdmissionConfigureInput {
  return {
    commandId,
    companyId,
    periodKey: profile.periodKey,
    periodStart: profile.periodStart,
    periodEnd: profile.periodEnd,
    measurement: { status: "known", source: MEASUREMENT_SOURCE, unit: "tokens" },
    allowance: {
      status: "known",
      source: ALLOWANCE_SOURCE,
      periodUnits: profile.periodAllowanceUnits,
      taskUnits: profile.runReservationUnits,
      knownUsageUnits: 0,
    },
    exposure: { status: "known", source: EXPOSURE_SOURCE, units: 0 },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
  };
}

export function assertNativeEnvelope(
  envelope: AdmissionSnapshot,
  profile: NativeG4Profile,
): void {
  const mismatch = envelope.periodKey !== profile.periodKey
    || envelope.periodStart !== profile.periodStart
    || envelope.periodEnd !== profile.periodEnd
    || envelope.measurement.status !== "known"
    || envelope.measurement.source !== MEASUREMENT_SOURCE
    || envelope.measurement.unit !== "tokens"
    || envelope.allowance.status !== "known"
    || envelope.allowance.source !== ALLOWANCE_SOURCE
    || envelope.allowance.periodUnits !== profile.periodAllowanceUnits
    || envelope.allowance.taskUnits !== profile.runReservationUnits
    || envelope.exposure.status !== "known"
    || envelope.exposure.source !== EXPOSURE_SOURCE
    || envelope.exposure.units !== 0
    || envelope.limits.maxConcurrent !== 2
    || envelope.limits.maxRetries !== 0
    || envelope.limits.maxCorrections !== 0;
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
  const usageUnits = summary.costs.inputTokens + summary.costs.cachedInputTokens + summary.costs.outputTokens;
  if (!Number.isSafeInteger(usageUnits) || usageUnits < 0) {
    throw new AdmissionError(409, "g4_usage_unavailable", "Paperclip issue token usage is not a nonnegative safe integer");
  }
  return usageUnits;
}

export async function assertNativeLaunchAllowed(
  ctx: PluginContext,
  input: { companyId: string; issueId: string },
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
  if (summary.runs.length > 0) {
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
  if (!Number.isSafeInteger(input.baselineUsageUnits) || input.baselineUsageUnits < 0) {
    throw new AdmissionError(409, "g4_usage_baseline_unavailable", "Native run usage requires the issue token baseline recorded before wakeup");
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
