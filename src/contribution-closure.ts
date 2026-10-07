import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import type { readAdmission } from "./admission.js";

export function contributionSegmentRoot(m: MissionRecord, contributionId: string) {
  const n1 = m.aggregate.n1 as N1State;
  const index = n1.contributions.findIndex(s => s.contributionId === contributionId);
  const root = index === 0 ? n1.sourceBaseCommit : n1.contributions[index - 1]?.commit;
  if (index < 0 || !root) throw new MissionError(409, "contribution_source_base", "The pinned sequential predecessor must be observed before recording a leaf");
  return root;
}
export function assertContributionClosure(m: MissionRecord, contributionId: string, envelope: Awaited<ReturnType<typeof readAdmission>>, runStatus: string) {
  const n1 = m.aggregate.n1 as N1State, slot = n1.contributions.find(s => s.contributionId === contributionId);
  const reservation = envelope?.reservations.find(r => r.reservationId === slot?.dispatchReservationId);
  if (!slot?.proof || slot.proof.commit !== slot.commit || slot.proof.segmentRootCommit !== contributionSegmentRoot(m, contributionId)
      || slot.authorRunId !== slot.dispatchRunId || runStatus !== "succeeded") throw new MissionError(409, "contribution_closure_proof", "Succeeded alone cannot close a child: its exact admitted run and verified contribution are required");
  if (reservation?.missionId !== m.missionId || reservation.status !== "settled" || reservation.usage?.status !== "known"
      || reservation.remainingExposure.status !== "known" || reservation.remainingExposure.units !== 0) {
    throw new MissionError(409, "contribution_closure_usage", "Exact known terminal settlement without exposure must precede closure");
  }
  return slot;
}
