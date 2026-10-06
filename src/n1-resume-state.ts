import type { AdmissionSnapshot, AdmissionReserveInput } from "./admission.js";
import type { MissionAggregate } from "./missions.js";
import type { N1State } from "./n1-missions.js";

export type ResumeTarget = { issueId: string; priorRunId: string; priorReservationId: string;
  priorUsageBaselineUnits: number; reservationId: string; contributionId?: string };
export type N1Resume = { commandId: string; authorizedBy: string; previousOwnerUserId: string;
  authorizedAt: string; reason: string; lead: ResumeTarget; contributions: ResumeTarget[] };

export function settledResumeReservation(r: AdmissionSnapshot["reservations"][number]) {
  return r.status === "settled" && r.usage?.status === "known"
    && r.remainingExposure.status === "known" && r.remainingExposure.units === 0;
}

function unusedTarget(state: N1State, target: ResumeTarget) {
  if (!target.contributionId) return !state.rootDispatchState && state.activationReservationId === target.reservationId;
  const slot = state.contributions.find(s => s.contributionId === target.contributionId);
  return Boolean(slot && slot.childIssueId === target.issueId && !slot.dispatchState && !slot.commit);
}

/** The admission exemption consumes only reservation IDs from this durable owner grant. */
export function n1ResumeAdmissionFailure(m: MissionAggregate, envelope: AdmissionSnapshot,
  input: Pick<AdmissionReserveInput, "missionId" | "effectId" | "reservationId" | "attempt" | "ownerReplacementCommandId">, owner: string, currentOwner: unknown): string | null {
  const state = m.n1 as N1State | undefined;
  const grant = state?.resume;
  const target = grant && [grant.lead, ...grant.contributions].find(t => t.reservationId === input.reservationId);
  const receipt = m.commandReceipts.find(r => r.commandId === input.ownerReplacementCommandId);
  const prior = target && envelope.reservations.find(r => r.reservationId === target.priorReservationId);
  if (!state || !grant || !target || !receipt || !prior) return "n1_resume_grant_required";
  const authority = [grant.commandId === input.ownerReplacementCommandId, grant.authorizedBy === owner,
    owner === currentOwner, receipt.command === "prepare-n1-resume", receipt.actorType === "user", receipt.actorId === owner].every(Boolean);
  const binding = [input.attempt.kind === "resume", input.attempt.ordinal === 1,
    input.effectId === (target.contributionId ?? grant.commandId), m.phase === "executing", !state.candidate,
    unusedTarget(state, target), prior.missionId === input.missionId, settledResumeReservation(prior)].every(Boolean);
  return authority && binding ? null : "n1_resume_grant_required";
}
