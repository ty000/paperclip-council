import { createHash } from "node:crypto";
import type { MissionRecord } from "./missions.js";
import type { N2Submission } from "./n2-missions.js";

export type N5Plan = { documentId: string; revisionId: string; bodyHash: string; mandateHash: string;
  plannerAgentId: string; orchestratorAgentId: string; integrationLeadAgentId: string; qaAgentId: string };
export type N5State = {
  plan: N5Plan;
  authority: { publisherAgentId: string; repository: string; baseRef: string; headRef: string; authorizedBy: string; authorizedAt: string };
  planHistory?: Array<{ plan: N5Plan; reason: string; runId: string; at: string }>;
  continuation?: { requestId: string; reason: string; criteria: string[]; requestedBy: string; requestedAt: string;
    periodKey: string; previousApplication: NonNullable<MissionRecord["aggregate"]["n2"]>["application"];
    previousPlan: N5Plan; previousPublication: NonNullable<N5State["publication"]>;
    reopen: { state: "claimed"; reservationId: string }; updateAdmitted?: boolean };
  publication?: { intentId: string; submission: N2Submission; issueId: string | null; runId: string | null;
    operation?: "create" | "update"; targetUrl?: string;
    reservationId: string; settlementCommandId: string; settledAt?: string;
    createdAt: string; claimedAt?: string; creation: "claimed" | "confirmed"; wake: "pending" | "claimed";
    state: "pending" | "unknown" | "opened"; claimCommandId?: string;
    readbackUnavailable?: string;
    observation?: { observedAt: string; objectId: string; workProductId: string; documentRevisionId: string;
      url: string; headSha: string; baseRef: string; headRef: string; state: string; draft: boolean; lastResolvedAt: string;
      matchesCandidate: boolean };
    checks?: { headSha: string; state: "unknown" | "pending" | "passed" | "failed"; evidenceRefs: string[]; observedAt: string; agentId: string | null; userId?: string | null; runId: string | null };
    reviews?: { headSha: string; state: "unknown" | "pending" | "approved" | "changes_requested"; evidenceRefs: string[]; observedAt: string; agentId: string | null; userId?: string | null; runId: string | null };
  };
};

function currentAcceptance(mission: MissionRecord, p: NonNullable<N5State["publication"]>) {
  const n2 = mission.aggregate.n2;
  return n2?.status === "accepted" && n2.activeSubmissionId === p.submission.submissionId
    && p.submission.mandateHash === createHash("sha256").update(JSON.stringify(mission.aggregate.mandate)).digest("hex");
}

export function inspectN5(mission: MissionRecord) {
  const n5 = mission.aggregate.n5;
  if (!n5) return null;
  const p = n5.publication; const o = p?.observation;
  const fresh = Boolean(o && !p?.readbackUnavailable && Date.now() - Date.parse(o.lastResolvedAt) <= 300_000);
  const ready = Boolean(o && p && currentAcceptance(mission, p) && fresh && o.matchesCandidate && o.state === "open" && !o.draft
    && p?.checks?.headSha === o.headSha && p.checks.state === "passed"
    && p?.reviews?.headSha === o.headSha && p.reviews.state === "approved");
  const correcting = n5.continuation && mission.aggregate.n2?.status !== "accepted";
  const n2 = mission.aggregate.n2;
  const waitingForOwner = correcting && !n2?.correction?.runId;
  const reviewing = correcting && (n2?.status === "review_handoff" || n2?.status === "reviewing");
  return { ...n5, ready, nativeReadbackFresh: fresh, checksSource: "attributed_actor_observation", reviewsSource: "attributed_actor_observation",
    nextActor: waitingForOwner ? mission.ownerUserId : reviewing ? n5.plan.qaAgentId : correcting ? n5.plan.integrationLeadAgentId
      : !p ? mission.ownerUserId : o && !o.matchesCandidate ? n5.plan.integrationLeadAgentId : n5.authority.publisherAgentId,
    nextAction: waitingForOwner ? "Owner executes the persisted native resume action once; inspect an uncertain result before proceeding"
      : reviewing ? "Complete the fresh independent N2/N3 review of the corrected candidate"
      : correcting ? "Complete the admitted native correction and plan revision under the unchanged mandate"
      : !p ? "Admit the authorized publisher after exact acceptance and settlement" : o && !o.matchesCandidate
      ? "Owner may request the remaining bounded correction on this mission; independent N2/N3 acceptance precedes an update to this PR"
      : ready ? "PR handoff observed; merge is separate" : "Resolve native PR readback and attributed checks/reviews; never repeat an uncertain publication effect" };
}
