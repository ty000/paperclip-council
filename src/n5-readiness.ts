import { githubFeedbackStates } from "./pr-contract.js";
import { canonicalPayloadHash } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { N5State } from "./n5-state.js";
type Publication = NonNullable<N5State["publication"]>;

function currentAcceptance(m: MissionRecord, p: Publication) {
  const n2 = m.aggregate.n2;
  return n2?.status === "accepted" && n2.activeSubmissionId === p.submission.submissionId
    && p.submission.mandateHash === canonicalPayloadHash(m.aggregate.mandate);
}
function exactChecksAndReviews(p: Publication) {
  if (!p.observation || !p.checks || !p.reviews) return false;
  return p.checks.headSha === p.observation.headSha && p.checks.state === "passed"
    && p.reviews.headSha === p.observation.headSha && p.reviews.state === "approved";
}
function publicationReady(n5: N5State, p: Publication, common: boolean, contractConformant: boolean) {
  if (!n5.authority.contract || !p.feedbackReport || !p.observation) return false;
  const states = githubFeedbackStates(n5.authority.contract, p.feedbackReport);
  return Boolean(states.checks === "passed" && states.reviews === "approved" && common && contractConformant && p.settledAt && exactChecksAndReviews(p)
    && p.feedbackReport.headSha === p.observation.headSha && Date.now() - Date.parse(p.feedbackReport.observedAt) <= 300_000);
}
export function n5Readiness(m: MissionRecord, n5: N5State) {
  const p = n5.publication, o = p?.observation;
  if (!p || !o) return { ready: false, mergeReady: false, publicationReady: false, contractConformant: false, nativeReadbackFresh: false };
  const fresh = !p.readbackUnavailable && Date.now() - Date.parse(o.lastResolvedAt) <= 300_000;
  const common = Boolean(fresh && o.matchesCandidate && o.state === "open" && currentAcceptance(m, p));
  const settled = !m.aggregate.n2?.ordinary || Boolean(p.settledAt);
  const mergeReady = common && settled && !o.draft && exactChecksAndReviews(p);
  const contractConformant = Boolean(fresh && o.matchesCandidate && o.state === "open"
    && (!n5.authority.contract || o.draft === n5.authority.contract.draftOnly));
  const deliveryReady = publicationReady(n5, p, common, contractConformant);
  return { ready: n5.authority.contract ? deliveryReady : mergeReady, mergeReady: n5.authority.contract ? deliveryReady && !o.draft : mergeReady, publicationReady: deliveryReady, contractConformant, nativeReadbackFresh: fresh };
}
