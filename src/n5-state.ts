import { n5Readiness } from "./n5-readiness.js";
import type { MissionRecord } from "./missions.js";
import type { N2Submission } from "./n2-missions.js";

export type N5Plan = { documentId: string; revisionId: string; bodyHash: string; mandateHash: string; documentKey?: string;
  plannerAgentId: string; orchestratorAgentId: string; integrationLeadAgentId: string; qaAgentId: string };
export type N5State = {
  plan: N5Plan;
  authority: { publisherAgentId: string; repository: string; baseRef: string; headRef: string; authorizedBy: string; authorizedAt: string;
    publisherPreflight?: "publisher-run-report-v1"; contract?: import("./pr-contract.js").PrContract };
  feedback?: import("./pr-contract.js").PublicationFeedback;
  feedbackHistory?: import("./pr-contract.js").PublicationFeedback[];
  planHistory?: Array<{ plan: N5Plan; reason: string; runId: string; at: string }>;
  continuation?: { requestId: string; reason: string; criteria: string[]; requestedBy: string; requestedAt: string;
    delegatedFeedback?: boolean; periodKey: string; previousApplication: NonNullable<MissionRecord["aggregate"]["n2"]>["application"];
    previousPlan: N5Plan; previousPublication: NonNullable<N5State["publication"]>;
    reopen: { state: "claimed"; reservationId: string }; updateAdmitted?: boolean };
  publication?: { intentId: string; submission: N2Submission; issueId: string | null; runId: string | null;
    operation?: "create" | "update"; targetUrl?: string;
    reservationId: string; settlementCommandId: string; settledAt?: string;
    createdAt: string; claimedAt?: string; creation: "preparing" | "claimed" | "confirmed"; wake: "pending" | "claimed";
    state: "pending" | "unknown" | "opened"; claimCommandId?: string;
    readbackUnavailable?: string;
    feedbackReport?: import("./pr-contract.js").GithubFeedback;
    preflight?: import("./n5-publisher-preflight.js").PublisherPreflight;
    observation?: { observedAt: string; objectId: string; workProductId: string; documentRevisionId: string;
      url: string; headSha: string; baseRef: string; headRef: string; state: string; draft: boolean; lastResolvedAt: string;
      matchesCandidate: boolean };
    checks?: { headSha: string; state: "unknown" | "pending" | "passed" | "failed"; evidenceRefs: string[]; observedAt: string; agentId: string | null; userId?: string | null; runId: string | null };
    reviews?: { headSha: string; state: "unknown" | "pending" | "approved" | "changes_requested"; evidenceRefs: string[]; observedAt: string; agentId: string | null; userId?: string | null; runId: string | null };
  };
};

export function inspectN5(mission: MissionRecord) {
  const n5 = mission.aggregate.n5;
  if (!n5) return null;
  const readiness = n5Readiness(mission, n5);
  const source = n5.authority.contract ? "publisher_run_report" : "attributed_actor_observation";
  return { ...n5, ...readiness, checksSource: source, reviewsSource: source, ...nextDeliveryAction(mission, n5, readiness.ready) };
}

function nextDeliveryAction(mission: MissionRecord, n5: N5State, ready: boolean) {
  const n2 = mission.aggregate.n2; const p = n5.publication;
  if (n5.continuation && n2?.status !== "accepted") {
    if (!n2?.correction?.runId) return { nextActor: mission.ownerUserId, nextAction: "Use the original one-shot owner resume response; inspect native root/run after an attempted or uncertain resume, never repeat it" };
    if (n2.status === "review_handoff" || n2.status === "reviewing") return { nextActor: n5.plan.qaAgentId, nextAction: "Complete the fresh independent N2/N3 review of the corrected candidate" };
    return { nextActor: n5.plan.integrationLeadAgentId, nextAction: "Complete the admitted native correction and plan revision under the unchanged mandate" };
  }
  if (!p) return { nextActor: mission.ownerUserId, nextAction: "Admit the authorized publisher after exact acceptance and settlement" };
  if (p.observation && !p.observation.matchesCandidate) return { nextActor: n5.plan.integrationLeadAgentId,
    nextAction: "Owner may request the remaining bounded correction on this mission; independent N2/N3 acceptance precedes an update to this PR" };
  return { nextActor: n5.authority.publisherAgentId,
    nextAction: ready ? "PR handoff observed; merge is separate" : "Resolve native PR readback and attributed checks/reviews; never repeat an uncertain publication effect" };
}
