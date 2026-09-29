export { default as manifest, PLUGIN_ID } from "./manifest.js";
export { emitCouncilDecision, parseCouncilConfig } from "./decision-adapter.js";
export type {
  CouncilConfig,
  CouncilDecisionInput,
  CouncilDecisionResult,
  CouncilVerdict,
  SecretRef,
} from "./contracts.js";
