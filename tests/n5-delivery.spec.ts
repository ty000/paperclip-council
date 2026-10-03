import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { correlateN5Readback } from "../src/n5-native.js";
import { startN5Publication } from "../src/n5-runtime.js";
import { inspectN5 } from "../src/n5-state.js";

function fixture() {
  const companyId = randomUUID(); const issueId = randomUUID(); const runId = randomUUID(); const intentId = randomUUID();
  const document = { id: randomUUID(), issueId, latestRevisionId: randomUUID(), body: JSON.stringify({ intentId, url: "https://github.com/ty000/paperclip-council/pull/23" }) };
  const mission = { companyId, aggregate: { n5: { plan: { integrationLeadAgentId: randomUUID() },
    authority: { repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/delivery", publisherAgentId: randomUUID() },
    publication: { intentId, issueId, runId, claimedAt: new Date(Date.now() - 1000).toISOString(), submission: { candidateCommit: "a".repeat(40) } } } } } as MissionRecord;
  const products = [{ id: randomUUID(), companyId, issueId, createdByRunId: runId, type: "pull_request", provider: "github", url: "https://github.com/ty000/paperclip-council/pull/23" }];
  const objects = [{ object: { id: randomUUID(), companyId, providerKey: "github", liveness: "fresh", lastResolvedAt: new Date().toISOString(),
    data: { owner: "ty000", repo: "paperclip-council", number: 23, headSha: "a".repeat(40), baseRef: "main", headRef: "codex/delivery", state: "open", draft: false } },
    mentions: [{ sourceIssueId: issueId, documentKey: "delivery", sourceRecordId: document.id }] }];
  return { mission, document, products, objects };
}
it("joins native document intent, exact publisher work product and GitHub head without inferring checks", () => {
  const f = fixture(); const observation = correlateN5Readback(f.mission, f.document, f.products, f.objects);
  expect(observation.matchesCandidate).toBe(true);
  f.mission.aggregate.n5!.publication!.observation = observation;
  expect(inspectN5(f.mission)?.ready).toBe(false);
});
it.each(["run", "document", "intent", "repository", "freshness", "missing-head", "old-snapshot"])("rejects invalid native %s binding", kind => {
  const f = fixture();
  if (kind === "run") f.products[0]!.createdByRunId = randomUUID();
  if (kind === "document") f.objects[0]!.mentions[0]!.sourceRecordId = randomUUID();
  if (kind === "intent") f.document.body = f.document.body.replace(f.mission.aggregate.n5!.publication!.intentId, randomUUID());
  if (kind === "repository") f.objects[0]!.object.data.repo = "other";
  if (kind === "freshness") f.objects[0]!.object.liveness = "stale";
  if (kind === "missing-head") f.objects[0]!.object.data.headSha = "";
  if (kind === "old-snapshot") f.objects[0]!.object.lastResolvedAt = new Date(Date.now() - 10_000).toISOString();
  expect(() => correlateN5Readback(f.mission, f.document, f.products, f.objects)).toThrow();
});
it("records divergent head as observed without mutating historical acceptance or allowing readiness", () => {
  const f = fixture(); f.objects[0]!.object.data.headSha = "b".repeat(40);
  const before = structuredClone(f.mission.aggregate.n5!.publication!.submission);
  const observation = correlateN5Readback(f.mission, f.document, f.products, f.objects);
  f.mission.aggregate.n5!.publication!.observation = observation;
  expect(observation.matchesCandidate).toBe(false); expect(inspectN5(f.mission)?.ready).toBe(false);
  expect(f.mission.aggregate.n5!.publication!.submission).toEqual(before);
});
it("requires nondraft open PR and exact attributed checks/reviews, expires native readiness", () => {
  const f = fixture(); const p = f.mission.aggregate.n5!.publication!;
  p.observation = correlateN5Readback(f.mission, f.document, f.products, f.objects);
  const attributed = { headSha: p.submission.candidateCommit, evidenceRefs: ["run:gh"], observedAt: new Date().toISOString(), agentId: randomUUID(), runId: randomUUID() };
  p.checks = { ...attributed, state: "passed" }; p.reviews = { ...attributed, state: "approved" };
  expect(inspectN5(f.mission)?.ready).toBe(true);
  p.observation.draft = true; expect(inspectN5(f.mission)?.ready).toBe(false);
  p.observation.draft = false; p.checks.state = "pending"; expect(inspectN5(f.mission)?.ready).toBe(false);
  p.checks.state = "passed"; p.observation.lastResolvedAt = new Date(Date.now() - 400_000).toISOString(); expect(inspectN5(f.mission)?.ready).toBe(false);
});
it("retains an ambiguous publication across reconciliation without emitting another native create", async () => {
  const f = fixture(); const create = vi.fn();
  expect(await startN5Publication({ issues: { create } } as never, f.mission)).toBe(f.mission);
  expect(create).not.toHaveBeenCalled();
});
it("does not infer authority or acceptance", async () => {
  const create = vi.fn(); const m = { aggregate: {} } as MissionRecord;
  expect(await startN5Publication({ issues: { create } } as never, m)).toBe(m);
  m.aggregate.n5 = fixture().mission.aggregate.n5; delete m.aggregate.n5!.publication;
  await expect(startN5Publication({ issues: { create } } as never, m)).rejects.toMatchObject({ code: "n5_accepted_candidate_required" });
  expect(create).not.toHaveBeenCalled();
});
