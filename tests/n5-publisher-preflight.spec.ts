import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { MissionRecord } from "../src/missions.js";
import { validatePublisherPreflight } from "../src/n5-publisher-preflight.js";
import { n5PublisherInstructions } from "../src/n5-instructions.js";

function fixture() {
  const runId = randomUUID(); const missionId = randomUUID(); const intentId = randomUUID(); const issueId = randomUUID();
  const m = { missionId, aggregate: { n5: { authority: { repository: "test/product", baseRef: "main", headRef: "codex/delivery", publisherPreflight: "publisher-run-report-v1" },
    publication: { intentId, issueId, runId, submission: { candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40) } } } } } as MissionRecord;
  const report = { protocol: "publisher-run-report-v1", provenance: "publisher_run_report", status: "pass", missionId, intentId, issueId, runId,
    repository: "test/product", candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40), baseRef: "main", headRef: "codex/delivery", remoteHead: null,
    observedAt: new Date().toISOString(), publicationWriteObserved: false, providerTurnsStartedByProbe: 0,
    checks: Object.fromEntries(["gitTool", "ghTool", "workspaceIdentity", "localCandidate", "originIdentity", "trackedFilesClean", "repositoryRead", "pushPermissionReported", "remoteBase", "remoteHeadLease"].map(key => [key, true])) };
  return { m, report, runId };
}
it("accepts only attributed read-only evidence and returns selected bindings without arbitrary data", () => {
  const f = fixture(); expect(validatePublisherPreflight(f.m, f.report, f.runId)).toMatchObject({ repository: "test/product", remoteHead: null });
  expect(validatePublisherPreflight(f.m, { ...f.report, extraOutput: "not retained" }, f.runId)).not.toHaveProperty("extraOutput");
});
it.each(["runId", "missionId", "issueId", "intentId", "repository", "candidateCommit", "baseCommit", "baseRef", "headRef", "remoteHead"])("refuses an unrelated %s without changing the intent", key => {
  const f = fixture(); const before = structuredClone(f.m);
  expect(() => validatePublisherPreflight(f.m, { ...f.report, [key]: "foreign" }, f.runId)).toThrow(/Fresh successful preflight/);
  expect(f.m).toEqual(before);
});
it.each([
  { status: "blocked" }, { observedAt: new Date(0).toISOString() }, { observedAt: "invalid" },
  { observedAt: new Date(Date.now() + 60_000).toISOString() }, { publicationWriteObserved: true }, { providerTurnsStartedByProbe: 1 },
  { checks: { repositoryRead: true } }, { provenance: "host_attested" },
])("does not promote inconclusive/read-only data into publication permission: %j", patch => {
  const f = fixture(); expect(() => validatePublisherPreflight(f.m, { ...f.report, ...patch }, f.runId)).toThrow();
});
it("requires the persisted previous observed head for an update", () => {
  const f = fixture(); const n5 = f.m.aggregate.n5!; n5.publication!.operation = "update";
  expect(() => validatePublisherPreflight(f.m, f.report, f.runId)).toThrow(/previous head/);
  n5.continuation = { previousPublication: { submission: { candidateCommit: "c".repeat(40) }, observation: { headSha: "c".repeat(40) } } } as unknown as NonNullable<typeof n5.continuation>;
  expect(validatePublisherPreflight(f.m, { ...f.report, remoteHead: "c".repeat(40) }, f.runId).remoteHead).toBe("c".repeat(40));
  n5.continuation!.previousPublication.observation!.headSha = "d".repeat(40);
  expect(() => validatePublisherPreflight(f.m, f.report, f.runId)).toThrow(/previous head/);
});
it("gives new publishers executable read-only instructions inside their existing run and keeps historical authorities available", () => {
  const f = fixture(); const instructions = n5PublisherInstructions(f.m);
  expect(instructions).toContain("publisher_preflight.py");
  expect(instructions).toContain("already admitted publisher run");
  expect(instructions).toContain("do not add an operator token");
  delete f.m.aggregate.n5!.authority.publisherPreflight;
  expect(n5PublisherInstructions(f.m)).not.toContain("publisher_preflight.py");
});
