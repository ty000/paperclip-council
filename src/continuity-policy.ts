import type { N3OpinionSlot } from "./n3-opinions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";

export type ContinuityCommand = "start-lead" | "reconcile-lead-usage" | "start-review";
export type ContinuityPolicy = {
  protocol: "council-continuity-v1"; enabled: boolean; authorizedBy: string; authorizedAt: string;
  mandateHash: string; deadline: string; n3Slots: N3OpinionSlot[];
  commands: Partial<Record<ContinuityCommand, Record<string, unknown>>>;
  extensions?: Array<{ commandId: string; previousDeadline: string; deadline: string;
    authorizedBy: string; authorizedAt: string; reason: string }>;
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
    throw new MissionError(409, "continuity_deadline", "The authorized elapsed bound is exhausted; no new departure is permitted");
  }
}

/** An explicit time extension changes only the departure window, never activation or budgets. */
export function assertN1DepartureWindow(m: MissionRecord) {
  const policy = m.aggregate.continuity;
  const extension = policy?.extensions?.at(-1);
  if (policy && extension) {
    if (extension.deadline !== policy.deadline || extension.authorizedBy !== m.ownerUserId) {
      throw new MissionError(409, "continuity_authority_blocked", "The retained time extension does not match the owner or deadline");
    }
    assertContinuityDeparture(m);
    return;
  }
  const value = m.aggregate.n1?.activatedAt;
  const activatedAt = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(activatedAt) || Date.now() >= activatedAt + m.aggregate.mandate.limits.elapsedMinutes * 60_000) {
    throw new MissionError(409, "elapsed_limit_exceeded", "Mission elapsed limit blocks new dispatch");
  }
}
