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

export type CouncilDecisionInput = {
  companyId: string;
  issueId: string;
  runId: string;
  verdict: CouncilVerdict;
  justification: string;
  resultReference: string;
};

export type CouncilDecisionResult = {
  verdict: CouncilVerdict;
  requestedIssueStatus: "in_progress" | "done";
  nativeStatus: number;
  nativeResponse: unknown;
};
