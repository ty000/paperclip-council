import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/shared";

export type DeliveryManifest = {
  repository: string;
  branch: string;
  baseCommit: string;
  approvedCommit: string;
  bundleAttachmentId: string;
  bundleSha256: string;
  deliveryWorkspacePath: string;
  assigneeAgentId: string;
};

export class ApprovalPreflightError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message);
  }
}

const fields = [
  "repository", "branch", "baseCommit", "approvedCommit", "bundleAttachmentId",
  "bundleSha256", "deliveryWorkspacePath", "assigneeAgentId",
] as const;

export function parseDeliveryManifest(body: string): DeliveryManifest {
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new ApprovalPreflightError("delivery-manifest must contain valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApprovalPreflightError("delivery-manifest must be a JSON object");
  }
  const m = value as Record<string, unknown>;
  for (const field of fields) {
    if (typeof m[field] !== "string" || !m[field]) {
      throw new ApprovalPreflightError(`delivery-manifest: invalid or missing ${field}`);
    }
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(m.repository as string)) {
    throw new ApprovalPreflightError("delivery-manifest: invalid GitHub repository");
  }
  if (!/^codex\/[\w./-]+$/.test(m.branch as string) || (m.branch as string).includes("..")) {
    throw new ApprovalPreflightError("delivery-manifest: invalid branch");
  }
  for (const field of ["baseCommit", "approvedCommit"] as const) {
    if (!/^[a-f0-9]{40}$/.test(m[field] as string)) {
      throw new ApprovalPreflightError(`delivery-manifest: invalid ${field}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(m.bundleSha256 as string)) {
    throw new ApprovalPreflightError("delivery-manifest: invalid bundleSha256");
  }
  for (const field of ["bundleAttachmentId", "assigneeAgentId"] as const) {
    if (!/^[a-f0-9-]{36}$/.test(m[field] as string)) {
      throw new ApprovalPreflightError(`delivery-manifest: invalid ${field}`);
    }
  }
  if (!(m.deliveryWorkspacePath as string).startsWith("/home/davy-lp/workspace/")
    || (m.deliveryWorkspacePath as string).includes("..")) {
    throw new ApprovalPreflightError("delivery-manifest: invalid deliveryWorkspacePath");
  }
  return m as DeliveryManifest;
}

function repositoryIdentity(value: string): string {
  return value.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase();
}

function verifyWorkProducts(issue: Issue, manifest: DeliveryManifest): void {
  // The current SDK does not expose a listWorkProducts operation. Some host
  // issue projections include them; check those when the projection is present.
  const candidates = issue.workProducts?.filter((product) => product.type === "commit" || product.type === "branch");
  if (!candidates?.length) return;
  const current = candidates.filter((product) => !["archived", "closed", "failed", "merged"].includes(product.status));
  const primary = current.filter((product) => product.isPrimary);
  const readyForReview = current.filter((product) => product.status === "ready_for_review");
  const approvalCandidates = primary.length ? primary : readyForReview.length ? readyForReview : current;
  const matches = approvalCandidates.length > 0 && approvalCandidates.every((product) => {
    const metadata = product.metadata ?? {};
    const repository = metadata.repo ?? metadata.repository;
    const branch = metadata.branch ?? metadata.headRef;
    const base = metadata.baseCommit;
    const head = metadata.sha ?? metadata.commit ?? metadata.approvedCommit;
    if (typeof repository !== "string" || typeof branch !== "string" || typeof head !== "string") return false;
    return repositoryIdentity(repository) === repositoryIdentity(manifest.repository)
      && branch === manifest.branch
      && head === manifest.approvedCommit
      && (base === undefined || base === manifest.baseCommit);
  });
  if (!matches) throw new ApprovalPreflightError("Candidate work product does not match delivery-manifest repository, branch, base or head");
}

export async function verifyApprovalCandidate(
  ctx: PluginContext,
  issue: Issue,
  companyId: string,
  approvedCommit: string,
): Promise<DeliveryManifest> {
  const doc = await ctx.issues.documents.get(issue.id, "delivery-manifest", companyId);
  if (!doc) throw new ApprovalPreflightError("Add a delivery-manifest document to this issue before approval", 409);
  const manifest = parseDeliveryManifest(doc.body);
  if (manifest.approvedCommit !== approvedCommit) {
    throw new ApprovalPreflightError("approvedCommit does not match delivery-manifest approvedCommit");
  }
  const attachments = await ctx.issues.listAttachments(issue.id, companyId);
  const bundle = attachments.find((attachment) => attachment.id === manifest.bundleAttachmentId);
  if (!bundle || bundle.issueId !== issue.id || bundle.companyId !== companyId) {
    throw new ApprovalPreflightError("delivery-manifest bundleAttachmentId does not belong to this issue");
  }
  if (bundle.sha256 !== manifest.bundleSha256) {
    throw new ApprovalPreflightError("delivery-manifest bundleSha256 does not match attachment metadata");
  }
  verifyWorkProducts(issue, manifest);
  return manifest;
}
