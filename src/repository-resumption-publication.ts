import type { MissionRecord } from "./missions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";

export type RepositoryResumption = { commandId: string; payloadHash: string; ownerUserId: string;
  policyRevisionId: string; resumedAt: string; heldIntakeVersion: number;
  decision?: { question: string; questionAuthor: "Council"; response: string; consequences: string } };
type State = { repositoryResumptions?: RepositoryResumption[] };

/** Only the latest authorization releases this hold; earlier attempts remain in the intake journal. */
export function repositoryResumptionPublication(state: State) {
  const resumption = state.repositoryResumptions?.at(-1);
  if (!resumption) return {};
  const decision = resumption.decision;
  if (!decision?.question || !decision.response || !decision.consequences || decision.questionAuthor !== "Council") {
    throw new MissionError(409, "repository_resume_decision_missing", "Retain the historical recovery; an explicit recorded decision is required before publishing a fixed campaign plan");
  }
  const text = `Reprise après occupation du dépôt — ${resumption.commandId}\nQuestion (${decision.questionAuthor}) : ${decision.question}\nRéponse de ${resumption.ownerUserId} : ${decision.response}\nConséquences : ${decision.consequences}`;
  // Intake's existing text renderer preserves at most 4,000 characters.
  if (text.length > 4000) throw new MissionError(422, "repository_resume_decision_bound", "The complete recovery decision must fit the existing Linear publication text bound");
  return { repositoryResumption: resumption, text };
}

/** The existing plan and its receipt own the decision; never replace an already emitted plan. */
export function assertRepositoryResumptionPlan(m: MissionRecord, state: State, requireAcknowledgement = true) {
  if (m.aggregate.linearContinuity?.mode !== FIXED_CAMPAIGN_MODE || !state.repositoryResumptions?.length) return;
  const expected = repositoryResumptionPublication(state);
  const plans = m.aggregate.linearContinuity.publications.filter(publication => publication.payload.campaignPlan);
  const plan = plans[0];
  if (plans.length !== 1 || !plan || plan.withdrawn || requireAcknowledgement && !plan.acknowledgement
      || canonicalPayloadHash(plan.payload.repositoryResumption ?? null) !== canonicalPayloadHash(expected.repositoryResumption)
      || plan.payload.text !== expected.text) {
    throw new MissionError(409, "repository_resume_publication_pending", "The original campaign plan must publish and confirm the exact retained recovery decision before dependent work");
  }
}
