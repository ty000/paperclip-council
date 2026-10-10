import { FIXED_CAMPAIGN_MODE, SOURCE_OBSERVATION_PROTOCOL, fixedSourceFresh, type LinearContinuityState, type LinearPublication,
  type ObservationPurpose } from "./linear-continuity-contract.js";

const LINEAR_RETRY_INTERVAL_MS = 30_000;
export const LINEAR_MAX_ATTEMPTS = 3;
export type LinearTransportOptions = { forceObservation?: boolean; requestObservation?: boolean };
type FixedExchangePlan = { purpose?: ObservationPurpose; repeat?: boolean; hold?: "linear_source_retry_exhausted" | "linear_publication_retry_exhausted" };

function unfinishedChallenge(state: LinearContinuityState, pending: LinearPublication[], options: LinearTransportOptions, now: number, due: boolean): FixedExchangePlan | undefined {
  const challenge = state.challenge;
  if (challenge?.payload.sourceObservationProtocol !== SOURCE_OBSERVATION_PROTOCOL || challenge.answeredAt) return;
  if (!due || !pending.length && state.control !== "running" && !options.requestObservation) return {};
  if ((challenge.attempts ?? 0) >= LINEAR_MAX_ATTEMPTS || Date.parse(challenge.expiresAt) <= now) return { hold: "linear_source_retry_exhausted" };
  return { repeat: true };
}
function newSourceDemand(state: LinearContinuityState, pending: LinearPublication[], options: LinearTransportOptions, now: number, due: boolean): FixedExchangePlan {
  const running = state.control === "running" && !state.controlReason;
  if (options.requestObservation && !fixedSourceFresh(state, now)) return { purpose: "action" };
  if (running && (state.sourceInvalidationVersion ?? 0) > (state.observation?.response.sourceInvalidationVersion ?? 0)) return { purpose: "event" };
  if (pending.length && due && pending.some(p => p.reconciliationAttempts)) return { purpose: "readback" };
  return {};
}
/** Expiration is a gate on an attempted action, never a scheduling trigger. */
export function fixedExchangePlan(state: LinearContinuityState, pending: LinearPublication[], options: LinearTransportOptions, now: number, terminalGrantChanged: boolean): FixedExchangePlan {
  if (state.mode !== FIXED_CAMPAIGN_MODE) return {};
  const last = state.challenge?.lastEmittedAt;
  const due = !last || now - Date.parse(last) >= LINEAR_RETRY_INTERVAL_MS;
  if (options.forceObservation && due) return { purpose: "recovery" };
  if (state.transportHold) return {};
  const eligible = pending.filter(p => (p.reconciliationAttempts ?? 0) < (p.reconciliationLimit ?? LINEAR_MAX_ATTEMPTS));
  if (pending.length !== eligible.length) return { hold: "linear_publication_retry_exhausted" };
  if (eligible.some(p => !p.reconciliationAttempts) || terminalGrantChanged && eligible.length) return { purpose: "publication" };
  return unfinishedChallenge(state, pending, options, now, due) ?? newSourceDemand(state, pending, options, now, due);
}
