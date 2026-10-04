import { isDeepStrictEqual } from "node:util";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AdmissionSnapshot, AdmissionReserveInput } from "./admission.js";
import type { MissionAggregate } from "./missions.js";
import type { OrdinaryN2State } from "./n2-ordinary-state.js";

type Grant = NonNullable<OrdinaryN2State["missingOpinionReplacement"]>;
type Binding = Pick<AdmissionReserveInput, "missionId" | "effectId" | "reservationId" | "attempt" | "ownerReplacementCommandId">;
function matchesAuthority(grant: Grant, input: Binding, owner: string, currentOwner: unknown) {
  return [input.attempt.kind === "resume", input.attempt.ordinal === 1, grant.commandId === input.ownerReplacementCommandId,
    grant.authorizedBy === owner, grant.authorizedBy === currentOwner, grant.reservationId === input.reservationId,
    grant.replacementTaskId === input.effectId].every(Boolean);
}
function matchesSubject(aggregate: MissionAggregate, grant: Grant) {
  const receipt = aggregate.commandReceipts.find(item => item.commandId === grant.commandId);
  const state = aggregate.n2!; const round = aggregate.n3?.rounds.find(item => item.review.subject.submissionId === grant.submissionId);
  return [receipt?.command === "replace-missing-opinion", receipt?.actorType === "user", receipt?.actorId === grant.authorizedBy,
    state.activeSubmissionId === grant.submissionId, round?.review.subject.candidateCommit === grant.candidateCommit,
    isDeepStrictEqual(round?.review.subject, grant.subject)].every(Boolean);
}
function matchesTasks(aggregate: MissionAggregate, grant: Grant) {
  const tasks = aggregate.n2!.ordinary!.tasks;
  const prior = tasks.find(item => item.taskId === grant.priorTaskId); const next = tasks.find(item => item.taskId === grant.replacementTaskId);
  if (!prior || !next) return false;
  const round = aggregate.n3!.rounds.find(item => item.review.subject.submissionId === grant.submissionId)!;
  return [!round.review.opinions.some(item => item.slotId === prior.slotId), prior.runId === grant.priorRunId,
    prior.reservationId === grant.priorReservationId, Boolean(prior.settledAt), prior.replacedBy === next.taskId,
    next.replacementOf === prior.taskId, next.reservationId === grant.reservationId, next.agentId === prior.agentId,
    next.slotId === prior.slotId, next.submissionId === grant.submissionId].every(Boolean);
}
function settledOriginal(envelope: AdmissionSnapshot, input: Binding, grant: Grant) {
  const reservation = envelope.reservations.find(item => item.reservationId === grant.priorReservationId);
  if (!reservation) return false;
  return [reservation.missionId === input.missionId, reservation.status === "settled", reservation.usage?.status === "known",
    reservation.remainingExposure.status === "known" && reservation.remainingExposure.units === 0,
    !envelope.reservations.some(item => item.missionId === input.missionId && item.ownerReplacementCommandId)].every(Boolean);
}
/** A client key is insufficient: re-read the exact durable owner grant before admission. */
export async function ownerReplacementAdmissionFailure(ctx: PluginContext, envelope: AdmissionSnapshot, input: Binding) {
  const [row] = await ctx.db.query<{ owner_user_id: string; aggregate: MissionAggregate }>(
    `SELECT owner_user_id, aggregate FROM ${ctx.db.namespace}.missions WHERE company_id = $1 AND mission_id = $2`, [envelope.companyId, input.missionId]);
  const company = await ctx.companies.get(envelope.companyId);
  const grant = row?.aggregate.n2?.ordinary?.missingOpinionReplacement;
  if (!grant || !matchesAuthority(grant, input, row.owner_user_id, company?.defaultResponsibleUserId)) return "owner_replacement_grant_required";
  if (!matchesSubject(row.aggregate, grant) || !matchesTasks(row.aggregate, grant)) return "owner_replacement_binding";
  if (!settledOriginal(envelope, input, grant)) return "owner_replacement_exhausted";
  return null;
}
