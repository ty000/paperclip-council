import { randomUUID } from "node:crypto";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdmissionError } from "../src/admission.js";

const mocks = vi.hoisted(() => ({
  getMissionByRootIssue: vi.fn(),
  getMissionByOrdinaryIssue: vi.fn(),
  reconcileOrdinaryN2: vi.fn(),
  findPreparedN2Decision: vi.fn(),
  settlePreparedN2ReviewUsage: vi.fn(),
  recordN2Decision: vi.fn(),
  executeCouncilDecision: vi.fn(),
}));

vi.mock("../src/missions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/missions.js")>(),
  getMissionByRootIssue: mocks.getMissionByRootIssue,
  getMissionByOrdinaryIssue: mocks.getMissionByOrdinaryIssue,
}));
vi.mock("../src/n2-missions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/n2-missions.js")>(),
  findPreparedN2Decision: mocks.findPreparedN2Decision,
  settlePreparedN2ReviewUsage: mocks.settlePreparedN2ReviewUsage,
  recordN2Decision: mocks.recordN2Decision,
}));
vi.mock("../src/decision-receipts.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/decision-receipts.js")>(),
  executeCouncilDecision: mocks.executeCouncilDecision,
}));

vi.mock("../src/n2-ordinary-runtime.js", () => ({ reconcileOrdinaryN2: mocks.reconcileOrdinaryN2 }));

import { handleN2RunFinished } from "../src/n2-finished-event.js";

const ids = {
  company: randomUUID(), issue: randomUUID(), mission: randomUUID(), reviewer: randomUUID(), run: randomUUID(),
  operation: randomUUID(), submission: randomUUID(), settlement: randomUUID(), event: randomUUID(),
};

const prepared = {
  operationId: ids.operation,
  verdict: "changes_requested" as const,
  actorAgentId: ids.reviewer,
  runId: ids.run,
  resultReference: `council:n2:submission:${ids.submission}`,
  justification: "Apply the exact requested correction.",
  submissionId: ids.submission,
  decisionHash: "a".repeat(64),
  settlementCommandId: ids.settlement,
};

const mission = {
  companyId: ids.company,
  missionId: ids.mission,
  rootIssueId: ids.issue,
  aggregate: { n2: {} },
};

function event(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventId: ids.event,
    eventType: "agent.run.finished",
    occurredAt: new Date().toISOString(),
    actorId: ids.reviewer,
    actorType: "agent",
    entityId: ids.run,
    entityType: "heartbeat_run",
    companyId: ids.company,
    payload: { runId: ids.run, agentId: ids.reviewer, issueId: ids.issue, status: "succeeded", ...overrides },
  };
}

describe("N2 finished-run decision application", () => {
  let ctx: PluginContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = {
      config: { get: vi.fn(async () => ({
        apiBaseUrl: "http://127.0.0.1:3100",
        councilAgentId: ids.reviewer,
        councilApiKey: { type: "secret_ref", secretId: "council-key" },
      })) },
    } as unknown as PluginContext;
    mocks.getMissionByRootIssue.mockResolvedValue(mission);
    mocks.findPreparedN2Decision.mockReturnValue(prepared);
    mocks.settlePreparedN2ReviewUsage.mockResolvedValue(mission);
    mocks.executeCouncilDecision.mockResolvedValue({
      replayed: false,
      receipt: { state: "native_observed", operationId: ids.operation },
    });
    mocks.recordN2Decision.mockResolvedValue(mission);
  });

  it("waits for authoritative cost, settles, then applies the exact immutable decision once", async () => {
    const order: string[] = [];
    mocks.settlePreparedN2ReviewUsage
      .mockImplementationOnce(async () => {
        order.push("usage-unavailable");
        throw new AdmissionError(409, "g4_usage_unavailable", "cost event not visible yet");
      })
      .mockImplementationOnce(async () => {
        order.push("settled");
        return mission;
      });
    mocks.executeCouncilDecision.mockImplementationOnce(async (_ctx, _config, decision) => {
      order.push("applied");
      expect(decision).toMatchObject({
        companyId: ids.company,
        issueId: ids.issue,
        actorAgentId: ids.reviewer,
        runId: ids.run,
        operationId: ids.operation,
        verdict: "changes_requested",
        resultReference: prepared.resultReference,
      });
      return { replayed: false, receipt: { state: "native_observed", operationId: ids.operation } };
    });

    const result = await handleN2RunFinished(ctx, event(), {
      attempts: 2,
      delayMs: 0,
      wait: async () => {
        expect(mocks.executeCouncilDecision).not.toHaveBeenCalled();
      },
    });

    expect(result).toEqual({ outcome: "applied", operationId: ids.operation, replayed: false });
    expect(order).toEqual(["usage-unavailable", "settled", "applied"]);
    expect(mocks.recordN2Decision).toHaveBeenCalledTimes(1);

    mocks.findPreparedN2Decision.mockReturnValue(null);
    expect(await handleN2RunFinished(ctx, event())).toEqual({
      outcome: "ignored", reason: "prepared_decision_unavailable",
    });
    expect(mocks.executeCouncilDecision).toHaveBeenCalledTimes(1);
  });

  it("keeps the prepared decision blocked when usage stays unknown", async () => {
    mocks.settlePreparedN2ReviewUsage.mockRejectedValue(
      new AdmissionError(409, "g4_usage_unavailable", "cost event not visible"),
    );
    const result = await handleN2RunFinished(ctx, event(), { attempts: 2, delayMs: 0, wait: async () => {} });
    expect(result).toEqual({ outcome: "prepared", reason: "usage_not_ready", attempts: 2 });
    expect(mocks.executeCouncilDecision).not.toHaveBeenCalled();
    expect(mocks.recordN2Decision).not.toHaveBeenCalled();
  });

  it("does not turn a concurrent indeterminate receipt replay into application unknown", async () => {
    let releaseClaim!: () => void;
    let claimStarted!: () => void;
    const started = new Promise<void>((resolve) => { claimStarted = resolve; });
    const released = new Promise<void>((resolve) => { releaseClaim = resolve; });
    mocks.executeCouncilDecision
      .mockImplementationOnce(async () => {
        claimStarted();
        await released;
        return { replayed: false, receipt: { state: "native_observed", operationId: ids.operation } };
      })
      .mockResolvedValueOnce({
        replayed: true,
        receipt: { state: "indeterminate", operationId: ids.operation },
      });

    const claimant = handleN2RunFinished(ctx, event());
    await started;
    const duplicate = await handleN2RunFinished(ctx, { ...event(), eventId: randomUUID() });
    expect(duplicate).toEqual({ outcome: "prepared", reason: "receipt_pending", operationId: ids.operation });
    expect(mocks.recordN2Decision).not.toHaveBeenCalled();

    releaseClaim();
    await expect(claimant).resolves.toEqual({ outcome: "applied", operationId: ids.operation, replayed: false });
    expect(mocks.executeCouncilDecision).toHaveBeenCalledTimes(2);
    expect(mocks.recordN2Decision).toHaveBeenCalledTimes(1);
  });

  it("ignores wrong or stale run identities before settlement", async () => {
    const wrong = event({ runId: randomUUID() });
    expect(await handleN2RunFinished(ctx, wrong)).toEqual({ outcome: "ignored", reason: "event_identity_unqualified" });
    mocks.findPreparedN2Decision.mockReturnValue(null);
    expect(await handleN2RunFinished(ctx, event())).toEqual({ outcome: "ignored", reason: "prepared_decision_unavailable" });
    expect(mocks.settlePreparedN2ReviewUsage).not.toHaveBeenCalled();
    expect(mocks.executeCouncilDecision).not.toHaveBeenCalled();
  });
});


it("routes a parentless ordinary stage by exact stored issue/run/actor before legacy fallback", async () => {
  vi.clearAllMocks();
  const ordinary = { ...mission, aggregate: { n2: { ordinary: { tasks: [{ issueId: ids.issue, runId: ids.run, agentId: ids.reviewer }] } } } };
  mocks.getMissionByOrdinaryIssue.mockResolvedValue(ordinary);
  mocks.reconcileOrdinaryN2.mockResolvedValue(ordinary);
  const result = await handleN2RunFinished({} as PluginContext, event());
  expect(result.outcome).toBe("reconciled");
  expect(mocks.reconcileOrdinaryN2).toHaveBeenCalledOnce();
  expect(mocks.getMissionByRootIssue).not.toHaveBeenCalled();
  ordinary.aggregate.n2.ordinary.tasks[0]!.runId = randomUUID();
  expect(await handleN2RunFinished({} as PluginContext, event())).toMatchObject({ outcome: "ignored", reason: "ordinary_task_unbound" });
  expect(mocks.reconcileOrdinaryN2).toHaveBeenCalledOnce();
});
