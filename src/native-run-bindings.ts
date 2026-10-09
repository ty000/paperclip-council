import type { MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import { physicalAgent } from "./model-state.js";
import { leadIssueId } from "./hierarchy-contract.js";
import { n1ResumeGrants } from "./n1-resume-state.js";

export type NativeRunBinding = { issueId: string; agentId: string; reservationId: string; runId?: string | null; pending: boolean };

function binding(m: MissionRecord, issueId: string | null | undefined, logicalAgentId: string,
  runId: string | null | undefined, reservationId: string, pending = false): NativeRunBinding[] {
  if (!issueId) return [];
  return [{ issueId, agentId: physicalAgent(m, logicalAgentId, { issueId, ...(runId ? { runId } : {}) }), runId, reservationId, pending }];
}

function resumeBindings(m: MissionRecord, state: N1State, lead: string) {
  const targets = n1ResumeGrants(state).flatMap(grant => [grant.lead, ...grant.contributions]);
  return targets.flatMap(target => {
    const slot = state.contributions.find(item => item.contributionId === target.contributionId);
    return binding(m, target.issueId, slot?.assigneeAgentId ?? lead, target.priorRunId, target.priorReservationId);
  });
}

function n1Bindings(m: MissionRecord) {
  const state = m.aggregate.n1 as N1State | undefined;
  if (!state) return [];
  const lead = m.aggregate.responsibilities.integrationLeadAgentId;
  return [...binding(m, leadIssueId(m), lead, state.rootDispatchRunId, state.activationReservationId,
    ["claimed", "unknown"].includes(state.rootDispatchState ?? "")),
    ...state.contributions.flatMap(slot => binding(m, slot.childIssueId, slot.assigneeAgentId, slot.dispatchRunId,
      slot.dispatchReservationId!, ["claimed", "unknown"].includes(slot.dispatchState ?? ""))),
    ...resumeBindings(m, state, lead),
    ...(state.integration ? binding(m, state.integration.issueId, lead, state.integration.runId, state.integration.reservationId,
      state.integration.wake === "claimed" && !state.integration.runId) : [])];
}

function modelBindings(m: MissionRecord): NativeRunBinding[] {
  return (m.aggregate.modelSelection?.tasks ?? []).flatMap(task => task.launches.filter(launch => launch.issueId).map(launch => ({
    issueId: launch.issueId!, agentId: launch.agentId, runId: launch.runId, reservationId: launch.launchKey,
    pending: !launch.runId && ["wake_claimed", "unknown"].includes(launch.state) })));
}

type TaskBinding = { issueId: string | null; agentId: string; runId: string | null; reservationId: string; wake: string };
function taskBindings(m: MissionRecord, tasks: TaskBinding[]) {
  return tasks.flatMap(task => binding(m, task.issueId, task.agentId, task.runId, task.reservationId, task.wake === "claimed" && !task.runId));
}

function publisherBindings(m: MissionRecord) {
  const n5 = m.aggregate.n5;
  if (!n5) return [];
  return [n5.publication, n5.integration?.previousPublication, n5.continuation?.previousPublication, m.aggregate.linearContinuity?.cancellation?.previousPublication].filter(Boolean).flatMap(p =>
    binding(m, p!.issueId, n5.authority.publisherAgentId, p!.runId, p!.reservationId, p!.wake === "claimed" && !p!.runId));
}

/** Preserve every stored physical binding, reservation and governed history. */
export function nativeRunBindings(m: MissionRecord): NativeRunBinding[] {
  return [...modelBindings(m), ...n1Bindings(m), ...taskBindings(m, m.aggregate.n2?.ordinary?.tasks ?? []),
    ...taskBindings(m, m.aggregate.n6?.coordination?.tasks ?? []),
    ...taskBindings(m, m.aggregate.campaignClosure ? [m.aggregate.campaignClosure.task] : []), ...publisherBindings(m)];
}
