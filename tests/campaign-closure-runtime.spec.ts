import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { MissionError, type MissionRecord } from "../src/missions.js";
import { assertLinearContinuityDeparture } from "../src/linear-continuity-control.js";
import { assertProjectDeparture } from "../src/project-mandate-guard.js";
import { reconcileCampaignClosure } from "../src/campaign-closure-runtime.js";
import { readLinearProof } from "../src/linear-continuity-documents.js";

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

function mission(phase: "reviewed" | "closing") {
  const rootIssueId = randomUUID(), childIssueId = randomUUID();
  const value = { companyId: randomUUID(), projectId: randomUUID(), missionId: randomUUID(), rootIssueId,
    ownerUserId: randomUUID(), version: 4, aggregate: {
      hierarchy: { nodes: [
        { issueId: childIssueId, parentId: rootIssueId, assigneeAgentId: null, blockedByIssueIds: [] },
        { issueId: rootIssueId, parentId: null, assigneeAgentId: null, blockedByIssueIds: [] },
      ] },
      linearContinuity: { mode: "milestone-fixed-v1", control: "running", publications: [] },
      campaignClosure: { protocol: "council-linear-campaign-closure-v1", phase,
        subject: {}, task: { agentId: randomUUID(), reservationId: randomUUID() },
        proofDocument: { key: "closure-proof", body: "{}", revisionId: randomUUID() },
        nativeClosures: [{ issueId: childIssueId, state: "confirmed" }, { issueId: rootIssueId, state: "pending" }],
        ...(phase === "reviewed" ? { report: { rows: [] }, reportSha256: "a".repeat(64) } : {}),
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
    update: f.updates, relations: { get: async () => ({ blockedBy: [] }) },
    documents: { get: async () => ({ latestRevisionId: randomUUID(), body: "{}" }), upsert: f.upserts },
  } } as any;
}

beforeEach(() => {
  vi.resetAllMocks(); f.mission = null;
  f.cas.mockImplementation(async (_ctx, before: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
    f.mission = { ...before, version: before.version + 1, aggregate }; return f.mission;
  });
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
