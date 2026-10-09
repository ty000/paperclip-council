import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { integratedResult } from "../src/integration-contract.js";
import { assertIntegrationRecoveryStable, reconcileIntegrationRecovery } from "../src/integration-recovery.js";
import { recordParentObligations } from "../src/integration-runtime.js";

const f = vi.hoisted(() => ({ original: null as any, recovery: null as any, departure: vi.fn(), accounting: vi.fn(), cas: vi.fn() }));
vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: async (_ctx: unknown, _company: string, id: string) => id === f.recovery.missionId ? f.recovery : null }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: (...args: unknown[]) => f.departure(...args) }));
vi.mock("../src/n6-accounting.js", () => ({ assertN6SourceAccounting: (...args: unknown[]) => f.accounting(...args) }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2CommandCas: (...args: unknown[]) => f.cas(...args) }));

function mission(commit: string, base: string, pr: number, state = "verified") {
  const candidateCommit = (pr === 1 ? "a" : "d").repeat(40), submissionId = randomUUID();
  const report = { protocol: "publisher-integration-report-v1", provenance: "publisher_run_report", repository: "ty000/repo", url: `https://github.com/ty000/repo/pull/${pr}`,
    candidateCommit, baseRef: "main", baseCommit: base, state: "merged", integratedCommit: commit,
    baseContainsIntegrated: true, mergeParents: [base, candidateCommit], checks: [{ name: "integrated-ci", state: state === "failed" ? "failed" : "passed", evidenceUrl: "https://example.test/check" }] };
  return { companyId: "company", projectId: "project", rootIssueId: randomUUID(), missionId: randomUUID(), ownerUserId: "owner", version: 1,
    aggregate: { mandate: { acceptanceCriteria: ["User action executes the workflow", "Business refusal is visible"] }, commandReceipts: [],
      n2: { status: "accepted", activeSubmissionId: submissionId },
      n5: { authority: { repository: "ty000/repo", baseRef: "main", contract: { integration: { mergeMethod: "merge", requiredChecks: ["integrated-ci"], parentObligations: ["Parent user journey"] } } },
        publication: { operation: "integrate", settledAt: "observed", submission: { submissionId, candidateCommit, baseCommit: base } },
        integration: { state, report, reportHash: canonicalPayloadHash(report) } } } } as unknown as MissionRecord;
}
beforeEach(() => {
  vi.resetAllMocks();
  f.original = mission("c".repeat(40), "b".repeat(40), 1, "failed");
  f.recovery = mission("e".repeat(40), "c".repeat(40), 2);
  f.cas.mockImplementation(async (_ctx, m, _body, _kind, _actor, aggregate) => ({ outcome: "applied", mission: { ...m, version: m.version + 1, aggregate } }));
});
function recoveryFixture(criteria = f.original.aggregate.mandate.acceptanceCriteria) {
  const evidence = { originalReportHash: f.original.aggregate.n5.integration.reportHash, recoveryReportHash: f.recovery.aggregate.n5.integration.reportHash,
    criteria: criteria.map((criterion: string) => ({ criterion, evidenceRefs: ["https://example.test/composed-proof"] })) };
  const doc = { id: "document", latestRevisionId: "revision", body: JSON.stringify(evidence) };
  const ctx = { issues: { documents: { get: vi.fn(async () => doc) } } } as unknown as PluginContext;
  const body = { commandId: randomUUID(), expectedVersion: 1, mode: "correction", recoveryMissionId: f.recovery.missionId, documentRevisionId: "revision" };
  return { ctx, doc, evidence, body };
}
it.each(["correction", "rollback"])("releases the original delivery only after a separate verified %s and all original criteria", async mode => {
  const c = recoveryFixture(); c.body.mode = mode;
  expect(() => integratedResult(f.original)).toThrow();
  const result = await reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner");
  expect(result.mission.aggregate.n5?.integration?.recovery?.originalCriteriaVerified).toBe(true);
  expect(integratedResult(result.mission)).toMatchObject({ integratedCommit: "e".repeat(40), url: "https://github.com/ty000/repo/pull/1", candidateCommit: "a".repeat(40) });
  await expect(assertIntegrationRecoveryStable(c.ctx, result.mission)).resolves.toBeUndefined();
  expect(f.cas.mock.calls[0]?.[3]).toBe("user");
});
it("records a rollback without releasing the next delivery when an original user criterion remains unproved", async () => {
  const c = recoveryFixture([f.original.aggregate.mandate.acceptanceCriteria[0]]); c.body.mode = "rollback";
  const result = await reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner");
  expect(result.mission.aggregate.n5?.integration?.recovery?.originalCriteriaVerified).toBe(false);
  expect(() => integratedResult(result.mission)).toThrow();
});
it.each(["foreign-project", "foreign-owner", "original-pr", "wrong-base", "unsettled", "failed-check", "unknown-usage", "paused"])("does not record recovery with %s", async kind => {
  const c = recoveryFixture();
  if (kind === "foreign-project") f.recovery.projectId = "other";
  if (kind === "foreign-owner") f.recovery.ownerUserId = "other";
  if (kind === "original-pr") f.recovery.aggregate.n5.integration.report.url = f.original.aggregate.n5.integration.report.url;
  if (kind === "wrong-base") f.recovery.aggregate.n5.publication.submission.baseCommit = "f".repeat(40);
  if (kind === "unsettled") delete f.recovery.aggregate.n5.publication.settledAt;
  if (kind === "failed-check") f.recovery.aggregate.n5.integration.state = "failed";
  if (kind === "unknown-usage") f.accounting.mockRejectedValue(new Error("unsettled usage"));
  if (kind === "paused") f.departure.mockRejectedValue(new Error("paused"));
  await expect(reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner")).rejects.toThrow();
  expect(f.cas).not.toHaveBeenCalled();
});
it.each(["revision", "proof", "empty-reference", "duplicate-criterion"])("rejects %s in the exact native recovery assessment", async kind => {
  const c = recoveryFixture();
  if (kind === "revision") c.doc.latestRevisionId = "newer";
  if (kind === "proof") c.evidence.recoveryReportHash = "other";
  if (kind === "empty-reference") c.evidence.criteria[0].evidenceRefs = [];
  if (kind === "duplicate-criterion") c.evidence.criteria.push(c.evidence.criteria[0]);
  c.doc.body = JSON.stringify(c.evidence);
  await expect(reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner")).rejects.toMatchObject({ code: "integration_recovery_evidence" });
  expect(f.cas).not.toHaveBeenCalled();
});
it.each(["document", "result", "accounting"])("invalidates recorded recovery when its %s changes before consumption", async kind => {
  const c = recoveryFixture(), result = await reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner");
  if (kind === "document") c.doc.latestRevisionId = "newer";
  if (kind === "result") f.recovery.aggregate.n5.integration.reportHash = "changed";
  if (kind === "accounting") f.accounting.mockRejectedValue(new Error("usage unknown"));
  await expect(assertIntegrationRecoveryStable(c.ctx, result.mission)).rejects.toThrow();
});
function obligationsFixture() {
  const m = f.recovery as MissionRecord, result = integratedResult(m);
  const evidence = { missionId: m.missionId, integratedReportHash: result.reportHash, obligations: [{ criterion: "Parent user journey", evidenceRefs: ["https://example.test/parent-path"] }] };
  const doc = { id: "parent-document", latestRevisionId: "parent-revision", body: JSON.stringify(evidence) };
  const ctx = { issues: { documents: { get: vi.fn(async () => doc) } } } as unknown as PluginContext;
  return { m, evidence, doc, ctx, body: { commandId: randomUUID(), expectedVersion: 1, documentRevisionId: "parent-revision" } };
}
it.each(["null", "null-criterion", "scalar-reference"])("returns a bounded refusal for malformed %s recovery evidence", async kind => {
  const c = recoveryFixture();
  c.doc.body = kind === "null" ? "null" : JSON.stringify({ ...c.evidence, criteria: kind === "null-criterion" ? [null] : [{ criterion: "User action executes the workflow", evidenceRefs: "unbounded" }] });
  await expect(reconcileIntegrationRecovery(c.ctx, f.original, c.body, "owner")).rejects.toMatchObject({ code: "integration_recovery_evidence" });
  expect(f.cas).not.toHaveBeenCalled();
});
it.each(["null", "null-obligation", "scalar-reference"])("returns a bounded refusal for malformed %s parent evidence", async kind => {
  const c = obligationsFixture();
  c.doc.body = kind === "null" ? "null" : JSON.stringify({ ...c.evidence, obligations: kind === "null-obligation" ? [null] : [{ criterion: "Parent user journey", evidenceRefs: "unbounded" }] });
  await expect(recordParentObligations(c.ctx, c.m, c.body, "owner")).rejects.toMatchObject({ code: "parent_obligations_binding" });
  expect(f.cas).not.toHaveBeenCalled();
});
it("records independent parent obligations bound to the integrated result rather than the last candidate", async () => {
  const c = obligationsFixture();
  const result = await recordParentObligations(c.ctx, c.m, c.body, "owner");
  expect(result.mission.aggregate.n5?.integration?.obligations).toEqual({ documentId: c.doc.id, revisionId: c.doc.latestRevisionId, bodyHash: canonicalPayloadHash(c.doc.body), evidenceRefs: ["https://example.test/parent-path"] });
});
it.each(["missing-criterion", "duplicate-criterion", "foreign-result", "foreign-mission", "revision", "empty-reference", "integration-pending"])("refuses parent closure evidence with %s", async kind => {
  const c = obligationsFixture();
  if (kind === "missing-criterion") c.evidence.obligations = [];
  if (kind === "duplicate-criterion") c.evidence.obligations.push(c.evidence.obligations[0]!);
  if (kind === "foreign-result") c.evidence.integratedReportHash = "other";
  if (kind === "foreign-mission") c.evidence.missionId = "other";
  if (kind === "revision") c.doc.latestRevisionId = "newer";
  if (kind === "empty-reference") c.evidence.obligations[0]!.evidenceRefs = [];
  if (kind === "integration-pending") c.m.aggregate.n5!.integration!.state = "pending";
  c.doc.body = JSON.stringify(c.evidence);
  await expect(recordParentObligations(c.ctx, c.m, c.body, "owner")).rejects.toThrow();
  expect(f.cas).not.toHaveBeenCalled();
});
