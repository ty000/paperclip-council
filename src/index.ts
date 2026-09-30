export { default as manifest, PLUGIN_ID } from "./manifest.js";
export { emitCouncilDecision, parseCouncilConfig } from "./decision-adapter.js";
export {
  compareAndSwapFoundationProbe,
  handleFoundationProbe,
  MAX_CANDIDATE_BUNDLE_BYTES,
  readFoundationProbe,
  verifyCandidateAttachment,
} from "./foundation-probe.js";
export * from "./rosters.js";
export * from "./missions.js";
export type {
  CouncilConfig,
  CouncilDecisionInput,
  CouncilDecisionResult,
  CouncilVerdict,
  SecretRef,
} from "./contracts.js";
