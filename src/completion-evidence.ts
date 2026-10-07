import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import { acceptedN5Submission } from "./n5-preflight.js";
import { inspectN5 } from "./n5-state.js";
import { completionPolicy } from "./completion-contract.js";

export function completionEvidence(m: MissionRecord) {
  const policy = completionPolicy(m);
  if (!policy) throw new MissionError(409, "completion_authority", "Explicit project completion policy required");
  const submission = acceptedN5Submission(m), n1 = m.aggregate.n1 as N1State;
  if (m.aggregate.n2!.rounds.some(r => !r.verdict)) throw new MissionError(409, "completion_review_pending", "Retain every independent Council decision before closure");
  if (!m.aggregate.hierarchy?.nodes || n1.sourceBaseCommit !== submission.baseCommit || n1.contributions.some(s => !s.proof?.closedAt || !s.commit || s.commit !== s.proof.commit)) {
    throw new MissionError(409, "completion_children_proof", "All necessary children require verified source contributions and observed terminal closure before parent consolidation");
  }
  const delivery = inspectN5(m);
  if (policy.result !== "accepted-candidate" && (!delivery?.publicationReady || delivery.authority.contract?.result !== policy.result)) {
    throw new MissionError(409, "completion_delivery_proof", "A draft PR satisfies only explicit draft-result authority; final exact-head settled delivery must match the result");
  }
  if (policy.result === "accepted-candidate" && m.aggregate.n5) throw new MissionError(409, "completion_result_scope", "An accepted-candidate result cannot imply a publication result");
  return { protocol: policy.protocol, result: policy.result, companyId: m.companyId, missionId: m.missionId, rootIssueId: m.rootIssueId,
    mandate: m.aggregate.mandate, submission, contributionProofs: n1.contributions.map(s => ({ contributionId: s.contributionId,
      issueId: s.childIssueId, runId: s.authorRunId, reservationId: s.dispatchReservationId, proof: s.proof })),
    reviewOperations: m.aggregate.n2!.rounds.map(r => ({ submissionId: r.submissionId, operationId: r.verdict!.operationId, verdict: r.verdict!.verdict })),
    ...(delivery ? { publication: delivery.publication, contract: delivery.authority.contract } : {}) };
}
