import type { MissionRecord } from "./missions.js";
import { leadIssueId } from "./hierarchy-contract.js";

/** A new nominal integration stage; it never replaces the planning lead's run. */
export type N1Integration = {
  taskId: string; reservationId: string; settlementCommandId: string;
  issueId: string | null; creation: "pending" | "claimed" | "confirmed";
  wake: "pending" | "claimed"; runId: string | null; usageBaselineUnits?: number;
  settledAt?: string;
  instructionsVersion?: "composed-validation-v1";
};

export function n1LeadExecution(m: MissionRecord) {
  const state = m.aggregate.n1;
  const integration = state?.integration as N1Integration | undefined;
  return integration
    ? { issueId: integration.issueId, runId: integration.runId, reservationId: integration.reservationId }
    : { issueId: leadIssueId(m), runId: state?.rootDispatchRunId as string | null | undefined,
      reservationId: state?.activationReservationId as string | undefined };
}
