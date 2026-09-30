import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyCandidateAttachment } from "./foundation-probe.js";
import { ApprovalPreflightError, verifyApprovalCandidate } from "./delivery-manifest.js";

/** Content facts are produced by the worker, never accepted from command JSON. */
export type L03ContentSubject = {
  issueId: string;
  authorAgentId: string;
  repository: string;
  baseCommit: string;
  candidateCommit: string;
  attachmentId: string;
  sha256: string;
};

export async function verifyL03Content(ctx: PluginContext, companyId: string, subject: L03ContentSubject) {
  const issue = await ctx.issues.get(subject.issueId, companyId);
  if (!issue || issue.companyId !== companyId) throw new ApprovalPreflightError("Result issue is unavailable in this company", 404);
  const author = await ctx.agents.get(subject.authorAgentId, companyId);
  if (!author || author.companyId !== companyId) throw new ApprovalPreflightError("Result author is unavailable in this company", 403);
  const manifest = await verifyApprovalCandidate(ctx, issue, companyId, subject.candidateCommit);
  if (manifest.assigneeAgentId !== subject.authorAgentId || manifest.repository !== subject.repository
      || manifest.baseCommit !== subject.baseCommit || manifest.bundleAttachmentId !== subject.attachmentId
      || manifest.bundleSha256 !== subject.sha256) {
    throw new ApprovalPreflightError("Submitted result does not match the current delivery manifest");
  }
  const verified = await verifyCandidateAttachment(ctx, {
    companyId, issueId: issue.id, attachmentId: subject.attachmentId,
    expectedSha256: subject.sha256, baseCommit: subject.baseCommit, candidateCommit: subject.candidateCommit,
  });
  return {
    subjectHash: createHash("sha256").update(JSON.stringify(subject)).digest("hex"),
    verifiedAt: new Date().toISOString(),
    ...verified,
  };
}
