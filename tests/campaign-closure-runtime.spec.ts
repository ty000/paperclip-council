import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { MissionError, type MissionRecord } from "../src/missions.js";
import { assertLinearContinuityDeparture } from "../src/linear-continuity-control.js";
import { assertProjectDeparture } from "../src/project-mandate-guard.js";
import { reconcileCampaignClosure } from "../src/campaign-closure-runtime.js";
import { readLinearProof } from "../src/linear-continuity-documents.js";
import { campaignTerminalStatusUpdates, currentCampaignClosureSubject } from "../src/campaign-closure-subject.js";

const f = vi.hoisted(() => ({ mission: null as MissionRecord | null, updates: vi.fn(), upserts: vi.fn(), cas: vi.fn() }));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(),
  getMission: async () => f.mission,
}));
vi.mock("../src/n2-missions.js", async original => ({ ...await original<any>(),
  n2Cas: (...args: unknown[]) => f.cas(...args),
}));
vi.mock("../src/project-mandate-guard.js", async original => ({ ...await original<any>(),
  assertProjectDeparture: vi.fn(async () => undefined),
}));
vi.mock("../src/linear-continuity-control.js", async original => ({ ...await original<any>(),
  assertLinearContinuityDeparture: vi.fn(async () => undefined),
}));
vi.mock("../src/linear-continuity-documents.js", async original => ({ ...await original<any>(),
  readLinearProof: vi.fn(),
}));
vi.mock("../src/campaign-closure-subject.js", async original => ({ ...await original<any>(),
  currentCampaignClosureSubject: vi.fn(), campaignTerminalStatusUpdates: vi.fn(),
}));

function mission(phase: "reviewed" | "closing") {
  const rootIssueId = randomUUID(), childIssueId = randomUUID();
  const value = { companyId: randomUUID(), projectId: randomUUID(), missionId: randomUUID(), rootIssueId,
    ownerUserId: randomUUID(), version: 4, aggregate: {
      hierarchy: { nodes: [
        { issueId: childIssueId, parentId: rootIssueId, assigneeAgentId: null, blockedByIssueIds: [] },
        { issueId: rootIssueId, parentId: null, assigneeAgentId: null, blockedByIssueIds: [] },
      ] },
      linearContinuity: { protocol: "council-linear-continuity-v1", mode: "milestone-fixed-v1", control: "running", publications: [] },
      campaignClosure: { protocol: "council-linear-campaign-closure-v1", phase,
        subject: { coverage: [], results: [] }, task: { taskId: randomUUID(), agentId: randomUUID(),
          issueId: randomUUID(), runId: randomUUID(), reservationId: randomUUID(), settlementCommandId: randomUUID(),
          creation: "confirmed", wake: "claimed", settledAt: new Date().toISOString() },
        proofDocument: { key: "closure-proof", body: "{}", revisionId: randomUUID() },
        nativeClosures: [{ issueId: childIssueId, state: "confirmed" }, { issueId: rootIssueId, state: "pending" }],
        ...(phase === "reviewed" ? { report: { verdict: "approved", rows: [] }, reportSha256: "a".repeat(64) } : {}),
      },
    } } as unknown as MissionRecord;
  f.mission = value;
  return { value, rootIssueId, childIssueId };
}

function context(rootIssueId: string, childIssueId: string) {
  return { issues: {
    get: async (issueId: string) => ({ id: issueId, companyId: f.mission!.companyId, projectId: f.mission!.projectId,
      parentId: issueId === rootIssueId ? null : rootIssueId, assigneeAgentId: null,
      status: issueId === rootIssueId ? "blocked" : "done", checkoutRunId: null, executionRunId: null }),
    update: f.updates, requestWakeup: vi.fn(), create: vi.fn(), relations: { get: async () => ({ blockedBy: [] }) },
    documents: { get: async () => ({ latestRevisionId: randomUUID(), body: "{}" }), upsert: f.upserts },
  } } as any;
}

beforeEach(() => {
  vi.resetAllMocks(); f.mission = null;
  f.cas.mockImplementation(async (_ctx, before: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
    f.mission = { ...before, version: before.version + 1, aggregate }; return f.mission;
  });
});

function pendingProgress(value: MissionRecord) {
  const publication = { intentId: randomUUID(), payloadSha256: "b".repeat(64), kind: "progress",
    payload: { observation: { state: "waiting", code: "campaign_global_review_pending" } } } as any;
  value.aggregate.linearContinuity!.publications.push(publication);
  return publication;
}

it("waits for the prior progress ACK before publishing the approved result and retains every review identity", async () => {
  const { value, rootIssueId, childIssueId } = mission("reviewed"), ctx = context(rootIssueId, childIssueId);
  const progress = pendingProgress(value), before = structuredClone(value);
  vi.mocked(assertProjectDeparture).mockImplementation(async (_ctx, m) => {
    if (m.aggregate.linearContinuity!.publications.some(item => !item.acknowledgement)) {
      throw new MissionError(409, "linear_continuity_hold", "Earlier publication readback pending");
    }
  });
  vi.mocked(currentCampaignClosureSubject).mockResolvedValue(value.aggregate.campaignClosure!.subject);
  vi.mocked(campaignTerminalStatusUpdates).mockResolvedValue([{ sourceId: "root-source", state: "completed" }]);

  await expect(reconcileCampaignClosure(ctx, value)).resolves.toEqual(before);
  await expect(reconcileCampaignClosure(ctx, value)).resolves.toEqual(before);
  expect(f.cas).not.toHaveBeenCalled(); expect(f.upserts).not.toHaveBeenCalled();
  expect(f.updates).not.toHaveBeenCalled(); expect(ctx.issues.create).not.toHaveBeenCalled();
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(assertProjectDeparture).not.toHaveBeenCalled();

  progress.acknowledgement = { reference: {}, confirmedAt: new Date().toISOString() };
  const published = await reconcileCampaignClosure(ctx, value);
  expect(published.aggregate.campaignClosure).toMatchObject({ phase: "publishing", task: before.aggregate.campaignClosure!.task,
    report: before.aggregate.campaignClosure!.report, reportSha256: before.aggregate.campaignClosure!.reportSha256 });
  expect(assertProjectDeparture).toHaveBeenCalledTimes(2);
  expect(currentCampaignClosureSubject).toHaveBeenCalledTimes(1);
  const publications = structuredClone(published.aggregate.linearContinuity!.publications);
  expect(publications).toHaveLength(2); expect(publications[0]!.intentId).toBe(progress.intentId);
  expect(publications[1]!).toMatchObject({ intentId: published.aggregate.campaignClosure!.publicationIntentId, kind: "closure" });
  await reconcileCampaignClosure(ctx, published);
  expect(f.mission!.aggregate.linearContinuity!.publications).toEqual(publications);
  expect(f.mission!.aggregate.campaignClosure!.task).toEqual(before.aggregate.campaignClosure!.task);
  expect(f.cas).toHaveBeenCalledTimes(1);
  expect(f.updates).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it.each(["project_authority_changed", "linear_continuity_hold"])("rechecks %s after the preceding publication is acknowledged", async code => {
  const { value, rootIssueId, childIssueId } = mission("reviewed"), ctx = context(rootIssueId, childIssueId);
  const progress = pendingProgress(value);
  vi.mocked(assertProjectDeparture).mockRejectedValue(new MissionError(409, code, "Current departure is no longer authorized"));
  await expect(reconcileCampaignClosure(ctx, value)).resolves.toBe(value);
  progress.acknowledgement = { reference: {}, confirmedAt: new Date().toISOString() };
  await expect(reconcileCampaignClosure(ctx, value)).rejects.toMatchObject({ code });
  expect(f.cas).not.toHaveBeenCalled(); expect(f.upserts).not.toHaveBeenCalled();
  expect(f.updates).not.toHaveBeenCalled(); expect(value.aggregate.campaignClosure!.phase).toBe("reviewed");
});

it("already waits for earlier publications before claiming the initial global review", async () => {
  const { value, rootIssueId, childIssueId } = mission("reviewed"), ctx = context(rootIssueId, childIssueId);
  delete value.aggregate.campaignClosure; pendingProgress(value);
  await expect(reconcileCampaignClosure(ctx, value)).resolves.toBe(value);
  expect(f.cas).not.toHaveBeenCalled(); expect(ctx.issues.create).not.toHaveBeenCalled();
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it("refuses a terminal publication claim when project authority was revoked after review", async () => {
  const { value, rootIssueId, childIssueId } = mission("reviewed");
  vi.mocked(assertProjectDeparture).mockRejectedValueOnce(new MissionError(409, "project_authority_changed", "revoked"));
  await expect(reconcileCampaignClosure(context(rootIssueId, childIssueId), value))
    .rejects.toMatchObject({ code: "project_authority_changed" });
  expect(f.upserts).not.toHaveBeenCalled();
  expect(f.cas).not.toHaveBeenCalled();
});

it("does not close the next native parent when Linear becomes unavailable after an earlier parent was confirmed", async () => {
  const { value, rootIssueId, childIssueId } = mission("closing");
  vi.mocked(assertLinearContinuityDeparture).mockRejectedValueOnce(new MissionError(409, "linear_continuity_hold", "unavailable"));
  await expect(reconcileCampaignClosure(context(rootIssueId, childIssueId), value))
    .rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.updates).not.toHaveBeenCalled();
  expect(f.mission!.aggregate.campaignClosure!.nativeClosures).toEqual(value.aggregate.campaignClosure!.nativeClosures);
});

it("keeps the acknowledged terminal intent in publishing when its source is no longer available", async () => {
  const { value, rootIssueId, childIssueId } = mission("closing");
  const state = value.aggregate.campaignClosure!, intentId = randomUUID(), sourceId = randomUUID(), payloadSha256 = "a".repeat(64);
  Object.assign(state, { phase: "publishing", publicationIntentId: intentId, publicationPayloadSha256: payloadSha256 });
  Object.assign(value.aggregate.linearContinuity!, { binding: { sourceRootId: sourceId }, publications: [{ intentId, payloadSha256,
    payload: { statusUpdates: [{ sourceId, state: "completed" }] }, acknowledgement: { reference: {}, confirmedAt: new Date().toISOString() } }] });
  vi.mocked(readLinearProof).mockResolvedValue({ body: JSON.stringify({ effects: [
    { sourceId, kind: "comment", readbackSha256: payloadSha256 }, { sourceId, kind: "status", readbackSha256: payloadSha256 },
  ] }) } as never);
  vi.mocked(assertLinearContinuityDeparture).mockRejectedValueOnce(new MissionError(409, "linear_continuity_hold", "unavailable"));
  await expect(reconcileCampaignClosure(context(rootIssueId, childIssueId), value)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.cas).not.toHaveBeenCalled(); expect(f.updates).not.toHaveBeenCalled();
  expect(state).toMatchObject({ phase: "publishing", publicationIntentId: intentId });
});
