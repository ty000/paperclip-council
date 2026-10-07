import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { MissionError } from "./mission-primitives.js";
import { n2Cas, nativeN2Profile } from "./n2-missions.js";
import { acceptedN5Submission } from "./n5-preflight.js";
import { assertContinuityDeparture } from "./continuity-policy.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { prepareFeedbackReview } from "./pr-feedback.js";

export async function reconcilePublicationFeedback(ctx: PluginContext, m: MissionRecord) {
  const n5 = m.aggregate.n5, p = n5?.publication;
  if (!n5?.authority.contract || !p?.settledAt) return m;
  if (!p.observation || p.readbackUnavailable) return m;
  if (!p.observation.matchesCandidate || p.observation.state !== "open" || p.observation.draft !== n5.authority.contract.draftOnly) {
    throw new MissionError(409, "pr_contract_violated", "Native PR must retain the authorized draft state, URL, repository and accepted candidate; no repair write or second publication is delegated");
  }
  const changed = p.checks?.state === "failed" || p.reviews?.state === "changes_requested";
  if (n5.feedback?.state === "resolved" && n2SameFeedbackAcceptance(m)) {
    // Re-review accepted the unchanged candidate; rebind the exact acceptance but preserve remote objections.
    const submission = acceptedN5Submission(m);
    m = await n2Cas(ctx, m, { ...m.aggregate, n5: { ...n5, publication: { ...p, submission } } });
    if (changed) throw new MissionError(409, "pr_feedback_unresolved", "Council accepted unchanged evidence but GitHub still requests changes; retain both judgments and ask the owner");
    return m;
  }
  if (!changed) return m;
  if (n5.feedback?.state === "reviewing") return m;
  acceptedN5Submission(m); assertContinuityDeparture(m); await assertProjectDeparture(ctx, m); await nativeN2Profile(ctx, m);
  return n2Cas(ctx, m, prepareFeedbackReview(m));
}
function n2SameFeedbackAcceptance(m: MissionRecord) {
  const n5 = m.aggregate.n5!;
  return m.aggregate.n2?.activeSubmissionId === n5.feedback?.reviewSubmissionId && n5.publication?.submission.submissionId !== n5.feedback?.reviewSubmissionId;
}
