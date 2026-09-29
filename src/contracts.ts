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

type CouncilDecisionCommon = {
  companyId: string;
  issueId: string;
  runId: string;
  justification: string;
  resultReference: string;
};

export type CouncilDecisionPayload = {
  verdict: "changes_requested";
  approvedCommit?: never;
  justification: string;
  resultReference: string;
} | {
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
};
