import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { GithubFeedback } from "./pr-contract.js";

export type IntegrationContract = { protocol: "council-integrated-delivery-v1"; mergeMethod: "merge" | "squash";
  requiredChecks: string[]; parentObligations: string[] };
export type IntegrationReport = { protocol: "publisher-integration-report-v1"; provenance: "publisher_run_report";
  companyId: string; missionId: string; intentId: string; issueId: string; runId: string; observedAt: string;
  repository: string; url: string; candidateCommit: string; baseRef: string; baseCommit: string;
  state: "open" | "merged"; integratedCommit: string | null; baseContainsIntegrated: boolean;
  mergeParents: string[]; checks: GithubFeedback["checks"] };
export type IntegratedDelivery = { previousPublication: NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["publication"]>;
  report?: IntegrationReport; reportHash?: string; mergeClaimedAt?: string; mergeCommandId?: string;
  state: "pending" | "unknown" | "failed" | "verified";
  recovery?: { missionId: string; result: { protocol: "integrated-result-v1"; repository: string; baseRef: string; url: string; candidateCommit: string; integratedCommit: string; reportHash: string };
    authorizedBy: string; mode: "correction" | "rollback"; documentId: string; revisionId: string; bodyHash: string; originalCriteriaVerified: boolean };
  obligations?: { documentId: string; revisionId: string; bodyHash: string; evidenceRefs: string[] } };

export function parseIntegrationContract(value: unknown): IntegrationContract {
  const v = value as IntegrationContract;
  const bounded = (a: unknown, max: number) => Array.isArray(a) && a.length <= max
    && a.every(s => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 200) && new Set(a).size === a.length;
  if (!v || v.protocol !== "council-integrated-delivery-v1" || !["merge", "squash"].includes(v.mergeMethod)
      || !bounded(v.requiredChecks, 20) || !v.requiredChecks.length || !bounded(v.parentObligations, 32)
      || Object.keys(v).some(k => !["protocol", "mergeMethod", "requiredChecks", "parentObligations"].includes(k))) {
    throw new MissionError(422, "integration_contract", "Explicit merge method, post-merge checks and parent obligations required");
  }
  return structuredClone(v);
}

/** Reports are evidence from the admitted publisher, never independent GitHub attestation. */
export function validateIntegrationReport(m: MissionRecord, value: unknown, runId: string) {
  const n5 = m.aggregate.n5!, p = n5.publication!, r = value as IntegrationReport;
  const bindings = { protocol: "publisher-integration-report-v1", provenance: "publisher_run_report", companyId: m.companyId,
    missionId: m.missionId, intentId: p.intentId, issueId: p.issueId, runId, repository: n5.authority.repository,
    url: p.targetUrl, candidateCommit: p.submission.candidateCommit, baseRef: n5.authority.baseRef, baseCommit: p.submission.baseCommit };
  if (!r || p.operation !== "integrate" || p.runId !== runId || Object.entries(bindings).some(([k, v]) => r[k as keyof IntegrationReport] !== v)
      || !Number.isFinite(Date.parse(r.observedAt)) || Date.now() - Date.parse(r.observedAt) > 300_000
      || Date.parse(r.observedAt) > Date.now() + 5000 || Date.parse(r.observedAt) < Date.parse(p.createdAt)
      || !["open", "merged"].includes(r.state) || typeof r.baseContainsIntegrated !== "boolean"
      || !Array.isArray(r.mergeParents) || r.mergeParents.length > 2 || r.mergeParents.some(s => !/^[a-f0-9]{40}$/.test(s))
      || !Array.isArray(r.checks) || r.checks.length > 100
      || r.checks.some(c => !c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 200
        || !["pending", "passed", "failed"].includes(c.state) || typeof c.evidenceUrl !== "string" || !/^https:\/\//.test(c.evidenceUrl) || c.evidenceUrl.length > 1000)
      || new Set(r.checks.map(c => c.name)).size !== r.checks.length
      || (r.state === "merged" ? !/^[a-f0-9]{40}$/.test(r.integratedCommit ?? "") : r.integratedCommit !== null)) {
    throw new MissionError(409, "integration_report_binding", "Fresh bounded report from the exact admitted publisher, repository, PR and accepted candidate required");
  }
  return structuredClone(r);
}

export function integrationReportState(contract: IntegrationContract, report: IntegrationReport) {
  if (report.state !== "merged") return "unknown" as const;
  const parents = contract.mergeMethod === "merge" ? [report.baseCommit, report.candidateCommit] : [report.baseCommit];
  if (!report.baseContainsIntegrated || canonicalPayloadHash(parents) !== canonicalPayloadHash(report.mergeParents)) return "failed" as const;
  const checks = contract.requiredChecks.map(name => report.checks.find(c => c.name === name));
  return checks.some(c => c?.state === "failed") ? "failed" as const
    : checks.every(c => c?.state === "passed") ? "verified" as const : "pending" as const;
}

export function integratedResult(m: MissionRecord) {
  const n5 = m.aggregate.n5, i = n5?.integration, p = n5?.publication;
  if (!i || !p || p.operation !== "integrate" || !p.settledAt || !i.report
      || i.reportHash !== canonicalPayloadHash(i.report) || i.report.candidateCommit !== p.submission.candidateCommit
      || m.aggregate.n2?.activeSubmissionId !== p.submission.submissionId || m.aggregate.n2.status !== "accepted") {
    throw new MissionError(409, "integrated_result_pending", "Exact merged commit, post-merge checks and terminal usage must be verified before another delivery or closure");
  }
  if (i.recovery?.originalCriteriaVerified) return { ...i.recovery.result, url: i.report.url, candidateCommit: p.submission.candidateCommit, recovery: i.recovery };
  if (i.state !== "verified" || integrationReportState(n5.authority.contract!.integration!, i.report) !== "verified") throw new MissionError(409, "integrated_result_pending", "Post-merge checks must establish the integrated result");
  return { protocol: "integrated-result-v1" as const, repository: n5.authority.repository, baseRef: n5.authority.baseRef,
    url: i.report.url, candidateCommit: i.report.candidateCommit, integratedCommit: i.report.integratedCommit!, reportHash: i.reportHash };
}

export function assertIntegratedLeafContract(m: MissionRecord, contract?: import("./pr-contract.js").PrContract) {
  if (contract?.integration && m.aggregate.hierarchy?.leaves?.length !== 1) throw new MissionError(422, "integration_one_leaf", "An integrated delivery must contain exactly one existing code leaf");
}
export function assertPublicationOperation(p: NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["publication"]>) {
  if (["integrate", "cancel-pr"].includes(p.operation ?? "")) throw new MissionError(409, "integration_commands_required", "A control run cannot claim publication or create another PR");
}
export function integrationAdmissionPending(m: MissionRecord) {
  const n5 = m.aggregate.n5;
  return Boolean(n5?.authority.contract?.integration && n5.publication?.settledAt && !n5.integration);
}
export function contributionStatusBeforeIntegration(m: MissionRecord) {
  return m.aggregate.projectMandate?.completion?.result === "integrated-verified" ? "blocked" : "done";
}
