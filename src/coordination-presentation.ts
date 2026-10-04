export type CoordinationStatusTone = "neutral" | "attention" | "danger" | "success";

export type CoordinationCandidateIdentity = {
  submissionId: string | null;
  candidateCommit: string | null;
  bundleSha256: string | null;
  evidenceRevision: number | null;
  mandateHash: string | null;
};

export type CoordinationPresentation = {
  status: { key: string; label: string; tone: CoordinationStatusTone };
  waitingReason: string | null;
  source: {
    sourceMissionId: string | null;
    sourceRootIssueId: string | null;
    expectedCandidate: CoordinationCandidateIdentity;
    verifiedCandidate: CoordinationCandidateIdentity;
  };
  delegation: {
    state: string | null;
    coordinatorAgentId: string | null;
    priority: string | null;
    reason: string | null;
  };
  nextAction: { actorId: string | null; label: string };
  boundaries: {
    acceptedResult: string;
    settledUsage: string;
    publicationRequired: boolean | null;
  };
};

type CandidateIdentityInput = {
  submissionId?: unknown;
  candidateCommit?: unknown;
  bundleSha256?: unknown;
  evidenceRevision?: unknown;
  mandateHash?: unknown;
};

type CoordinationInspection = {
  state?: unknown;
  blockage?: unknown;
  sourceMissionId?: unknown;
  sourceRootIssueId?: unknown;
  expectedResult?: CandidateIdentityInput | null;
  verifiedArtifact?: {
    expectedResult?: CandidateIdentityInput | null;
  } | null;
  coordination?: {
    state?: unknown;
    coordinatorAgentId?: unknown;
    priority?: unknown;
    reason?: unknown;
  } | null;
  nextActor?: unknown;
  nextAction?: unknown;
  publicationRequired?: unknown;
};

type CoordinationStatus = Pick<CoordinationPresentation, "status">;

const status = (key: string, label: string, tone: CoordinationStatusTone): CoordinationStatus =>
  ({ status: { key, label, tone } });
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;

const EMPTY_CANDIDATE: CoordinationCandidateIdentity = {
  submissionId: null,
  candidateCommit: null,
  bundleSha256: null,
  evidenceRevision: null,
  mandateHash: null,
};

function candidateIdentity(value: CandidateIdentityInput | null | undefined): CoordinationCandidateIdentity {
  if (!value) return { ...EMPTY_CANDIDATE };
  return {
    submissionId: text(value.submissionId),
    candidateCommit: text(value.candidateCommit),
    bundleSha256: text(value.bundleSha256),
    evidenceRevision: integer(value.evidenceRevision),
    mandateHash: text(value.mandateHash),
  };
}

function coordinationStatus(n6: CoordinationInspection | null | undefined): CoordinationStatus {
  if (!n6) return status("inspection_missing", "Coordination unavailable", "neutral");
  if (n6.state === "started") return status("started", "Downstream mission started", "success");

  const blockage = text(n6.blockage);
  if (blockage === "n6_result_mismatch" || blockage?.includes("mismatch")) {
    return status("source_mismatch", "Accepted source changed", "danger");
  }

  switch (n6.coordination?.state) {
    case "owner_required": return status("owner_required", "Owner decision required", "attention");
    case "held": return status("held", "Coordination held", "attention");
    case "released": return status("released", "Coordination released", "neutral");
  }
  if (n6.state === "verified") return status("verified", "Accepted source verified", "success");
  return status("waiting", "Waiting for accepted source", "attention");
}

/**
 * Converts the authoritative N6 inspection into display-only coordination
 * state. It deliberately does not infer acceptance, accounting settlement,
 * release eligibility, publication, or downstream readiness.
 */
export function projectCoordinationPresentation(
  n6: CoordinationInspection | null | undefined,
): CoordinationPresentation {
  const current = coordinationStatus(n6);
  const blockage = text(n6?.blockage);
  const coordinationReason = text(n6?.coordination?.reason);
  const fallbackAction = n6?.state === "started"
    ? "Continue the admitted downstream mission."
    : "Wait for the authorized actor to complete the displayed prerequisite.";

  return {
    ...current,
    waitingReason: blockage ?? coordinationReason,
    source: {
      sourceMissionId: text(n6?.sourceMissionId),
      sourceRootIssueId: text(n6?.sourceRootIssueId),
      expectedCandidate: candidateIdentity(n6?.expectedResult),
      verifiedCandidate: candidateIdentity(n6?.verifiedArtifact?.expectedResult),
    },
    delegation: {
      state: text(n6?.coordination?.state),
      coordinatorAgentId: text(n6?.coordination?.coordinatorAgentId),
      priority: text(n6?.coordination?.priority),
      reason: coordinationReason,
    },
    nextAction: {
      actorId: text(n6?.nextActor),
      label: text(n6?.nextAction) ?? fallbackAction,
    },
    boundaries: {
      acceptedResult: "Exact accepted predecessor result required",
      settledUsage: "All referenced source usage must be settled and exposure-free",
      publicationRequired: typeof n6?.publicationRequired === "boolean" ? n6.publicationRequired : null,
    },
  };
}
