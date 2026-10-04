import type { N3CandidateSubject } from "./n3-opinions.js";
import type { MissionRecord } from "./missions.js";

export type N6Dependency = {
  protocol: "accepted-result-v1";
  sourceMissionId: string;
  sourceRootIssueId: string;
  expectedResult: N3CandidateSubject;
  authorizedBy: string;
  authorizedAt: string;
  intentId: string;
  guardIssueId: string | null;
  guardCreation: "claimed" | "confirmed";
  relationConfirmed: boolean;
  periodKey: string;
  requestedUnits: number;
  reservationId: string;
  activationCommandId: string;
  startCommandId: string;
  activationBody?: Record<string, unknown>;
  startBody?: Record<string, unknown>;
  verifiedAt?: string;
  blockage?: string;
};

export function inspectN6(mission: MissionRecord) {
  const dependency = mission.aggregate.n6;
  if (!dependency) return null;
  const dispatched = mission.aggregate.n1?.rootDispatchState === "requested";
  return { ...dependency, state: dispatched ? "started" : dependency.verifiedAt && !dependency.blockage ? "verified" : "waiting",
    nextActor: dependency.authorizedBy,
    nextAction: dispatched ? "Lead executes the admitted downstream mission"
      : dependency.blockage ? "Waiting for the authorized predecessor: exact acceptance, unchanged candidate/mandate and settled usage are required. Owner can reconcile the same dependency." : "Wait for the exact accepted predecessor and settled usage; reconcile-result-dependency recovers missed events",
    publicationRequired: false };
}
