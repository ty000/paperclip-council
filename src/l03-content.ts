import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { verifyCandidateAttachment } from "./foundation-probe.js";
import { canonicalSha256 } from "./l03.js";
import type { L03Artifact } from "./l03-types.js";
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
  artifacts: L03Artifact[];
  artifactSetHash: string;
  evidenceRefs: string[];
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
  const artifactRef = `attachment:${subject.attachmentId}#sha256:${subject.sha256}`;
  const artifacts = [{ ref: artifactRef, sha256: subject.sha256, byteVerificationRef: artifactRef }];
  if (canonicalSha256(subject.artifacts) !== canonicalSha256(artifacts)
    || subject.artifactSetHash !== canonicalSha256(artifacts)) {
    throw new ApprovalPreflightError("L03 V1 requires exactly the verified bundle artifact and its canonical artifact-set digest");
  }
  if (!subject.evidenceRefs.includes(artifactRef)) throw new ApprovalPreflightError("Result evidence must include the verified bundle");
  await verifyL03Evidence(ctx, companyId, issue.id, subject.evidenceRefs);
  return {
    subjectHash: createHash("sha256").update(JSON.stringify(subject)).digest("hex"),
    verifiedAt: new Date().toISOString(),
    ...verified,
  };
}

/** Evidence references resolve to current native bytes, never arbitrary labels or URLs. */
export async function verifyL03Evidence(ctx: PluginContext, companyId: string, issueId: string, refs: string[]): Promise<void> {
  if (!Array.isArray(refs) || refs.length > 32) throw new ApprovalPreflightError("Evidence must be a bounded list of native references");
  for (const ref of refs) {
    const parsed = /^(document|attachment):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})#sha256:([a-f0-9]{64})$/.exec(ref);
    if (!parsed) throw new ApprovalPreflightError("Evidence must identify a native document or attachment and its SHA-256");
    const [, kind, id, expected] = parsed;
    let bytes: Buffer;
    if (kind === "document") {
      const doc = await ctx.issues.documents.get(issueId, id!, companyId);
      if (!doc) throw new ApprovalPreflightError("Referenced evidence document is missing");
      bytes = Buffer.from(doc.body);
    } else {
      const attachments = await ctx.issues.listAttachments(issueId, companyId);
      if (!attachments.some(a => a.id === id && a.issueId === issueId && a.companyId === companyId)) throw new ApprovalPreflightError("Evidence attachment is outside the issue");
      const content = await ctx.issues.getAttachmentContent(id!, companyId, { maxBytes: 16 * 1024 * 1024 });
      if (!content) throw new ApprovalPreflightError("Evidence attachment is unavailable");
      bytes = Buffer.from(content.contentBase64, "base64");
      if (bytes.length !== content.byteSize) throw new ApprovalPreflightError("Evidence attachment byte size changed");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new ApprovalPreflightError("Evidence bytes do not match the referenced digest");
  }
}
