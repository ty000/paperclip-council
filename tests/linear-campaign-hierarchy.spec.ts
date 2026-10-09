import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { assertHierarchySources } from "../src/hierarchy-runtime.js";
import { LINEAR_ORIGIN, LINEAR_READINESS_KEY, LINEAR_SOURCE_KEY } from "../src/linear-intake-contract.js";

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), ownerUserId = randomUUID();
  const rootIssueId = randomUUID(), rootMissionId = randomUUID(), leafIssueId = randomUUID();
  const readiness = { id: randomUUID(), latestRevisionId: randomUUID(), body: JSON.stringify({ nativeRootId: rootIssueId, scope: "original milestone" }) };
  const snapshot = { subject: { nativeRootId: rootIssueId, readinessDocumentId: readiness.id,
    readinessRevisionId: readiness.latestRevisionId, readinessSha256: canonicalPayloadHash("original receipt") },
    bodySha256: canonicalPayloadHash(JSON.parse(readiness.body)) };
  const root = { company_id: companyId, project_id: projectId, mission_id: rootMissionId, root_issue_id: rootIssueId,
    owner_user_id: ownerUserId, version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    aggregate: { schemaVersion: 1, commandReceipts: [], projectMandate: { linearIntake: structuredClone(snapshot) },
      linearContinuity: { mode: "milestone-fixed-v1", binding: { campaignId: rootMissionId } } } };
  const issue = { id: leafIssueId, companyId, projectId, parentId: rootIssueId, title: "Delivery A", description: "Retained work",
    assigneeAgentId: null, originKind: LINEAR_ORIGIN, originId: `linear:${randomUUID()}` };
  const source = { latestRevisionId: randomUUID(), body: JSON.stringify({ source: "original leaf" }) };
  const node = { issueId: leafIssueId, parentId: rootIssueId, title: issue.title, assigneeAgentId: null,
    descriptionHash: canonicalPayloadHash(issue.description), blockedByIssueIds: [], linearSource: { originId: issue.originId,
      documentRevisionId: source.latestRevisionId, bodySha256: canonicalPayloadHash(source.body) } };
  const member = { companyId, projectId, ownerUserId, missionId: randomUUID(), rootIssueId: leafIssueId,
    aggregate: { repositoryCampaign: { campaignRootMissionId: rootMissionId }, projectMandate: { linearIntake: structuredClone(snapshot) },
      hierarchy: { nodes: [node] } } } as unknown as MissionRecord;
  const docs = new Map<string, unknown>([[`${rootIssueId}:${LINEAR_READINESS_KEY}`, readiness], [`${leafIssueId}:${LINEAR_SOURCE_KEY}`, source]]);
  const getDocument = vi.fn(async (id: string, key: string) => structuredClone(docs.get(`${id}:${key}`) ?? null));
  const upsert = vi.fn();
  const ctx = { db: { namespace: "council_test", query: vi.fn(async (_sql: string, params: string[]) =>
    params[0] === root.company_id && params[1] === root.mission_id ? [structuredClone(root)] : []) },
    issues: { list: async () => [issue], get: async (id: string) => id === leafIssueId ? structuredClone(issue) : null,
      relations: { get: async () => ({ blockedBy: [] }) }, documents: { get: getDocument, upsert } } } as any;
  return { ctx, member, root, rootIssueId, leafIssueId, docs, readiness, source, getDocument, upsert };
}

it("validates a delivery leaf against its trusted campaign readiness and its own source document", async () => {
  const f = fixture();
  await expect(assertHierarchySources(f.ctx, f.member)).resolves.toBeUndefined();
  expect(f.getDocument).toHaveBeenCalledWith(f.rootIssueId, LINEAR_READINESS_KEY, f.member.companyId);
  expect(f.getDocument).toHaveBeenCalledWith(f.leafIssueId, LINEAR_SOURCE_KEY, f.member.companyId);
  expect(f.getDocument).not.toHaveBeenCalledWith(f.leafIssueId, LINEAR_READINESS_KEY, f.member.companyId);
  expect(f.upsert).not.toHaveBeenCalled();
});

it.each(["id", "revision", "body", "subject", "parent snapshot"])("rejects %s drift without copying readiness to the leaf", async drift => {
  const f = fixture();
  if (drift === "id") f.readiness.id = randomUUID();
  if (drift === "revision") f.readiness.latestRevisionId = randomUUID();
  if (drift === "body") f.readiness.body = JSON.stringify({ nativeRootId: f.rootIssueId, scope: "different milestone" });
  if (drift === "subject") f.member.aggregate.projectMandate!.linearIntake!.subject.nativeRootId = f.leafIssueId;
  if (drift === "parent snapshot") f.root.aggregate.projectMandate.linearIntake.subject.readinessSha256 = canonicalPayloadHash("different receipt");
  await expect(assertHierarchySources(f.ctx, f.member)).rejects.toMatchObject({ code: "linear_readiness_changed" });
  expect(f.upsert).not.toHaveBeenCalled();
});

it("rejects a foreign parent before reading readiness even if its source snapshot is identical", async () => {
  const f = fixture(); f.root.project_id = randomUUID();
  await expect(assertHierarchySources(f.ctx, f.member)).rejects.toMatchObject({ code: "repository_campaign_binding" });
  expect(f.getDocument).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
});

it("does not accept a copied leaf document when the original root readiness is missing", async () => {
  const f = fixture();
  f.docs.delete(`${f.rootIssueId}:${LINEAR_READINESS_KEY}`);
  f.docs.set(`${f.leafIssueId}:${LINEAR_READINESS_KEY}`, f.readiness);
  await expect(assertHierarchySources(f.ctx, f.member)).rejects.toMatchObject({ code: "linear_readiness_changed" });
  expect(f.upsert).not.toHaveBeenCalled();
});
