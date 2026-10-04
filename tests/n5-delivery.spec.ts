import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { correlateN5Readback } from "../src/n5-native.js";
import { startN5Publication } from "../src/n5-runtime.js";
import { inspectN5 } from "../src/n5-state.js";

function fixture() {
  const companyId = randomUUID(); const issueId = randomUUID(); const runId = randomUUID(); const intentId = randomUUID();
  const document = { id: randomUUID(), issueId, latestRevisionId: randomUUID(), body: JSON.stringify({ intentId, url: "https://github.com/ty000/paperclip-council/pull/23" }) };
  const submissionId = randomUUID();
  const mission = { companyId, aggregate: { mandate: {}, n2: { status: "accepted", activeSubmissionId: submissionId }, n5: { plan: { integrationLeadAgentId: randomUUID() },
    authority: { repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/delivery", publisherAgentId: randomUUID() },
    publication: { intentId, issueId, runId, claimedAt: new Date(Date.now() - 1000).toISOString(), submission: { submissionId, candidateCommit: "a".repeat(40), mandateHash: createHash("sha256").update("{}").digest("hex") } } } } } as MissionRecord;
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
it("never replaces the first correlated PR under the same publication intent", () => {
  const f = fixture();
  f.mission.aggregate.n5!.publication!.observation = correlateN5Readback(f.mission, f.document, f.products, f.objects);
  f.document.body = f.document.body.replace("/pull/23", "/pull/24");
  expect(() => correlateN5Readback(f.mission, f.document, f.products, f.objects)).toThrow(/another PR/);
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
  p.observation.lastResolvedAt = new Date().toISOString(); p.readbackUnavailable = "n5_native_read_unavailable";
  expect(inspectN5(f.mission)?.ready).toBe(false);
  delete p.readbackUnavailable; f.mission.aggregate.mandate.objective = "changed";
  expect(inspectN5(f.mission)?.ready).toBe(false);
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

it.each(["n2-transmission", "n3-transmission", "n3-specialist"])("retains G4 exposure for unsettled %s even after final reviewer settlement", async kind => {
  const f = fixture(); const m = f.mission; const submission = { ...m.aggregate.n5!.publication!.submission, submissionId: randomUUID() };
  delete m.aggregate.n5!.publication;
  m.aggregate.responsibilities = { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: randomUUID(), requiredPerspectives: [] };
  m.aggregate.compositions = { council: { members: [{ agentId: m.aggregate.responsibilities.finalReviewerAgentId }] } } as never;
  m.aggregate.n2 = { status: "accepted", activeSubmissionId: submission.submissionId, submissions: [submission], rounds: [{ handoff: { reviewerRunId: randomUUID(), usageSettledAt: new Date().toISOString() } }],
    application: { state: "observed", submissionId: submission.submissionId }, native: { transmission: { settledAt: kind === "n2-transmission" ? undefined : new Date().toISOString() } } } as never;
  if (kind !== "n2-transmission") m.aggregate.n3 = { rounds: [{ transmission: { settledAt: kind === "n3-transmission" ? undefined : new Date().toISOString() },
    specialists: [{ settledAt: kind === "n3-specialist" ? undefined : new Date().toISOString() }] }] } as never;
  const create = vi.fn();
  await expect(startN5Publication({ issues: { create } } as never, m)).rejects.toMatchObject({ code: "n5_source_usage_pending" });
  expect(create).not.toHaveBeenCalled();
});

it("pins the prior PR URL before the first update readback", () => {
  const f = fixture(); f.mission.aggregate.n5!.publication!.targetUrl = "https://github.com/ty000/paperclip-council/pull/22";
  expect(() => correlateN5Readback(f.mission, f.document, f.products, f.objects)).toThrow(/another PR/);
});

function acceptedFixture() {
  const m = fixture().mission; const p = m.aggregate.n5!.publication!;
  m.aggregate.journal = [];
  m.aggregate.responsibilities = { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: randomUUID(), requiredPerspectives: [] };
  m.aggregate.compositions = { council: { members: [{ agentId: m.aggregate.responsibilities.finalReviewerAgentId }] } } as never;
  m.aggregate.n2 = { status: "accepted", correctionLimit: 1, correctionsUsed: 0, activeSubmissionId: p.submission.submissionId,
    submissions: [p.submission], rounds: [{ round: 1, handoff: { reviewerRunId: randomUUID(), usageSettledAt: new Date().toISOString() }, verdict: { verdict: "approved" } }],
    application: { state: "observed", submissionId: p.submission.submissionId }, native: { transmission: { settledAt: new Date().toISOString() } } } as never;
  p.state = "opened"; p.settledAt = new Date().toISOString(); p.observation = { state: "open", url: "https://github.com/ty000/paperclip-council/pull/23" } as never;
  return m;
}
it("consumes the sole correction while retaining historical independent acceptance and PR", async () => {
  const { prepareN5Continuation } = await import("../src/n5-continuation.js");
  const m = acceptedFixture(); const before = structuredClone(m.aggregate);
  const next = prepareN5Continuation(m, { requestId: randomUUID(), reservationId: randomUUID(), reason: "Post-publication defect", criteria: ["Fix bounded defect"], actorId: randomUUID(), periodKey: "same-period" });
  expect(next.n2.correctionsUsed).toBe(1); expect(next.n2.status).toBe("correction_requested");
  expect(next.n2.rounds).toEqual(before.n2!.rounds); expect(next.n5.continuation.previousApplication).toEqual(before.n2!.application);
  expect(next.n5.continuation.previousPublication).toEqual(before.n5!.publication); expect(next.n5.authority).toEqual(before.n5!.authority);
  expect(m.aggregate).toEqual(before);
  m.aggregate.n2!.correctionsUsed = 1;
  expect(() => prepareN5Continuation(m, { requestId: randomUUID(), reservationId: randomUUID(), reason: "More", criteria: ["More"], actorId: randomUUID(), periodKey: "same-period" })).toThrow(/already consumed/);
});

it("revalidates a preauthorized ordinary publisher before any publication claim or admission", async () => {
  const f = fixture(); delete f.mission.aggregate.n5!.publication;
  f.mission.aggregate.n2!.ordinary = { protocol: "ordinary-cli-v1", tasks: [] };
  const create = vi.fn(); const execute = vi.fn();
  const ctx = { agents: { get: vi.fn().mockResolvedValue({ adapterType: "codex_local", adapterConfig: { engine: "paperclip_runner" }, status: "idle" }) },
    issues: { create }, db: { execute } };
  await expect(startN5Publication(ctx as never, f.mission)).rejects.toMatchObject({ code: "ordinary_cli_required" });
  expect(create).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});

it("requires ordinary publisher terminal settlement even when its exact PR and checks are already observed", () => {
  const f = fixture(); const p = f.mission.aggregate.n5!.publication!;
  f.mission.aggregate.n2!.ordinary = { protocol: "ordinary-cli-v1", tasks: [] };
  p.observation = correlateN5Readback(f.mission, f.document, f.products, f.objects);
  const attributed = { headSha: p.submission.candidateCommit, evidenceRefs: ["fixture:exact-head"], observedAt: new Date().toISOString(), agentId: randomUUID(), runId: p.runId! };
  p.checks = { ...attributed, state: "passed" }; p.reviews = { ...attributed, state: "approved" };
  expect(inspectN5(f.mission)?.ready).toBe(false);
  p.settledAt = new Date().toISOString(); expect(inspectN5(f.mission)?.ready).toBe(true);
});
it("reserves the ordinary owner-resume task on the same root without inventing a native release or resetting acceptance", async () => {
  const { prepareN5Continuation } = await import("../src/n5-continuation.js");
  const m = acceptedFixture(); m.rootIssueId = randomUUID(); delete m.aggregate.n2!.native;
  const submissionId = m.aggregate.n2!.activeSubmissionId;
  m.aggregate.n2!.ordinary = { protocol: "ordinary-cli-v1", tasks: [{ kind: "council", submissionId, settledAt: "then", receiptRecordedAt: "then", report: { verdict: "approved" } } as never] };
  const before = structuredClone(m.aggregate); const requestId = randomUUID(); const reservationId = randomUUID();
  const next = prepareN5Continuation(m, { requestId, reservationId, reason: "Bounded post-publication correction", criteria: ["new marker"], actorId: randomUUID(), periodKey: "same" });
  expect(next.n2.native).toBeUndefined(); expect(next.n2.correctionsUsed).toBe(1);
  expect(next.n2.ordinary!.tasks.at(-1)).toMatchObject({ taskId: requestId, reservationId, kind: "correction", issueId: m.rootIssueId,
    agentId: m.aggregate.responsibilities.integrationLeadAgentId, creation: "confirmed", wake: "claimed", runId: null });
  expect(next.n2.rounds).toEqual(before.n2!.rounds); expect(m.aggregate).toEqual(before);
});
