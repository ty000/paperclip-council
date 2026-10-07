import type { MissionRecord } from "./missions.js";
import { freshN3Round } from "./n3-runtime.js";
import type { N3NativeRound } from "./n3-state.js";
import type { N3OpinionSlot } from "./n3-opinions.js";
import { ordinaryTask } from "./n2-ordinary-state.js";

export function ordinaryRound(mission: MissionRecord, submission: Parameters<typeof freshN3Round>[1], slots: N3OpinionSlot[]): N3NativeRound {
  const { transmission: _unused, ...round } = freshN3Round(mission, submission, slots);
  return round;
}
export function reviewTasks(mission: MissionRecord, round: N3NativeRound) {
  return [...round.review.slots.map(slot => ordinaryTask("specialist", round.review.subject.submissionId, slot.specialistAgentId, slot.slotId)),
    ordinaryTask("council", round.review.subject.submissionId, mission.aggregate.responsibilities.finalReviewerAgentId)];
}
