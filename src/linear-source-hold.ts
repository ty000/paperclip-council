import { FIXED_CAMPAIGN_MODE, type LinearContinuityState, type LinearContinuityResponse, type SourceDiagnostic } from "./linear-continuity-contract.js";

/** Persist with the observation so a later healthy read cannot erase an unprocessed interruption. */
export function retainSourceHold(state: LinearContinuityState, response: LinearContinuityResponse): LinearContinuityState {
  if (state.mode !== FIXED_CAMPAIGN_MODE || ["cancel_requested", "cancelled"].includes(state.control)) return state;
  if (!response.diagnostic && response.availability === "available" && response.sourceSha256 === state.sourceSha256) return state;
  const diagnostic: SourceDiagnostic = response.diagnostic ?? {
    code: response.sourceSha256 === state.sourceSha256 ? "source_unavailable" : "source_changed",
    expectedSourceSha256: state.sourceSha256,
    ...(response.sourceSha256 !== state.sourceSha256 ? { observedSourceSha256: response.sourceSha256 } : {}),
    changedSourceIds: [], changedFields: [],
  };
  return { ...state, control: state.control === "paused" ? "paused" : "pause_requested",
    controlReason: diagnostic.code, controlDiagnostic: diagnostic };
}

export function sourceHoldMessage(diagnostic: SourceDiagnostic) {
  const messages = {
    source_changed: "Le périmètre engagé a changé. Rétablissez la source initiale ou annulez la campagne ; la reprise exige une commande explicite dans Paperclip.",
    source_state_changed: "Un statut humain ou un archivage diffère de l'état attendu. Clarifiez l'écart dans Paperclip, puis demandez explicitement la reprise.",
    source_unavailable: "La source Linear ne peut pas être vérifiée. Rétablissez l'accès, puis demandez explicitement la reprise dans Paperclip.",
    publication_unavailable: "Une publication ou son readback reste indisponible. Réconciliez l'effet initial, puis demandez explicitement la reprise dans Paperclip.",
  };
  const fields = diagnostic.changedFields.length ? ` Champs concernés : ${diagnostic.changedFields.join(", ")}.` : "";
  const sources = diagnostic.changedSourceIds.length ? ` Objets source : ${diagnostic.changedSourceIds.join(", ")}.` : "";
  return `${messages[diagnostic.code]}${fields}${sources}`;
}
