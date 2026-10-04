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

type Publication = NonNullable<DeliveryInspection["publication"]>;
type DeliveryState = Pick<DeliveryPresentation, "status" | "waitingReason">;

const state = (key: string, label: string, tone: DeliveryStatusTone, waitingReason: string | null): DeliveryState =>
  ({ status: { key, label, tone }, waitingReason });
const text = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;

function deliveryDetails(n5: DeliveryInspection | null | undefined): DeliveryPresentation["details"] {
  const publication = n5?.publication;
  return {
    acceptedCandidateCommit: text(publication?.submission?.candidateCommit),
    observedHeadSha: text(publication?.observation?.headSha),
    checksState: publication?.checks?.state ?? null,
    reviewsState: publication?.reviews?.state ?? null,
    nativeReadbackFresh: n5?.nativeReadbackFresh === true,
  };
}

function publicationState(n5: DeliveryInspection | null | undefined, plan: DeliveryPresentation["references"]["plan"]): DeliveryState | null {
  if (!n5 || !plan || !n5.authority || !text(n5.authority.publisherAgentId)) {
    return state("configuration_missing", "Delivery not configured", "neutral",
      "Publication authority and a bound native plan are required before delivery can begin.");
  }
  const publication = n5.publication;
  if (!publication) return state("publication_not_admitted", "Waiting for publication", "neutral",
    "No publication intent has been admitted for the accepted candidate.");
  if (publication.state === "unknown") return state("publication_unknown", "Publication outcome unknown", "attention",
    "The publication effect is uncertain; inspect and reconcile it without repeating the effect.");
  if (publication.state === "pending") return state("publication_pending", "Publication pending", "attention",
    "The authorized publisher has not produced a confirmed native PR observation.");
  return null;
}

function candidateState(publication: Publication, details: DeliveryPresentation["details"]): DeliveryState | null {
  const observation = publication.observation;
  if (!observation || !text(observation.url) || !details.observedHeadSha) {
    return state("observation_missing", "Waiting for PR readback", "attention",
      "An attributed native PR observation with its actual head commit is required.");
  }
  if (observation.matchesCandidate !== true || !details.acceptedCandidateCommit || details.observedHeadSha !== details.acceptedCandidateCommit) {
    return state("candidate_mismatch", "PR differs from accepted candidate", "danger",
      "The observed PR head does not match the independently accepted candidate.");
  }
  if (observation.state !== "open") return state("pull_request_not_open", "PR is not open", "danger",
    "The observed pull request must be open before delivery can be ready.");
  if (observation.draft === true) return state("pull_request_draft", "PR is draft", "attention",
    "The observed pull request is still a draft.");
  if (!details.nativeReadbackFresh) return state("readback_stale", "PR readback is stale", "attention",
    "A fresh native GitHub observation is required; the stored snapshot is not current enough for readiness.");
  return null;
}

function checksState(publication: Publication, details: DeliveryPresentation["details"]): DeliveryState | null {
  if (details.checksState === "failed") return state("checks_failed", "Checks failed", "danger",
    "Attributed checks for the observed PR head are failing.");
  if (details.checksState === "pending") return state("checks_waiting", "Checks pending", "attention",
    "Attributed checks for the observed PR head are still pending.");
  if (details.checksState === null || details.checksState === "unknown") return state("checks_waiting", "Checks unknown", "attention",
    "Passed checks attributed to the observed PR head have not been established.");
  if (publication.checks?.headSha !== details.observedHeadSha) return state("checks_head_mismatch", "Checks refer to another commit", "danger",
    "The passed checks are not attributed to the currently observed PR head.");
  return null;
}

function reviewsState(publication: Publication, details: DeliveryPresentation["details"]): DeliveryState | null {
  if (details.reviewsState === "changes_requested") return state("reviews_changes_requested", "Changes requested", "danger",
    "Attributed review for the observed PR head requests changes.");
  if (details.reviewsState === "pending") return state("reviews_waiting", "Review pending", "attention",
    "Attributed review for the observed PR head is still pending.");
  if (details.reviewsState === null || details.reviewsState === "unknown") return state("reviews_waiting", "Review unknown", "attention",
    "An approving review attributed to the observed PR head has not been established.");
  if (publication.reviews?.headSha !== details.observedHeadSha) return state("reviews_head_mismatch", "Review refers to another commit", "danger",
    "The approving review is not attributed to the currently observed PR head.");
  return null;
}

function planReference(plan: DeliveryInspection["plan"]): DeliveryPresentation["references"]["plan"] {
  const documentId = text(plan?.documentId);
  const revisionId = text(plan?.revisionId);
  return documentId && revisionId ? { documentId, revisionId } : null;
}

function pullRequestReference(observation: Publication["observation"], ready: boolean): DeliveryPresentation["references"]["pullRequest"] {
  const url = text(observation?.url);
  if (!url) return null;
  if (observation?.state !== "open") return { url, state: "closed" };
  if (ready) return { url, state: "ready" };
  return { url, state: observation.draft === true ? "draft" : "open" };
}

/**
 * Converts the authoritative N5 inspection into display-only state. It never
 * reconstructs authority or readiness from a URL, a commit, or partial checks.
 */
export function projectDeliveryPresentation(n5: DeliveryInspection | null | undefined): DeliveryPresentation {
  const publication = n5?.publication ?? {};
  const details = deliveryDetails(n5);
  const plan = planReference(n5?.plan);
  const current = publicationState(n5, plan)
    ?? candidateState(publication, details)
    ?? checksState(publication, details)
    ?? reviewsState(publication, details)
    ?? (n5?.ready === true
      ? state("ready", "Ready for handoff", "success", null)
      : state("acceptance_not_current", "Waiting for authoritative readiness", "attention",
        "Council has not confirmed current acceptance, publisher settlement, and all delivery prerequisites."));

  const ready = current.status.key === "ready";
  const fallbackAction = ready
    ? "PR handoff observed; merge is separate"
    : "Resolve the displayed delivery prerequisite through the authorized actor.";

  return {
    ...current,
    nextAction: { actorId: text(n5?.nextActor), label: text(n5?.nextAction) ?? fallbackAction },
    references: {
      plan,
      pullRequest: pullRequestReference(publication.observation, ready),
    },
    details,
  };
}
