import { z } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bounded = z.string().trim().min(1).max(4_000);

export type CampaignCoverageSource = {
  criterionId: string;
  kind: "criterion" | "commitment" | "campaign-root" | "milestone-root" | "milestone-node" | "prd" | "tad";
  label: string;
  sourceSha256: string;
  sourceDocument?: { issueId: string; key: string; revisionId: string; bodySha256: string; selector?: string };
};

export type CampaignDeliveryResult = {
  resultId: string;
  sourceId: string;
  missionId: string;
  issueId: string;
  proofId: string;
  completionDocument: { key: string; revisionId: string; bodySha256: string };
  integratedResult: Record<string, unknown>;
  integratedResultSha256: string;
};

export type CampaignClosureSubject = {
  schema: "council-linear-campaign-review-subject-v1";
  campaignRootMissionId: string;
  sourceSha256: string;
  mandateSha256: string;
  coverageSha256: string;
  resultsSha256: string;
  coverage: CampaignCoverageSource[];
  results: CampaignDeliveryResult[];
  priorPublicationSha256s: string[];
  allowedProofIds: string[];
};

export const campaignReviewRowSchema = z.object({
  criterionId: z.string().trim().min(1).max(200),
  sourceSha256: digest,
  deliveryOrObligationIds: z.array(z.string().trim().min(1).max(200)).min(1).max(33),
  verification: z.object({ environment: bounded, method: bounded }).strict(),
  result: z.enum(["satisfied", "unsatisfied", "unknown"]),
  proofIds: z.array(z.string().trim().min(1).max(200)).max(64),
  remainder: z.string().trim().min(1).max(4_000).nullable(),
}).strict();

export const campaignReviewReportSchema = z.object({
  schema: z.literal("council-linear-campaign-review-report-v1"),
  campaignRootMissionId: z.string().uuid(),
  taskId: z.string().uuid(),
  sourceSha256: digest,
  mandateSha256: digest,
  coverageSha256: digest,
  resultsSha256: digest,
  verdict: z.enum(["approved", "blocked"]),
  rows: z.array(campaignReviewRowSchema).min(1).max(64),
}).strict();

export type CampaignReviewReport = z.infer<typeof campaignReviewReportSchema>;

export type CampaignReviewTask = {
  taskId: string;
  agentId: string;
  issueId: string | null;
  creation: "pending" | "claimed" | "confirmed";
  reservationId: string;
  settlementCommandId: string;
  runId: string | null;
  wake: "pending" | "claimed";
  settledAt?: string;
};

export type CampaignClosureState = {
  protocol: "council-linear-campaign-closure-v1";
  phase: "reviewing" | "blocked" | "reviewed" | "publishing" | "closing" | "closed" | "cancelled";
  subject: CampaignClosureSubject;
  task: CampaignReviewTask;
  report?: CampaignReviewReport;
  reportSha256?: string;
  blockedReason?: string;
  proofDocument: { key: string; body: string; revisionId?: string };
  publicationIntentId?: string;
  publicationPayloadSha256?: string;
  publicationAcknowledgedAt?: string;
  nativeClosures: Array<{ issueId: string; state: "pending" | "claimed" | "confirmed" }>;
  completedAt?: string;
};

export function validateCampaignReviewReport(subject: CampaignClosureSubject, taskId: string, value: unknown): CampaignReviewReport {
  const parsed = campaignReviewReportSchema.safeParse(value);
  if (!parsed.success) throw new MissionError(409, "campaign_review_report", "The exact bounded terminal campaign review report is required");
  const report = parsed.data;
  const expected = { campaignRootMissionId: subject.campaignRootMissionId, taskId,
    sourceSha256: subject.sourceSha256, mandateSha256: subject.mandateSha256,
    coverageSha256: subject.coverageSha256, resultsSha256: subject.resultsSha256 };
  if (Object.entries(expected).some(([key, expectedValue]) => report[key as keyof typeof report] !== expectedValue)) {
    throw new MissionError(409, "campaign_review_subject_changed", "The terminal verdict does not match the exact current source, mandate, coverage and results");
  }
  const coverage = new Map(subject.coverage.map(item => [item.criterionId, item]));
  if (coverage.size !== subject.coverage.length || report.rows.length !== coverage.size
      || new Set(report.rows.map(row => row.criterionId)).size !== report.rows.length) {
    throw new MissionError(409, "campaign_review_coverage", "Every source criterion and transverse obligation must appear exactly once");
  }
  const deliveryIds = new Set([...subject.results.map(result => result.resultId), "transverse:campaign"]);
  const proofIds = new Set(subject.allowedProofIds);
  for (const row of report.rows) {
    const item = coverage.get(row.criterionId);
    if (!item || item.sourceSha256 !== row.sourceSha256
        || row.deliveryOrObligationIds.some(id => !deliveryIds.has(id))
        || row.proofIds.some(id => !proofIds.has(id))) {
      throw new MissionError(409, "campaign_review_coverage", "Coverage rows may reference only the pinned sources, deliveries and current proofs");
    }
    const satisfied = row.result === "satisfied";
    if (satisfied !== (row.proofIds.length > 0 && row.remainder === null)) {
      throw new MissionError(409, "campaign_review_result", "Satisfied rows need current proof and no remainder; every other row needs an explicit remainder");
    }
  }
  const complete = report.rows.every(row => row.result === "satisfied");
  if ((report.verdict === "approved") !== complete) {
    throw new MissionError(409, "campaign_review_verdict", "Approval requires complete current coverage; incomplete coverage must block without automatic correction");
  }
  return report;
}

export function campaignClosureFingerprint(subject: CampaignClosureSubject) {
  return canonicalPayloadHash({ sourceSha256: subject.sourceSha256, mandateSha256: subject.mandateSha256,
    coverageSha256: subject.coverageSha256, resultsSha256: subject.resultsSha256 });
}
