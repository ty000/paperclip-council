import type { MissionRecord } from "./missions.js";
import type { N2Submission } from "./n2-missions.js";

export type N5Plan = { documentId: string; revisionId: string; bodyHash: string; mandateHash: string;
  plannerAgentId: string; orchestratorAgentId: string; integrationLeadAgentId: string; qaAgentId: string };
export type N5State = {
  plan: N5Plan;
  authority: { publisherAgentId: string; repository: string; baseRef: string; headRef: string; authorizedBy: string; authorizedAt: string };
  publication?: { intentId: string; submission: N2Submission; issueId: string | null; runId: string | null;
    reservationId: string; settlementCommandId: string; settledAt?: string;
    createdAt: string; claimedAt?: string; creation: "claimed" | "confirmed"; wake: "pending" | "claimed";
    state: "pending" | "unknown" | "opened"; claimCommandId?: string;
    observation?: { observedAt: string; objectId: string; workProductId: string; documentRevisionId: string;
      url: string; headSha: string; baseRef: string; headRef: string; state: string; draft: boolean; lastResolvedAt: string;
      matchesCandidate: boolean };
    checks?: { headSha: string; state: "unknown" | "pending" | "passed" | "failed"; evidenceRefs: string[]; observedAt: string; agentId: string; runId: string };
    reviews?: { headSha: string; state: "unknown" | "pending" | "approved" | "changes_requested"; evidenceRefs: string[]; observedAt: string; agentId: string; runId: string };
  };
};

export function inspectN5(mission: MissionRecord) {
  const n5 = mission.aggregate.n5;
  if (!n5) return null;
  const p = n5.publication; const o = p?.observation;
  const fresh = Boolean(o && Date.now() - Date.parse(o.lastResolvedAt) <= 300_000);
  const ready = Boolean(o && fresh && o.matchesCandidate && o.state === "open" && !o.draft
    && p?.checks?.headSha === o.headSha && p.checks.state === "passed"
    && p?.reviews?.headSha === o.headSha && p.reviews.state === "approved");
  return { ...n5, ready, nativeReadbackFresh: fresh, checksSource: "attributed_agent_observation", reviewsSource: "attributed_agent_observation",
    nextActor: !p ? mission.ownerUserId : o && !o.matchesCandidate ? n5.plan.integrationLeadAgentId : n5.authority.publisherAgentId,
    nextAction: !p ? "Admit the authorized publisher after exact acceptance and settlement" : o && !o.matchesCandidate
      ? "Create a linked correction attempt and independently accept its changed candidate; preserve historical N2" : ready ? "PR handoff observed; merge is separate" : "Resolve native PR readback and attributed checks/reviews; never repeat an uncertain create" };
}
