import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { assertN3Decision, attestN3Transmission, freshN3Round, n3Subject, synthesizeN3 } from "../src/n3-runtime.js";
import { decideNativeN2 } from "../src/n2-native-runtime.js";
import { recordN3Opinion, synthesizeN3Review } from "../src/n3-opinions.js";
import type { MissionRecord } from "../src/missions.js";

function fixture() {
  const lead = randomUUID(); const reviewer = randomUUID(); const run = randomUUID();
  const submission = { submissionId: randomUUID(), ordinal: 1 as const, predecessorSubmissionId: null, attachmentId: randomUUID(), byteSize: 42,
    sha256: "a".repeat(64), baseCommit: "b".repeat(40), candidateCommit: "c".repeat(40), evidenceRevision: 2, mandateHash: "d".repeat(64), verifiedAt: new Date().toISOString() };
  const mission = { aggregate: { responsibilities: { integrationLeadAgentId: lead, finalReviewerAgentId: reviewer }, n1: { contributions: [] },
    n2: { activeSubmissionId: submission.submissionId, submissions: [submission] } } } as unknown as MissionRecord;
  const slots = ["product", "security"].map(perspective => ({ slotId: randomUUID(), specialistAgentId: randomUUID(), perspective: perspective as "product" | "security", required: true, question: "Check candidate" }));
  const round = freshN3Round(mission, submission, slots);
  mission.aggregate.n3 = { slots, rounds: [round] };
  const decision = { companyId: randomUUID(), issueId: randomUUID(), verdict: "approved" as const, actorAgentId: reviewer, runId: run, operationId: randomUUID(), resultReference: `council:n2:submission:${submission.submissionId}`, approvedCommit: submission.candidateCommit, justification: "Evidence accepted" };
  return { mission, submission, round, reviewer, run, lead, decision };
}
it("maps the immutable merged N2 submission without mission-version drift", () => {
  const { submission } = fixture();
  expect(n3Subject(submission)).toEqual({ submissionId: submission.submissionId, candidateCommit: submission.candidateCommit,
    bundleSha256: submission.sha256, evidenceRevision: submission.evidenceRevision, mandateHash: submission.mandateHash });
});
it("rejects missing synthesis before any native read, write or receipt", async () => {
  const { mission, decision } = fixture();
  await expect(decideNativeN2({} as never, mission, {} as never, decision)).rejects.toMatchObject({ code: "n3_synthesis_required" });
});
it("requires every original opinion and settled usage, then exact verdict and reviewer run", () => {
  const { mission, round, reviewer, run, decision } = fixture();
  expect(() => synthesizeN3Review(round.review, { subject: round.review.subject, authenticatedAgentId: reviewer, authenticatedRunId: run,
    verdict: "approved", rationale: "Accepted", dispositions: [] })).toThrow(/missing required opinion/);
  for (const slot of round.review.slots) round.review = recordN3Opinion(round.review, { subject: round.review.subject, slotId: slot.slotId,
    authenticatedAgentId: slot.specialistAgentId, authenticatedRunId: randomUUID(), opinionId: randomUUID(), outcome: "support", rationale: "Evidence checked", findings: [], unresolvedQuestions: [] });
  round.review = synthesizeN3Review(round.review, { subject: round.review.subject, authenticatedAgentId: reviewer, authenticatedRunId: run,
    verdict: "approved", rationale: "Accepted", dispositions: [] });
  expect(() => assertN3Decision(mission, decision)).toThrow(/settled opinions/);
  round.specialists.forEach(item => { item.settledAt = new Date().toISOString(); });
  expect(() => assertN3Decision(mission, decision)).not.toThrow();
  expect(() => assertN3Decision(mission, { ...decision, verdict: "changes_requested" })).toThrow(/Matching final-reviewer/);
  expect(() => assertN3Decision(mission, { ...decision, runId: randomUUID() })).toThrow(/Matching final-reviewer/);
  round.review.subject.evidenceRevision++;
  expect(() => assertN3Decision(mission, decision)).toThrow(/immutable N2 submission/);
});
it("forbids another agent to attest the admitted lead run", async () => {
  const { mission, round, run } = fixture(); round.transmission.runId = run;
  const execute = vi.fn();
  await expect(attestN3Transmission({ db: { execute } } as never, mission, { actor: { actorType: "agent", agentId: randomUUID(), runId: run } } as never, {})).rejects.toMatchObject({ code: "n3_opinions_pending" });
  expect(execute).not.toHaveBeenCalled();
});
it("synthesis cannot consume an unaccounted round and N2 alone is unchanged", async () => {
  const { mission, decision } = fixture();
  await expect(synthesizeN3({} as never, mission, {} as never, {})).rejects.toMatchObject({ code: "n3_usage_pending" });
  delete mission.aggregate.n3;
  expect(() => assertN3Decision(mission, decision)).not.toThrow();
});
