import { createHash, randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readNativeRun: vi.fn() }));
import { readNativeRun } from "../src/g4-native.js";
import { nativeReviewPacketText, parseNativeReviewerReport, readNativeReviewOutcome, replaceNativeReviewPacket,
  type NativeReviewPacketRecord } from "../src/n2-native-report.js";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";

function fixture() {
  const mandate = { objective: "Review exact candidate" };
  const submission = { submissionId: randomUUID(), ordinal: 1, predecessorSubmissionId: null, attachmentId: randomUUID(), byteSize: 42,
    sha256: "a".repeat(64), baseCommit: "b".repeat(40), candidateCommit: "c".repeat(40), evidenceRevision: 2,
    mandateHash: createHash("sha256").update(JSON.stringify(mandate)).digest("hex"), verifiedAt: new Date().toISOString() };
  const packet = { schema: "council-native-review-v1", companyId: "company", issueId: "issue", missionId: "mission", sourceRunId: "source", reviewerAgentId: "reviewer", mandate, submission, opinions: null };
  const record = { packet, hash: canonicalPayloadHash(packet), operationId: randomUUID(), correctionReservationId: randomUUID(), settlementCommandId: randomUUID(), publishedAt: new Date().toISOString() } as NativeReviewPacketRecord;
  const report = { schema: packet.schema, packetHash: record.hash,
    subject: { submissionId: submission.submissionId, candidateCommit: submission.candidateCommit, bundleSha256: submission.sha256, evidenceRevision: 2, mandateHash: submission.mandateHash },
    verdict: "approved", rationale: "Exact native candidate reviewed", dispositions: [] };
  const mission = { companyId: "company", rootIssueId: "issue", aggregate: { mandate,
    n2: { activeSubmissionId: submission.submissionId, submissions: [submission], rounds: [{ verdict: null }], native: { reviewPackets: [record] } } } } as unknown as MissionRecord;
  const card = { id: "card", companyId: "company", issueId: "issue", sourceRunId: "source", addresseeAgentId: "reviewer", resolvedByAgentId: "reviewer", resolvedByRunId: "review-run", resolvedAt: new Date().toISOString(), status: "accepted", payload: { target: { key: "native_completion_review", revisionId: "decision" } } };
  const run = { id: "review-run", agentId: "reviewer", status: "succeeded", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    contextSnapshot: { nativeReviewInteractionId: "card", nativeReviewDecisionId: "decision" }, resultJson: { nativeResult: { summary: JSON.stringify(report) } } };
  vi.mocked(readNativeRun).mockResolvedValue(run as never);
  const ctx = { issues: { listInteractions: vi.fn(async () => [card]) } };
  return { mission, record, report, card, run, ctx };
}
beforeEach(() => vi.resetAllMocks());
it("copies the exact report example from native instructions without inventing identifiers", () => {
  const { record } = fixture(); const text = nativeReviewPacketText(record);
  const example = text.split("\n").find(line => line.startsWith('{"schema"'))!;
  expect(parseNativeReviewerReport(example, record).packetHash).toBe(record.hash);
  const next = nativeReviewPacketText({ ...record, hash: "f".repeat(64) });
  const description = replaceNativeReviewPacket(`User objective${text}`, next);
  expect(description.startsWith("User objective")).toBe(true);
  expect(description).not.toContain(record.hash);
  expect(description.match(/<council-active-native-review>/g)).toHaveLength(1);
});
it.each([undefined, "not JSON", "{}", "null", "[]", "x".repeat(32_001)])("blocks an absent or malformed terminal report: %s", summary => {
  expect(() => parseNativeReviewerReport(summary, fixture().record)).toThrow();
});
it.each(["packetHash", "subject", "verdict", "rationale", "dispositions", "actorAgentId"])("refuses divergent or injected report field %s", field => {
  const { record, report } = fixture();
  expect(() => parseNativeReviewerReport(JSON.stringify({ ...report, [field]: field === "rationale" ? "" : "wrong" }), record)).toThrow();
});
it("reads native attribution and the public terminal summary without requesting any effect", async () => {
  const f = fixture(); const readback = await readNativeReviewOutcome(f.ctx as never, f.mission);
  expect(readback?.report).toEqual(f.report); expect(readback?.binding).toEqual({ interactionId: "card", decisionId: "decision", sourceRunId: "source" });
  expect(readNativeRun).toHaveBeenCalledWith(f.ctx, { companyId: "company", issueId: "issue", agentId: "reviewer", runId: "review-run" });
});
it.each(["resolvedByAgentId", "companyId", "issueId", "status"])("blocks divergent card %s", async field => {
  const f = fixture(); Object.assign(f.card, { [field]: "wrong" });
  await expect(readNativeReviewOutcome(f.ctx as never, f.mission)).rejects.toMatchObject({ code: "native_review_readback_unqualified" });
});
it.each([
  { status: "running", finishedAt: null }, { status: "failed" }, { resultJson: {} },
  { contextSnapshot: { nativeReviewInteractionId: "other", nativeReviewDecisionId: "decision" } },
])("blocks unresolved terminal reviewer evidence", async patch => {
  const f = fixture(); vi.mocked(readNativeRun).mockResolvedValue({ ...f.run, ...patch } as never);
  await expect(readNativeReviewOutcome(f.ctx as never, f.mission)).rejects.toMatchObject({ code: "native_review_readback_unqualified" });
});
it("does not turn native rejection into an approved Council report", async () => {
  const f = fixture(); f.card.status = "rejected";
  await expect(readNativeReviewOutcome(f.ctx as never, f.mission)).rejects.toThrow(/conflicts/);
});
it("preserves pending cards and changed mandate as unaccepted", async () => {
  const f = fixture(); f.card.status = "pending";
  expect(await readNativeReviewOutcome(f.ctx as never, f.mission)).toBeNull();
  f.mission.aggregate.mandate.objective = "Changed after handoff";
  await expect(readNativeReviewOutcome(f.ctx as never, f.mission)).rejects.toThrow(/changed/);
});
