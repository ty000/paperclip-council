import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admission.js")>();
  return { ...actual, readAdmission: vi.fn(), settleAdmission: vi.fn() };
});
import { readAdmission, settleAdmission } from "../src/admission.js";
import {
  assertNativeConfigurationRequest,
  assertNativeLaunchAllowed,
  nativeAdmissionConfiguration,
  readNativeG4Profile,
  readNativeSequentialUsageBaseline,
  settleNativeSequentialRunUsage,
  settleNativeRunUsage,
} from "../src/g4-native.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";
const settlementCommandId = "50000000-0000-4000-8000-000000000005";
const reservationId = "60000000-0000-4000-8000-000000000006";

function profile() {
  return {
    kind: "paperclip-orchestration-tokens-v1",
    periodKey: "n1-qualified-2026-10-01",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-02T00:00:00.000Z",
    periodAllowanceUnits: 100_000,
    runReservationUnits: 20_000,
    initialKnownUsageUnits: 7_000,
    initialExposureUnits: 3_000,
    initialTokenAccountingSource: "owner-readback:company-period-2026-10-01",
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    issueId,
    companyId,
    subtreeIssueIds: [issueId],
    relations: {},
    approvals: [],
    runs: [{
      id: runId, issueId, agentId: "40000000-0000-4000-8000-000000000004",
      status: "succeeded", invocationSource: "on_demand", triggerDetail: null,
      startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:01:00.000Z",
      error: null, createdAt: "2026-10-01T10:00:00.000Z",
    }],
    costs: { costCents: 0, inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, billingCode: null },
    openBudgetIncidents: [],
    invocationBlocks: [],
    ...overrides,
  };
}

function context(config: Record<string, unknown>, orchestration = summary()) {
  return {
    config: { get: vi.fn(async () => config) },
    issues: { summaries: { getOrchestration: vi.fn(async () => orchestration) } },
  } as never;
}

it("refuses unresolved native blockers before any launch claim, including a known terminal resume", async () => {
  const ctx = context({}, summary({ relations: { [issueId]: { blockedBy: [{ id: "child", status: "blocked" }], blocks: [] } } }));
  await expect(assertNativeLaunchAllowed(ctx, { companyId, issueId, priorRunId: runId })).rejects.toMatchObject({ code: "native_issue_blocked" });
});

it.each(["exact", "missing", "foreign", "duplicate", "active", "failed"])("checks every historical lead identity before another launch: %s", async kind => {
  const second = "30000000-0000-4000-8000-000000000004";
  const runs = [summary().runs[0]!, { ...summary().runs[0]!, id: second }];
  if (kind === "missing") runs.pop();
  if (kind === "foreign") runs[1]!.id = "30000000-0000-4000-8000-000000000005";
  if (kind === "duplicate") runs[1]!.id = runId;
  if (kind === "active") runs[0]!.status = "running";
  if (kind === "failed") runs[0]!.status = "failed";
  const result = assertNativeLaunchAllowed(context({}, summary({ runs })), { companyId, issueId, priorRunIds: [runId, second] });
  if (kind === "exact") await expect(result).resolves.toBe(130);
  else await expect(result).rejects.toMatchObject({ code: "native_run_already_exists" });
});

function settledEnvelope(input: { commandId?: string; runId?: string; baselineUsageUnits?: number } = {}) {
  const commandId = input.commandId ?? settlementCommandId;
  const settledRunId = input.runId ?? runId;
  const baselineUsageUnits = input.baselineUsageUnits ?? 40;
  return {
    version: 4,
    reservations: [{
      reservationId,
      status: "settled",
      usage: {
        status: "known",
        source: `paperclip:issues.summaries.getOrchestration:terminal-token-ledger;run=${settledRunId};issue-baseline=${baselineUsageUnits};monetary-cost=unpriced`,
        units: 90,
      },
      remainingExposure: {
        status: "known",
        source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger;terminal=succeeded",
        units: 0,
      },
      settlementReceipts: [{
        commandId,
        command: "settle",
        payloadHash: "a".repeat(64),
        appliedVersion: 4,
        recordedAt: "2026-10-01T10:02:00.000Z",
        settlement: {
          usage: {
            status: "known",
            source: `paperclip:issues.summaries.getOrchestration:terminal-token-ledger;run=${settledRunId};issue-baseline=${baselineUsageUnits};monetary-cost=unpriced`,
            units: 90,
          },
          remainingExposure: {
            status: "known",
            source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger;terminal=succeeded",
            units: 0,
          },
        },
      }],
    }],
  };
}

describe("native G4 profile", () => {
  beforeEach(() => {
    vi.mocked(readAdmission).mockReset().mockResolvedValue(null);
    vi.mocked(settleAdmission).mockReset();
  });

  it("derives one fixed sequential token-ledger envelope from explicit plugin config", async () => {
    const parsed = await readNativeG4Profile(context({ n1OperatingProfile: profile() }), companyId);
    expect(parsed).toEqual({ ...profile(), maxCorrections: 0 });
    const configuration = nativeAdmissionConfiguration(parsed!, companyId, "50000000-0000-4000-8000-000000000005");
    expect(configuration).toMatchObject({
      measurement: { status: "known", unit: "tokens" },
      allowance: {
        status: "known", periodUnits: 100_000, taskUnits: 20_000, knownUsageUnits: 7_000,
        source: "plugin-config:n1OperatingProfile:initial-token-accounting:owner-readback:company-period-2026-10-01",
      },
      exposure: {
        status: "known", units: 3_000,
        source: "plugin-config:n1OperatingProfile:initial-token-accounting:owner-readback:company-period-2026-10-01",
      },
      limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
    });
    expect(() => assertNativeConfigurationRequest(configuration, configuration)).not.toThrow();
    expect(() => assertNativeConfigurationRequest(
      { ...configuration, limits: { ...configuration.limits, maxConcurrent: 3 } },
      configuration,
    )).toThrow(/exactly match/);
  });

  it("refuses missing or already-exhausted initial token accounting", async () => {
    const missing = { ...profile() } as Record<string, unknown>;
    delete missing.initialTokenAccountingSource;
    await expect(readNativeG4Profile(context({ n1OperatingProfile: missing }), companyId))
      .rejects.toMatchObject({ code: "g4_profile_invalid" });

    await expect(readNativeG4Profile(context({
      n1OperatingProfile: { ...profile(), initialKnownUsageUnits: 80_000, initialExposureUnits: 1 },
    }), companyId)).rejects.toMatchObject({ code: "g4_profile_invalid" });
  });

  it("treats Codex cached input as a detail already included in input tokens", async () => {
    await expect(assertNativeLaunchAllowed(context({}, summary({ runs: [] })), { companyId, issueId })).resolves.toBe(130);
  });

  it("fails closed on malformed individual token counters", async () => {
    const malformedCosts = [
      { costCents: 0, inputTokens: -10, cachedInputTokens: 0, outputTokens: 20, billingCode: null },
      { costCents: 0, inputTokens: 10, cachedInputTokens: 11, outputTokens: 20, billingCode: null },
      { costCents: 0, inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: 0, outputTokens: 1, billingCode: null },
    ];
    for (const costs of malformedCosts) {
      await expect(assertNativeLaunchAllowed(context({}, summary({ runs: [], costs })), { companyId, issueId }))
        .rejects.toMatchObject({ code: "g4_usage_unavailable" });
    }
  });

  it("allows one explicitly configured correction without changing the legacy default", async () => {
    const parsed = await readNativeG4Profile(context({
      n1OperatingProfile: { ...profile(), maxCorrections: 1 },
    }), companyId);
    expect(parsed?.maxCorrections).toBe(1);
    expect(nativeAdmissionConfiguration(parsed!, companyId, "50000000-0000-4000-8000-000000000005").limits.maxCorrections).toBe(1);
    await expect(readNativeG4Profile(context({
      n1OperatingProfile: { ...profile(), maxCorrections: 2 },
    }), companyId)).rejects.toMatchObject({ code: "g4_profile_invalid" });
  });

  it("honors host invocation and budget blocks before a native launch", async () => {
    await expect(assertNativeLaunchAllowed(context({}, summary({
      runs: [],
      invocationBlocks: [{ issueId, agentId: "agent", scopeType: "company", scopeId: companyId, scopeName: "Company", reason: "budget" }],
    })), { companyId, issueId })).rejects.toMatchObject({ code: "native_invocation_blocked" });
    await expect(assertNativeLaunchAllowed(context({}, summary({
      runs: [],
      openBudgetIncidents: [{ id: "incident", scopeType: "company", scopeId: companyId }],
    })), { companyId, issueId })).rejects.toMatchObject({ code: "native_budget_incident_open" });
  });

  it("settles only the exact terminal run and labels zero monetary cost as unpriced", async () => {
    vi.mocked(settleAdmission).mockResolvedValue({ outcome: "settled" } as never);
    await expect(settleNativeRunUsage(context({}, summary()), {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 40,
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).resolves.toEqual({ outcome: "settled" });
    expect(settleAdmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      usage: expect.objectContaining({ status: "known", units: 90, source: expect.stringContaining("issue-baseline=40") }),
      remainingExposure: expect.objectContaining({ status: "known", units: 0, source: expect.stringContaining("terminal=succeeded") }),
    }));
  });

  it("replays a lost settlement response before mutable issue counters can change its payload", async () => {
    const getOrchestration = vi.fn()
      .mockResolvedValueOnce(summary())
      .mockResolvedValue(summary({
        costs: { costCents: 0, inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 30, billingCode: null },
      }));
    const ctx = {
      issues: { summaries: { getOrchestration } },
    } as never;
    vi.mocked(readAdmission)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(settledEnvelope() as never);
    vi.mocked(settleAdmission)
      .mockResolvedValueOnce({ outcome: "settled" } as never)
      .mockResolvedValueOnce({ outcome: "replayed" } as never)
      .mockResolvedValueOnce({ outcome: "settled" } as never);
    const initial = {
      commandId: settlementCommandId,
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 40,
      periodKey: "n1-qualified-2026-10-01",
      reservationId,
      expectedVersion: 3,
    };

    await expect(settleNativeRunUsage(ctx, initial)).resolves.toEqual({ outcome: "settled" });
    await expect(settleNativeRunUsage(ctx, initial)).resolves.toEqual({ outcome: "replayed" });

    expect(getOrchestration).toHaveBeenCalledTimes(1);
    expect(settleAdmission).toHaveBeenCalledTimes(2);
    expect(vi.mocked(settleAdmission).mock.calls[1][1]).toEqual(vi.mocked(settleAdmission).mock.calls[0][1]);
    expect(vi.mocked(settleAdmission).mock.calls[1][1]).toMatchObject({
      commandId: settlementCommandId,
      reservationId,
      usage: { status: "known", units: 90 },
    });

    const newCommandId = "70000000-0000-4000-8000-000000000007";
    await expect(settleNativeRunUsage(ctx, {
      ...initial,
      commandId: newCommandId,
      expectedVersion: 4,
    })).resolves.toEqual({ outcome: "settled" });
    expect(getOrchestration).toHaveBeenCalledTimes(2);
    expect(vi.mocked(settleAdmission).mock.calls[2][1]).toMatchObject({
      commandId: newCommandId,
      reservationId,
      usage: { status: "known", units: 990 },
    });
  });

  it("replays an older settlement from its receipt after a newer settlement changes the reservation", async () => {
    const newerCommandId = "70000000-0000-4000-8000-000000000007";
    const envelope = settledEnvelope() as ReturnType<typeof settledEnvelope>;
    envelope.reservations[0].usage = {
      status: "known",
      source: `paperclip:issues.summaries.getOrchestration:terminal-token-ledger;run=${runId};issue-baseline=40;monetary-cost=unpriced`,
      units: 990,
    };
    envelope.reservations[0].settlementReceipts.push({
      commandId: newerCommandId,
      command: "settle",
      payloadHash: "b".repeat(64),
      appliedVersion: 5,
      recordedAt: "2026-10-01T10:03:00.000Z",
      settlement: {
        usage: envelope.reservations[0].usage,
        remainingExposure: envelope.reservations[0].remainingExposure,
      },
    });
    vi.mocked(readAdmission).mockResolvedValue(envelope as never);
    vi.mocked(settleAdmission).mockResolvedValue({ outcome: "replayed" } as never);
    const getOrchestration = vi.fn(async () => summary({
      costs: { costCents: 0, inputTokens: 10_000, cachedInputTokens: 2_000, outputTokens: 30, billingCode: null },
    }));
    const ctx = {
      config: { get: vi.fn(async () => ({})) },
      issues: { summaries: { getOrchestration } },
    } as never;

    await expect(settleNativeRunUsage(ctx, {
      commandId: settlementCommandId,
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 40,
      periodKey: "n1-qualified-2026-10-01",
      reservationId,
      expectedVersion: 5,
    })).resolves.toEqual({ outcome: "replayed" });

    expect(getOrchestration).not.toHaveBeenCalled();
    expect(settleAdmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      commandId: settlementCommandId,
      usage: expect.objectContaining({ status: "known", units: 90 }),
    }));
  });

  it("rejects replay when the recorded native run or baseline binding differs", async () => {
    vi.mocked(readAdmission).mockResolvedValue(settledEnvelope() as never);
    const ctx = context({}, summary({
      costs: { costCents: 0, inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 30, billingCode: null },
    }));
    const base = {
      commandId: settlementCommandId,
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 40,
      periodKey: "n1-qualified-2026-10-01",
      reservationId,
      expectedVersion: 3,
    };

    await expect(settleNativeRunUsage(ctx, { ...base, runId: "80000000-0000-4000-8000-000000000008" }))
      .rejects.toMatchObject({ status: 409, code: "command_identity_conflict" });
    await expect(settleNativeRunUsage(ctx, { ...base, baselineUsageUnits: 41 }))
      .rejects.toMatchObject({ status: 409, code: "command_identity_conflict" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("does not turn a terminal zero-total summary into zero consumption", async () => {
    await expect(settleNativeRunUsage(context({}, summary({
      costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billingCode: null },
    })), {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 0,
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "g4_usage_unavailable" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("fails closed when cumulative issue usage does not exceed the pre-wakeup baseline", async () => {
    await expect(settleNativeRunUsage(context({}, summary()), {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      runId,
      baselineUsageUnits: 150,
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "g4_usage_unavailable" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("settles one sequential run from a persisted aggregate-token baseline", async () => {
    vi.mocked(settleAdmission).mockResolvedValue({ outcome: "settled" } as never);
    const priorRun = { ...summary().runs[0], id: "30000000-0000-4000-8000-000000000004" };
    await expect(settleNativeSequentialRunUsage(context({}, summary({
      runs: [priorRun, summary().runs[0]],
      costs: { costCents: 0, inputTokens: 180, cachedInputTokens: 40, outputTokens: 50, billingCode: null },
    })), {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      expectedRunId: runId,
      baseline: { runIds: [priorRun.id], tokenTotal: 150 },
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).resolves.toEqual({ outcome: "settled" });
    expect(settleAdmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      commandId: "50000000-0000-4000-8000-000000000005",
      usage: expect.objectContaining({ status: "known", units: 80, source: expect.stringContaining(`sequential-run=${runId}`) }),
    }));
  });

  it("captures a sorted native run and aggregate-token checkpoint", async () => {
    const priorRun = { ...summary().runs[0], id: "30000000-0000-4000-8000-000000000004" };
    await expect(readNativeSequentialUsageBaseline(context({}, summary({
      runs: [summary().runs[0], priorRun],
      costs: { costCents: 0, inputTokens: 180, cachedInputTokens: 40, outputTokens: 50, billingCode: null },
    })), { companyId, issueId })).resolves.toEqual({
      runIds: [runId, priorRun.id],
      tokenTotal: 230,
    });
  });

  it("refuses an extra run or a non-positive sequential token delta", async () => {
    const priorRun = { ...summary().runs[0], id: "30000000-0000-4000-8000-000000000004" };
    const extraRun = { ...summary().runs[0], id: "30000000-0000-4000-8000-000000000005" };
    const input = {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      expectedRunId: runId,
      baseline: { runIds: [priorRun.id], tokenTotal: 150 },
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    };
    await expect(settleNativeSequentialRunUsage(context({}, summary({
      runs: [priorRun, summary().runs[0], extraRun],
    })), input)).rejects.toMatchObject({ code: "g4_run_identity_unqualified" });
    await expect(settleNativeSequentialRunUsage(context({}, summary({
      runs: [priorRun, summary().runs[0]],
      costs: { costCents: 0, inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, billingCode: null },
    })), input)).rejects.toMatchObject({ code: "g4_usage_unavailable" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });
});
