import { parseIntegrationContract, type IntegrationContract } from "./integration-contract.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { parseGithubFeedbackRefreshShape, type GithubFeedbackRefreshAuthority } from "./github-feedback-authority.js";

export type PrContract = { protocol: "council-pr-contract-v1"; draftOnly: boolean; result: "draft-pr" | "reviewed-pr" | "integrated-verified"; integration?: IntegrationContract;
  feedback: "review-and-correct"; requiredChecks: string[]; feedbackRefresh?: GithubFeedbackRefreshAuthority };
export type GithubFeedback = { protocol: "publisher-github-feedback-v1"; provenance: "publisher_run_report";
  missionId: string; intentId: string; issueId: string; runId: string; observedAt: string;
  url: string; repository: string; headSha: string; baseRef: string; headRef: string; draft: boolean;
  checks: Array<{ name: string; state: "pending" | "passed" | "failed"; evidenceUrl: string }>;
  reviews: Array<{ id: number; author: string; headSha: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
    body: string; url: string; submittedAt: string }> };
export type ControllerGithubFeedback = Omit<GithubFeedback, "protocol" | "provenance" | "runId"> & {
  protocol: "controller-github-feedback-v1"; provenance: "council_continuity_http"; jobRunId: string };
export type GithubFeedbackEvidence = GithubFeedback | ControllerGithubFeedback;
export type PublicationFeedback = { report: GithubFeedbackEvidence; reportHash: string; reviewSubmissionId?: string; previousPublication?: NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["publication"]>;
  previousApplication?: NonNullable<MissionRecord["aggregate"]["n2"]>["application"];
  state: "reported" | "reviewing" | "correction_requested" | "resolved" };

export function parsePrContract(value: unknown): PrContract | undefined {
  if (value === undefined) return undefined;
  const v = value as PrContract;
  if (!v || Array.isArray(v) || v.protocol !== "council-pr-contract-v1" || typeof v.draftOnly !== "boolean"
      || !["draft-pr", "reviewed-pr", "integrated-verified"].includes(v.result) || (v.result === "draft-pr") !== v.draftOnly
      || v.feedback !== "review-and-correct" || !Array.isArray(v.requiredChecks) || !v.requiredChecks.length || v.requiredChecks.length > 20
      || v.requiredChecks.some(name => typeof name !== "string" || !name.trim() || name.length > 200) || new Set(v.requiredChecks).size !== v.requiredChecks.length) {
    throw new MissionError(422, "pr_contract_required", "Explicit draft/result policy, bounded required checks and delegated independent feedback review required");
  }
  if ((v.result === "integrated-verified") !== (v.integration !== undefined)) throw new MissionError(422, "integration_scope", "Only an explicit integrated result delegates merge authority");
  const integration = v.integration === undefined ? undefined : parseIntegrationContract(v.integration);
  const feedbackRefresh = parseGithubFeedbackRefreshShape(v.feedbackRefresh);
  return { ...(integration ? { integration } : {}), ...(feedbackRefresh ? { feedbackRefresh } : {}), protocol: v.protocol, draftOnly: v.draftOnly, result: v.result, feedback: v.feedback, requiredChecks: [...v.requiredChecks] };
}

export function validateGithubFeedback(m: MissionRecord, value: unknown, actor: { agentId?: string | null; runId?: string | null }, observation: { url: string; headSha: string; draft: boolean; baseRef: string; headRef: string }) {
  const f = value as GithubFeedback, p = m.aggregate.n5!.publication!, a = m.aggregate.n5!.authority;
  const bindings = { protocol: "publisher-github-feedback-v1", provenance: "publisher_run_report", missionId: m.missionId, intentId: p.intentId,
    issueId: p.issueId, runId: actor.runId, url: observation.url, repository: a.repository, headSha: observation.headSha,
    baseRef: a.baseRef, headRef: a.headRef, draft: observation.draft };
  if (!f || Array.isArray(f) || !actor.agentId || actor.runId !== p.runId || Object.entries(bindings).some(([key, expected]) => f[key as keyof GithubFeedback] !== expected)
      || !Number.isFinite(Date.parse(f.observedAt)) || Date.parse(f.observedAt) < Date.parse(p.claimedAt!) || Date.now() - Date.parse(f.observedAt) > 300_000 || Date.parse(f.observedAt) > Date.now() + 5000) {
    throw new MissionError(409, "pr_feedback_binding", "Fresh GitHub CLI report must bind the exact admitted publisher, intent, URL and native observed head; it is actor provenance, not independent attestation");
  }
  if (!Array.isArray(f.checks) || f.checks.length > 100 || !Array.isArray(f.reviews) || f.reviews.length > 100
      || f.checks.some(check => !check || typeof check.name !== "string" || !check.name.trim() || check.name.length > 200 || !["pending", "passed", "failed"].includes(check.state) || typeof check.evidenceUrl !== "string" || !/^https:\/\//.test(check.evidenceUrl) || check.evidenceUrl.length > 1000)
      || f.reviews.some(review => !review || !Number.isSafeInteger(review.id) || review.id < 1 || typeof review.author !== "string" || !review.author || !/^[a-f0-9]{40}$/.test(review.headSha)
        || !["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(review.state) || typeof review.body !== "string" || review.body.length > 8000
        || !review.url?.startsWith(f.url + "#pullrequestreview-") || !Number.isFinite(Date.parse(review.submittedAt)))
      || new Set(f.checks.map(check => check.name)).size !== f.checks.length || new Set(f.reviews.map(review => review.id)).size !== f.reviews.length) {
    throw new MissionError(422, "pr_feedback_shape", "Complete bounded check/review observations with source references required; no truncated or fabricated approval");
  }
  return structuredClone(f);
}

export function githubFeedbackStates(contract: PrContract, report: GithubFeedbackEvidence) {
  const required = contract.requiredChecks.map(name => report.checks.find(check => check.name === name));
  const checks = required.some(check => check?.state === "failed") ? "failed" : required.every(check => check?.state === "passed") ? "passed" : "pending";
  const latest = new Map<string, GithubFeedback["reviews"][number]>();
  for (const review of [...report.reviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || a.id - b.id)) {
    if (review.state !== "COMMENTED") latest.set(review.author, review);
  }
  const reviews = [...latest.values()].some(review => review.state === "CHANGES_REQUESTED") ? "changes_requested"
    : [...latest.values()].some(review => review.state === "APPROVED" && review.headSha === report.headSha) ? "approved" : "pending";
  return { checks, reviews, reportHash: canonicalPayloadHash(report) } as const;
}

export function feedbackCorrectionRound(m: MissionRecord, submissionId: string) {
  return m.aggregate.n5?.authority.contract?.feedback === "review-and-correct"
    && m.aggregate.n5.feedback?.state === "reviewing" && m.aggregate.n5.feedback.reviewSubmissionId === submissionId;
}
