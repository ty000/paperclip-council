import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "../src/missions.js";
import { assertLinearContinuityDeparture } from "../src/linear-continuity-control.js";
import { assertProjectDeparture } from "../src/project-mandate-guard.js";
import { reconcileCampaignClosure } from "../src/campaign-closure-runtime.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { readLinearProof } from "../src/linear-continuity-documents.js";
import { campaignTerminalStatusUpdates, currentCampaignClosureSubject } from "../src/campaign-closure-subject.js";

const f = vi.hoisted(() => ({ mission: null as MissionRecord | null, updates: vi.fn(), upserts: vi.fn(), cas: vi.fn() }));
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: vi.fn(async () => undefined) }));
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
    documents: { get: async () => ({ latestRevisionId: f.mission!.aggregate.campaignClosure!.proofDocument.revisionId, body: "{}" }), upsert: f.upserts },
  } } as any;
}

beforeEach(() => {
  vi.resetAllMocks(); f.mission = null;
  vi.mocked(assertProjectDeparture).mockImplementation(async (ctx, m) => assertLinearContinuityDeparture(ctx, m));
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


it.each(["owner", "project", "revision", "config"])("blocks new native and aggregate closure after acknowledged publication when %s authority changes", async drift => {
  const actual = await vi.importActual<typeof import("../src/project-mandate-guard.js")>("../src/project-mandate-guard.js");
  vi.mocked(assertProjectDeparture).mockImplementation(actual.assertProjectDeparture);
  for (const finalOnly of [false, true]) {
    const { value, rootIssueId, childIssueId } = mission("closing"), ctx = context(rootIssueId, childIssueId);
    const config = { n2RuntimeProfile: "ordinary-cli-v1", n1OperatingProfile: { periodKey: "original" } };
    const mandate = { objective: "Pinned campaign" };
    Object.assign(value.aggregate, { mandate, projectMandate: { revisionId: "original", authorizedBy: value.ownerUserId,
      mandateHash: canonicalPayloadHash(mandate), operatingProfileHash: operatingProfileHash(config) } });
    const row = { company_id: value.companyId, project_id: value.projectId, version: 1, revision_id: "original",
      authorized_by: value.ownerUserId, content: { enabled: true } };
    ctx.db = { namespace: "council", query: async () => [row] };
    ctx.config = { get: async () => config };
    ctx.companies = { get: async () => ({ defaultResponsibleUserId: drift === "owner" ? "replacement" : value.ownerUserId }) };
    if (drift === "project") row.content.enabled = false;
    if (drift === "revision") row.revision_id = "replacement";
    if (drift === "config") config.n1OperatingProfile.periodKey = "replacement";
    value.aggregate.campaignClosure!.publicationAcknowledgedAt = new Date().toISOString();
    if (finalOnly) value.aggregate.campaignClosure!.nativeClosures.forEach(entry => { entry.state = "confirmed"; });
    const before = structuredClone(value);
    await expect(reconcileCampaignClosure(ctx, value)).rejects.toMatchObject({ code: "project_authority_changed" });
    expect(f.mission).toEqual(before); expect(f.updates).not.toHaveBeenCalled(); expect(f.cas).not.toHaveBeenCalled();
    expect(f.upserts).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  }
});

it.each(["missing", "revision", "body"])("retains the acknowledged closure when its pinned proof has %s drift", async drift => {
  for (const finalOnly of [false, true]) {
    const { value, rootIssueId, childIssueId } = mission("closing"), ctx = context(rootIssueId, childIssueId);
    if (finalOnly) value.aggregate.campaignClosure!.nativeClosures.forEach(entry => { entry.state = "confirmed"; });
    ctx.issues.documents.get = vi.fn(async () => drift === "missing" ? null : {
      latestRevisionId: drift === "revision" ? "new-revision" : value.aggregate.campaignClosure!.proofDocument.revisionId,
      body: drift === "body" ? "changed" : "{}",
    });
    const before = structuredClone(value);
    await expect(reconcileCampaignClosure(ctx, value)).rejects.toMatchObject({ code: "campaign_close_proof_unknown" });
    expect(f.mission).toEqual(before); expect(f.cas).not.toHaveBeenCalled(); expect(f.updates).not.toHaveBeenCalled();
    expect(f.upserts).not.toHaveBeenCalled();
  }
});

it("refuses to publish a rewritten same-body global proof under its old revision", async () => {
  const { value, rootIssueId, childIssueId } = mission("reviewed"), ctx = context(rootIssueId, childIssueId);
  ctx.issues.documents.get = async () => ({ latestRevisionId: "replacement", body: "{}" });
  await expect(reconcileCampaignClosure(ctx, value)).rejects.toMatchObject({ code: "campaign_close_proof_unknown" });
  expect(f.cas).not.toHaveBeenCalled(); expect(f.upserts).not.toHaveBeenCalled(); expect(f.updates).not.toHaveBeenCalled();
});

it("reconciles a claimed Done without repeating it, then holds aggregate closure until authority returns", async () => {
  const { value, rootIssueId, childIssueId } = mission("closing"), ctx = context(rootIssueId, childIssueId);
  value.aggregate.campaignClosure!.nativeClosures.at(-1)!.state = "claimed";
  const get = ctx.issues.get;
  ctx.issues.get = async (id: string) => ({ ...await get(id), status: "done" });
  vi.mocked(assertProjectDeparture).mockRejectedValue(new MissionError(409, "project_authority_changed", "revoked"));
  await expect(reconcileCampaignClosure(ctx, value)).rejects.toMatchObject({ code: "project_authority_changed" });
  expect(f.mission!.aggregate.campaignClosure!.nativeClosures.every(entry => entry.state === "confirmed")).toBe(true);
  expect(f.mission!.aggregate.campaignClosure!.task).toEqual(value.aggregate.campaignClosure!.task);
  expect(f.mission!.aggregate.completion).toBeUndefined(); expect(f.updates).not.toHaveBeenCalled();
  vi.mocked(assertProjectDeparture).mockResolvedValue(undefined);
  const next = await reconcileCampaignClosure(ctx, f.mission!);
  expect(next.aggregate.completion?.state).toBe("closed");
  expect(f.updates).toHaveBeenCalledExactlyOnceWith(value.aggregate.campaignClosure!.task.issueId, { status: "done" }, value.companyId);
  const writes = f.cas.mock.calls.length;
  await reconcileCampaignClosure(ctx, next);
  expect(f.cas).toHaveBeenCalledTimes(writes); expect(f.updates).toHaveBeenCalledTimes(1);
  expect(f.upserts).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it("retains an uncertain claimed native closure without repeating its PATCH", async () => {
  const { value, rootIssueId, childIssueId } = mission("closing");
  value.aggregate.campaignClosure!.nativeClosures.at(-1)!.state = "claimed";
  const before = structuredClone(value);
  await expect(reconcileCampaignClosure(context(rootIssueId, childIssueId), value))
    .rejects.toMatchObject({ code: "campaign_close_native_unknown" });
  expect(f.mission).toEqual(before); expect(f.cas).not.toHaveBeenCalled(); expect(f.updates).not.toHaveBeenCalled();
  expect(assertProjectDeparture).not.toHaveBeenCalled();
});
