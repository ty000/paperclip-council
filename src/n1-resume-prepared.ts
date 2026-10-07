import type { AdmissionReservation, AdmissionSnapshot } from "./admission.js";
import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import { settledResumeReservation, type N1Resume } from "./n1-resume-state.js";

function unusedReservation(reservation: AdmissionReservation) {
  return reservation.status === "reserved" && reservation.attempt.kind === "initial" && reservation.attempt.ordinal === 0
    && !reservation.ownerReplacementCommandId && reservation.usage === null && reservation.lastKnownUsageUnits === 0
    && reservation.settlementReceipts.length === 0 && reservation.remainingExposure.status === "known"
    && reservation.remainingExposure.units === reservation.requestedUnits;
}

/** A prepared child keeps its original admission; this exception never covers a claimed wake. */
export function preparedResumeContributions(m: MissionRecord, state: N1State, envelope: AdmissionSnapshot) {
  if (m.aggregate.hierarchy?.leaves && envelope.blockers?.length) {
    throw new MissionError(409, "n1_resume_admission_blocked", "Resolve the existing admission blockers without resetting its envelope before an operator resume");
  }
  const prepared: NonNullable<N1Resume["preparedContributions"]> = [];
  for (const reservation of envelope.reservations.filter(r => r.missionId === m.missionId && !settledResumeReservation(r))) {
    const slot = state.contributions.find(s => s.contributionId === reservation.effectId);
    const launches = m.aggregate.modelSelection?.tasks.find(t => t.taskKey === slot?.contributionId)?.launches ?? [];
    const launch = launches.length === 1 ? launches[0] : undefined;
    const wake = m.aggregate.effectIntents.some(e => e.kind === "child_wakeup" && e.contributionId === slot?.contributionId);
    if (!m.aggregate.hierarchy?.leaves || !slot?.childIssueId || !launch || !unusedReservation(reservation)
        || launch.launchKey !== reservation.reservationId || launch.state !== "ready" || launch.runId
        || launch.issueId !== slot.childIssueId || launch.logicalAgentId !== slot.assigneeAgentId
        || launch.interventionKey !== slot.contributionId || wake) {
      throw new MissionError(409, "n1_resume_usage_unsettled", "Only an exact initial ready child reservation without a wake can remain held");
    }
    prepared.push({ contributionId: slot.contributionId, issueId: slot.childIssueId, reservationId: reservation.reservationId });
  }
  return prepared;
}
