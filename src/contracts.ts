export type SecretRef = {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
};

export type CouncilConfig = {
  apiBaseUrl: string;
  councilAgentId: string;
  councilApiKey: SecretRef;
};

export type CouncilVerdict = "changes_requested" | "approved";

export type NativeReviewBinding = {
  interactionId: string;
  decisionId: string;
  sourceRunId: string;
};

type CouncilDecisionCommon = {
  companyId: string;
  issueId: string;
  actorAgentId: string;
  runId: string;
  justification: string;
  resultReference: string;
  nativeReview?: NativeReviewBinding;
};

export type CouncilDecisionPayload = {
  operationId: string;
  verdict: "changes_requested";
  approvedCommit?: never;
  justification: string;
  resultReference: string;
} | {
  operationId: string;
  verdict: "approved";
  approvedCommit: string;
  justification: string;
  resultReference: string;
};

export type CouncilDecisionInput = CouncilDecisionCommon & CouncilDecisionPayload;

export type CouncilDecisionResult = {
  verdict: CouncilVerdict;
  requestedIssueStatus: "in_progress" | "done";
  nativeStatus: number;
  nativeResponse: unknown;
  nativeBodyValid: boolean;
  nativeBodyTruncated: boolean;
};
