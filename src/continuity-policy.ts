import type { N3OpinionSlot } from "./n3-opinions.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";

export type ContinuityCommand = "start-lead" | "reconcile-lead-usage" | "start-review";
export type ContinuityPolicy = {
  protocol: "council-continuity-v1"; enabled: boolean; authorizedBy: string; authorizedAt: string;
  mandateHash: string; deadline: string; n3Slots: N3OpinionSlot[];
  commands: Partial<Record<ContinuityCommand, Record<string, unknown>>>;
};

/** This is a departure gate, never permission to repeat an uncertain effect. */
export function assertContinuityDeparture(m: MissionRecord) {
  const policy = m.aggregate.continuity;
  if (!policy) return;
  if (!policy.enabled || policy.mandateHash !== canonicalPayloadHash(m.aggregate.mandate)
      || policy.authorizedBy !== m.ownerUserId || m.aggregate.control.status === "blocked") {
    throw new MissionError(409, "continuity_authority_blocked", "Retain the existing mandate and effects; no delegated departure is authorized");
  }
  if (!Number.isFinite(Date.parse(policy.deadline)) || Date.now() >= Date.parse(policy.deadline)) {
    throw new MissionError(409, "continuity_deadline", "The original delegated elapsed bound is exhausted; no new departure is permitted");
  }
}
