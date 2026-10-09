import { githubFeedbackStates } from "./pr-contract.js";
import { createHash } from "node:crypto";
import type { MissionRecord } from "./missions.js";
import type { N5State } from "./n5-state.js";
type Publication = NonNullable<N5State["publication"]>;
const feedback = (p: Publication) => p.controllerFeedbackReport ?? p.feedbackReport;

function currentAcceptance(m: MissionRecord, p: Publication) {
  const n2 = m.aggregate.n2;
  return n2?.status === "accepted" && n2.activeSubmissionId === p.submission.submissionId
    && p.submission.mandateHash === createHash("sha256").update(JSON.stringify(m.aggregate.mandate)).digest("hex");
}
function exactChecks(p: Publication) {
  return Boolean(p.observation && p.checks
    && p.checks.headSha === p.observation.headSha && p.checks.state === "passed");
}
function exactChecksAndReviews(p: Publication) {
  return Boolean(exactChecks(p) && p.observation && p.reviews
    && p.reviews.headSha === p.observation.headSha && p.reviews.state === "approved");
}
function exactFeedbackBinding(p: Publication) {
  const report = feedback(p);
  return Boolean(report && p.observation
    && report.headSha === p.observation.headSha
    && report.url === p.observation.url
    && report.draft === p.observation.draft);
}
function freshFeedback(p: Publication) {
  const observed = Date.parse(feedback(p)?.observedAt ?? "");
  return Number.isFinite(observed) && Date.now() - observed <= 300_000 && observed <= Date.now() + 5_000;
}
function publicationReady(n5: N5State, p: Publication, common: boolean, contractConformant: boolean) {
  const contract = n5.authority.contract, report = feedback(p);
  if (!contract || !report || !p.observation || !p.settledAt || !common || !contractConformant || !exactFeedbackBinding(p) || !freshFeedback(p)) return false;
  if (contract.result === "draft-pr") return githubFeedbackStates(contract, report).checks === "passed" && exactChecks(p);
  const states = githubFeedbackStates(contract, report);
  return states.checks === "passed" && states.reviews === "approved" && exactChecksAndReviews(p);
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
