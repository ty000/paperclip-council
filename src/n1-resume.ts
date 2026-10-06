import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readAdmission } from "./admission.js";
import { assertNativeLaunchAllowed, readOrdinaryRun } from "./g4-native.js";
import { MissionError, type MissionRecord, type MissionAggregate } from "./missions.js";
import type { N1State } from "./n1-missions.js";

import { settledResumeReservation as settled, type ResumeTarget, type N1Resume } from "./n1-resume-state.js";
import { physicalAgent } from "./model-state.js";

/** Readback only: this binds an explicitly operator-started run and never requests another wake. */
export async function verifyResumedLeadRun(ctx: PluginContext, m: MissionRecord, runId: string) {
  const state = m.aggregate.n1 as N1State | undefined;
  if (!state?.resume || state.rootDispatchState !== "unknown" || state.rootDispatchRunId
      || state.candidate || m.aggregate.phase !== "executing" || m.aggregate.control.status !== "active") {
    throw new MissionError(409, "n1_resume_binding_unavailable", "Only an unresolved resumed lead launch can bind an observed run");
  }
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: state.periodKey });
  const reservation = envelope?.reservations.find(r => r.reservationId === state.activationReservationId);
  if (reservation?.status !== "reserved" || reservation.missionId !== m.missionId
      || reservation.ownerReplacementCommandId !== state.resume.commandId) {
    throw new MissionError(409, "n1_resume_binding_unreserved", "The original resume reservation must remain held");
  }
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: m.rootIssueId, runId,
    agentId: physicalAgent(m, m.aggregate.responsibilities.integrationLeadAgentId, { issueId: m.rootIssueId }) });
  const summary = await ctx.issues.summaries.getOrchestration({ companyId: m.companyId, issueId: m.rootIssueId, includeSubtree: false });
  const expected = new Set([state.resume.lead.priorRunId, runId]);
  if (expected.size !== 2 || summary.runs.length !== 2 || summary.runs.some(r => !expected.has(r.id))
      || !run.startedAt || Date.parse(run.startedAt) < Date.parse(state.resume.authorizedAt)) {
    throw new MissionError(409, "n1_resume_run_mismatch", "Exactly one new run after the owner grant must be observed alongside the original run");
  }
  return state;
}

async function requireBlockedIssue(ctx: PluginContext, m: MissionRecord, issueId: string) {
  const issue = await ctx.issues.get(issueId, m.companyId);
  if (!issue || issue.companyId !== m.companyId || issue.projectId !== m.projectId
      || issue.checkoutRunId || issue.executionRunId || issue.status !== "blocked") {
    throw new MissionError(409, "n1_resume_issue_active", "Resume requires the mapped blocked issue without a native run lock");
  }
}

/** One explicit restart before a candidate exists; old effects, runs and costs are retained. */
export async function prepareN1Resume(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, owner: string) {
  const state = m.aggregate.n1 as N1State | undefined;
  if (!state || state.resume || state.candidate || m.aggregate.n2 || m.aggregate.n5 || m.aggregate.n6
      || m.aggregate.phase !== "executing" || m.aggregate.control.status !== "active"
      || state.rootDispatchMode !== "native" || state.rootDispatchState !== "requested"
      || body.authorizeOneResume !== true || body.previousOwnerUserId !== m.ownerUserId) {
    throw new MissionError(409, "n1_resume_unavailable", "One explicit owner resume of an interrupted native N1 mission is required");
  }
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) {
    throw new MissionError(400, "malformed_request", "A bounded resume reason is required");
  }
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: state.periodKey });
  if (!envelope || envelope.reservations.some(r => r.missionId === m.missionId && !settled(r))) {
    throw new MissionError(409, "n1_resume_usage_unsettled", "All previous mission reservations must be settled without exposure");
  }
  const check = async (issueId: string | undefined, runId: string | null | undefined,
    reservationId: string | undefined, baseline: number | undefined, contributionId?: string): Promise<ResumeTarget> => {
    const reservation = envelope.reservations.find(r => r.reservationId === reservationId);
    if (!issueId || !runId || !reservationId || reservation?.missionId !== m.missionId
        || !settled(reservation) || !Number.isSafeInteger(baseline) || baseline! < 0) {
      throw new MissionError(409, "n1_resume_binding", "An exact settled previous dispatch is required");
    }
    await assertNativeLaunchAllowed(ctx, { companyId: m.companyId, issueId, priorRunId: runId });
    await requireBlockedIssue(ctx, m, issueId);
    return { issueId, priorRunId: runId, priorReservationId: reservationId,
      priorUsageBaselineUnits: baseline!, reservationId: randomUUID(), ...(contributionId ? { contributionId } : {}) };
  };
  const lead = await check(m.rootIssueId, state.rootDispatchRunId, state.activationReservationId, state.rootUsageBaselineUnits);
  const contributions: ResumeTarget[] = [];
  for (const slot of state.contributions) {
    if (slot.issueState !== "confirmed" || slot.dispatchState && slot.dispatchState !== "requested") {
      throw new MissionError(409, "n1_resume_effect_unknown", "Reconcile uncertain issue creation or dispatch before resuming");
    }
    if (slot.dispatchState && !slot.commit) contributions.push(await check(slot.childIssueId,
      slot.dispatchRunId, slot.dispatchReservationId, slot.dispatchUsageBaselineUnits, slot.contributionId));
  }
  const resume: N1Resume = { commandId: String(body.commandId), authorizedBy: owner, previousOwnerUserId: m.ownerUserId,
    authorizedAt: new Date().toISOString(), reason: body.reason.trim(), lead, contributions };
  return { ...m.aggregate, ownerUserId: owner, n1: { ...state, resume,
    activationReservationId: lead.reservationId, rootDispatchState: undefined, rootDispatchRunId: undefined,
    rootUsageBaselineUnits: undefined, contributions: state.contributions.map(slot => contributions.some(t => t.contributionId === slot.contributionId)
      ? { ...slot, dispatchState: undefined, dispatchRunId: undefined, dispatchReservationId: undefined, dispatchUsageBaselineUnits: undefined }
      : slot) },
    journal: [...m.aggregate.journal, { action: "n1_resume_authorized", ...resume }] } satisfies MissionAggregate;
}

