import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admission.js")>();
  return { ...actual, settleAdmission: vi.fn() };
});
import { settleAdmission } from "../src/admission.js";
import {
  assertNativeConfigurationRequest,
  assertNativeLaunchAllowed,
  nativeAdmissionConfiguration,
  readNativeG4Profile,
  settleNativeRunUsage,
} from "../src/g4-native.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const issueId = "20000000-0000-4000-8000-000000000002";
const runId = "30000000-0000-4000-8000-000000000003";

function profile() {
  return {
    kind: "paperclip-orchestration-tokens-v1",
    periodKey: "n1-qualified-2026-10-01",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-02T00:00:00.000Z",
    periodAllowanceUnits: 100_000,
    runReservationUnits: 20_000,
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

describe("native G4 profile", () => {
  beforeEach(() => vi.mocked(settleAdmission).mockReset());

  it("derives one fixed sequential token-ledger envelope from explicit plugin config", async () => {
    const parsed = await readNativeG4Profile(context({ n1OperatingProfile: profile() }), companyId);
    expect(parsed).toEqual(profile());
    const configuration = nativeAdmissionConfiguration(parsed!, companyId, "50000000-0000-4000-8000-000000000005");
    expect(configuration).toMatchObject({
      measurement: { status: "known", unit: "tokens" },
      allowance: { status: "known", periodUnits: 100_000, taskUnits: 20_000, knownUsageUnits: 0 },
      exposure: { status: "known", units: 0 },
      limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
    });
    expect(() => assertNativeConfigurationRequest(configuration, configuration)).not.toThrow();
    expect(() => assertNativeConfigurationRequest(
      { ...configuration, limits: { ...configuration.limits, maxConcurrent: 3 } },
      configuration,
    )).toThrow(/exactly match/);
  });

  it("honors host invocation and budget blocks before a native launch", async () => {
    await expect(assertNativeLaunchAllowed(context({}, summary({ runs: [] })), { companyId, issueId })).resolves.toBeUndefined();
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
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).resolves.toEqual({ outcome: "settled" });
    expect(settleAdmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      usage: expect.objectContaining({ status: "known", units: 150, source: expect.stringContaining("monetary-cost=unpriced") }),
      remainingExposure: expect.objectContaining({ status: "known", units: 0, source: expect.stringContaining("terminal=succeeded") }),
    }));
  });

  it("does not turn a terminal zero-total summary into zero consumption", async () => {
    await expect(settleNativeRunUsage(context({}, summary({
      costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billingCode: null },
    })), {
      commandId: "50000000-0000-4000-8000-000000000005",
      companyId,
      issueId,
      runId,
      periodKey: "n1-qualified-2026-10-01",
      reservationId: "60000000-0000-4000-8000-000000000006",
      expectedVersion: 3,
    })).rejects.toMatchObject({ code: "g4_usage_unavailable" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });
});
