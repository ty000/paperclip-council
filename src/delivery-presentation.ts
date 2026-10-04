export type DeliveryStatusTone = "neutral" | "attention" | "danger" | "success";

export type DeliveryPresentation = {
  status: { key: string; label: string; tone: DeliveryStatusTone };
  waitingReason: string | null;
  nextAction: { actorId: string | null; label: string };
  references: {
    plan: { documentId: string; revisionId: string } | null;
    pullRequest: { url: string; state: "draft" | "open" | "ready" | "closed" } | null;
  };
  details: {
    acceptedCandidateCommit: string | null;
    observedHeadSha: string | null;
    checksState: "unknown" | "pending" | "passed" | "failed" | null;
    reviewsState: "unknown" | "pending" | "approved" | "changes_requested" | null;
    nativeReadbackFresh: boolean;
  };
};

type DeliveryInspection = {
  plan?: { documentId?: string | null; revisionId?: string | null } | null;
  authority?: { publisherAgentId?: string | null } | null;
  publication?: {
    state?: "pending" | "unknown" | "opened" | string | null;
    submission?: { candidateCommit?: string | null } | null;
    observation?: {
      url?: string | null;
      headSha?: string | null;
      state?: string | null;
      draft?: boolean | null;
      matchesCandidate?: boolean | null;
    } | null;
    checks?: { headSha?: string | null; state?: "unknown" | "pending" | "passed" | "failed" | null } | null;
    reviews?: { headSha?: string | null; state?: "unknown" | "pending" | "approved" | "changes_requested" | null } | null;
  } | null;
  ready?: boolean | null;
  nativeReadbackFresh?: boolean | null;
  nextActor?: string | null;
  nextAction?: string | null;
};

type Status = DeliveryPresentation["status"];

const status = (key: string, label: string, tone: DeliveryStatusTone): Status => ({ key, label, tone });
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

/**
 * Converts the authoritative N5 inspection into display-only state. It never
 * reconstructs authority or readiness from a URL, a commit, or partial checks.
 */
export function projectDeliveryPresentation(n5: DeliveryInspection | null | undefined): DeliveryPresentation {
  const publication = n5?.publication;
  const observation = publication?.observation;
  const acceptedCandidateCommit = text(publication?.submission?.candidateCommit);
  const observedHeadSha = text(observation?.headSha);
  const checksState = publication?.checks?.state ?? null;
  const reviewsState = publication?.reviews?.state ?? null;
  const nativeReadbackFresh = n5?.nativeReadbackFresh === true;
  const planDocumentId = text(n5?.plan?.documentId);
  const planRevisionId = text(n5?.plan?.revisionId);
  const plan = planDocumentId && planRevisionId ? { documentId: planDocumentId, revisionId: planRevisionId } : null;
  const url = text(observation?.url);

  let current: Status;
  let waitingReason: string | null;

  if (!n5 || !plan || !n5.authority || !text(n5.authority.publisherAgentId)) {
    current = status("configuration_missing", "Delivery not configured", "neutral");
    waitingReason = "Publication authority and a bound native plan are required before delivery can begin.";
  } else if (!publication) {
    current = status("publication_not_admitted", "Waiting for publication", "neutral");
    waitingReason = "No publication intent has been admitted for the accepted candidate.";
  } else if (publication.state === "unknown") {
    current = status("publication_unknown", "Publication outcome unknown", "attention");
    waitingReason = "The publication effect is uncertain; inspect and reconcile it without repeating the effect.";
  } else if (publication.state === "pending") {
    current = status("publication_pending", "Publication pending", "attention");
    waitingReason = "The authorized publisher has not produced a confirmed native PR observation.";
  } else if (!observation || !url || !observedHeadSha) {
    current = status("observation_missing", "Waiting for PR readback", "attention");
    waitingReason = "An attributed native PR observation with its actual head commit is required.";
  } else if (observation.matchesCandidate !== true || !acceptedCandidateCommit || observedHeadSha !== acceptedCandidateCommit) {
    current = status("candidate_mismatch", "PR differs from accepted candidate", "danger");
    waitingReason = "The observed PR head does not match the independently accepted candidate.";
  } else if (observation.state !== "open") {
    current = status("pull_request_not_open", "PR is not open", "danger");
    waitingReason = "The observed pull request must be open before delivery can be ready.";
  } else if (observation.draft === true) {
    current = status("pull_request_draft", "PR is draft", "attention");
    waitingReason = "The observed pull request is still a draft.";
  } else if (!nativeReadbackFresh) {
    current = status("readback_stale", "PR readback is stale", "attention");
    waitingReason = "A fresh native GitHub observation is required; the stored snapshot is not current enough for readiness.";
  } else if (checksState === "failed") {
    current = status("checks_failed", "Checks failed", "danger");
    waitingReason = "Attributed checks for the observed PR head are failing.";
  } else if (checksState === null || checksState === "unknown" || checksState === "pending") {
    current = status("checks_waiting", checksState === "pending" ? "Checks pending" : "Checks unknown", "attention");
    waitingReason = checksState === "pending"
      ? "Attributed checks for the observed PR head are still pending."
      : "Passed checks attributed to the observed PR head have not been established.";
  } else if (publication.checks?.headSha !== observedHeadSha) {
    current = status("checks_head_mismatch", "Checks refer to another commit", "danger");
    waitingReason = "The passed checks are not attributed to the currently observed PR head.";
  } else if (reviewsState === "changes_requested") {
    current = status("reviews_changes_requested", "Changes requested", "danger");
    waitingReason = "Attributed review for the observed PR head requests changes.";
  } else if (reviewsState === null || reviewsState === "unknown" || reviewsState === "pending") {
    current = status("reviews_waiting", reviewsState === "pending" ? "Review pending" : "Review unknown", "attention");
    waitingReason = reviewsState === "pending"
      ? "Attributed review for the observed PR head is still pending."
      : "An approving review attributed to the observed PR head has not been established.";
  } else if (publication.reviews?.headSha !== observedHeadSha) {
    current = status("reviews_head_mismatch", "Review refers to another commit", "danger");
    waitingReason = "The approving review is not attributed to the currently observed PR head.";
  } else if (n5.ready !== true) {
    current = status("acceptance_not_current", "Waiting for authoritative readiness", "attention");
    waitingReason = "Council has not confirmed current acceptance, publisher settlement, and all delivery prerequisites.";
  } else {
    current = status("ready", "Ready for handoff", "success");
    waitingReason = null;
  }

  const fallbackAction = current.key === "ready"
    ? "PR handoff observed; merge is separate"
    : "Resolve the displayed delivery prerequisite through the authorized actor.";

  return {
    status: current,
    waitingReason,
    nextAction: { actorId: text(n5?.nextActor), label: text(n5?.nextAction) ?? fallbackAction },
    references: {
      plan,
      pullRequest: url ? {
        url,
        state: observation?.state !== "open"
          ? "closed"
          : current.key === "ready"
            ? "ready"
            : observation.draft === true
              ? "draft"
              : "open",
      } : null,
    },
    details: { acceptedCandidateCommit, observedHeadSha, checksState, reviewsState, nativeReadbackFresh },
  };
}
