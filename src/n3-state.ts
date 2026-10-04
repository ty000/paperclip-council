import type { N3OpinionSlot, N3ReviewRound } from "./n3-opinions.js";

export type N3Execution = { reservationId: string; settlementCommandId: string; runId: string | null; wake: "pending" | "claimed"; settledAt?: string };
type Specialist = N3Execution & { slotId: string; issueId: string | null; creation: "pending" | "claimed" };
export type N3NativeRound = { review: N3ReviewRound; blockerIssueId?: string; blockerClaimed?: boolean; specialists: Specialist[]; transmission?: N3Execution; released?: boolean; attestedAt?: string; nextActor?: string };
export type N3State = { slots: N3OpinionSlot[]; rounds: N3NativeRound[] };

type N3MissionView = { aggregate: { n3?: N3State; n2?: { activeSubmissionId: string } } };

export function n3Round(mission: N3MissionView): N3NativeRound | undefined {
  return mission.aggregate.n3?.rounds.find(round => round.review.subject.submissionId === mission.aggregate.n2?.activeSubmissionId);
}
export function inspectN3(mission: N3MissionView) {
  const round = n3Round(mission); if (!round) return null;
  const missing = round.review.slots.filter(slot => !round.review.opinions.some(opinion => opinion.slotId === slot.slotId)).map(slot => slot.slotId);
  return { ...round, missing, usageUnknown: round.specialists.filter(item => !item.settledAt).map(item => item.slotId),
    nextActor: round.nextActor ?? (missing.length ? "selected specialists" : round.specialists.some(item => !item.settledAt) ? "terminal usage settlement" : "assigned final reviewer") };
}
