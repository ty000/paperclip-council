import type { MissionRecord } from "./missions.js";
import type { N2Submission } from "./n2-missions.js";
import { MissionError } from "./mission-primitives.js";

/** Integrated leaf actors upload on their own admitted task, preserving the product subject. */
export function candidateAttachmentTarget(m: MissionRecord, admittedIssueId: string | null | undefined) {
  if (m.aggregate.projectMandate?.completion?.result !== "integrated-verified") return undefined;
  if (!admittedIssueId) throw new MissionError(409, "candidate_attachment_actor", "Exact admitted candidate task required");
  return admittedIssueId;
}
export function submissionAttachmentIssue(m: MissionRecord, submission: Pick<N2Submission, "attachmentIssueId">) {
  const issueId = submission.attachmentIssueId ?? m.rootIssueId;
  const n1 = m.aggregate.n1 as import("./n1-missions.js").N1State | undefined;
  const allowed = [m.rootIssueId, n1?.integration?.issueId, n1?.coordination?.issueId,
    ...(m.aggregate.n2?.ordinary?.tasks ?? []).filter(t => t.kind === "correction").map(t => t.issueId)];
  if (!allowed.includes(issueId)) throw new MissionError(409, "candidate_attachment_binding", "Artifact must belong to the product root or its exact admitted candidate actor");
  return issueId;
}
