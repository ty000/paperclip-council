import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readAdmission } from "./admission.js";
import { completionPolicy } from "./completion-contract.js";
import { recordContributionProof } from "./contribution-proof.js";
import { councilNativeRequest } from "./decision-adapter.js";
import { readOrdinaryRun } from "./g4-native.js";
import { MissionError, type MissionAggregate, type MissionRecord } from "./missions.js";
import { physicalAgent } from "./model-state.js";
import type { N1State } from "./n1-missions.js";
import { settledResumeReservation } from "./n1-resume-state.js";
import { assertNativeRunInventory } from "./native-runs.js";

type RecoveryInput = { contributionId: string; commit: string; workProductId: string; proof: unknown;
  actorUserId: string; commandId: string; reason: string };

function recoverableState(m: MissionRecord) {
  const state = m.aggregate.n1 as N1State | undefined;
  if (!state || !completionPolicy(m) || state.candidate || state.integration || m.aggregate.n2 || m.aggregate.n5
      || m.aggregate.phase !== "executing" || m.aggregate.control.status !== "active"
      || state.rootDispatchMode !== "native" || state.rootDispatchState !== "requested"
      || m.aggregate.nativeWakePolicy?.protocol !== "council-native-wake-v2") {
    throw new MissionError(409, "contribution_recovery_unavailable", "Recover a native missing contribution only before integration and its first candidate");
  }
  return state;
}

function recoverableSlot(m: MissionRecord, contributionId: string) {
  const state = recoverableState(m);
  const index = state.contributions.findIndex(s => s.contributionId === contributionId), slot = state.contributions[index];
  if (!slot || slot.commit || slot.proof || slot.authorRunId || slot.issueState !== "confirmed"
      || slot.dispatchState !== "requested" || !slot.dispatchReservationId || !slot.dispatchRunId || !slot.childIssueId
      || state.contributions.slice(0, index).some(s => !s.commit || !s.proof?.closedAt)) {
    throw new MissionError(409, "contribution_recovery_binding", "Retain the exact admitted missing child after its qualified sequential predecessors");
  }
  return { state, slot };
}

async function assertRecoveryChild(ctx: PluginContext, m: MissionRecord, slot: N1State["contributions"][number]) {
  const agentId = physicalAgent(m, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.dispatchRunId });
  const issue = await ctx.issues.get(slot.childIssueId!, m.companyId);
  if (!issue || issue.companyId !== m.companyId || issue.projectId !== m.projectId
      || issue.parentId !== (slot.parentIssueId !== undefined ? slot.parentIssueId : m.rootIssueId) || issue.assigneeAgentId !== agentId
      || !["done", "blocked"].includes(issue.status) || issue.checkoutRunId || issue.executionRunId) {
    throw new MissionError(409, "contribution_recovery_issue", "The original terminal child must retain its identity without any native run lock");
  }
  return agentId;
}

async function assertRecoveryUsage(ctx: PluginContext, m: MissionRecord, state: N1State, slot: N1State["contributions"][number]) {
  const envelope = await readAdmission(ctx, { companyId: m.companyId, periodKey: state.periodKey });
  const reservations = envelope?.reservations.filter(r => r.missionId === m.missionId) ?? [];
  if (!reservations.some(r => r.reservationId === state.activationReservationId)
      || !reservations.some(r => r.reservationId === slot.dispatchReservationId)
      || reservations.some(r => !settledResumeReservation(r))) {
    throw new MissionError(409, "contribution_recovery_usage", "Every historical mission reservation must retain known settled usage and zero exposure");
  }
}

async function assertRecoveryTerminal(ctx: PluginContext, m: MissionRecord, state: N1State, slot: N1State["contributions"][number]) {
  const agentId = await assertRecoveryChild(ctx, m, slot);
  const run = await readOrdinaryRun(ctx, { companyId: m.companyId, issueId: slot.childIssueId!, agentId, runId: slot.dispatchRunId! });
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) {
    throw new MissionError(409, "contribution_recovery_run", "Only the exact succeeded terminal contributor can supply this recovery");
  }
  await assertRecoveryUsage(ctx, m, state, slot);
  await assertNativeRunInventory(ctx, m);
}

async function assertNativeCommit(ctx: PluginContext, m: MissionRecord, slot: N1State["contributions"][number], input: RecoveryInput) {
  const response = await councilNativeRequest(ctx, m.companyId, `/api/issues/${slot.childIssueId}/work-products`)
    .catch(() => ({ status: 0, body: null }));
  const products = response.body;
  const expected = { id: input.workProductId, type: "commit", provider: "git", companyId: m.companyId,
    projectId: m.projectId, issueId: slot.childIssueId, externalId: input.commit, createdByRunId: slot.dispatchRunId };
  if (response.status !== 200 || !Array.isArray(products) || !products.some(product => product
      && Object.entries(expected).every(([key, value]) => product[key] === value))) {
    throw new MissionError(409, "contribution_recovery_provenance", "Read back the exact Git commit work product created by the admitted contributor run");
  }
}

/** Owner assistance records an existing native result; it cannot spend, wake, integrate or impersonate an agent. */
export async function recoverContribution(ctx: PluginContext, m: MissionRecord, input: RecoveryInput): Promise<MissionAggregate> {
  const { state, slot } = recoverableSlot(m, input.contributionId);
  if (!/^[a-f0-9]{40}$/.test(input.commit)) throw new MissionError(422, "invalid_commit", "Contribution commit must be a Git SHA-1");
  await assertRecoveryTerminal(ctx, m, state, slot);
  await assertNativeCommit(ctx, m, slot, input);
  const proof = await recordContributionProof(ctx, m, input.contributionId, input.commit, input.proof);
  const recovery = { actorUserId: input.actorUserId, commandId: input.commandId, workProductId: input.workProductId };
  return { ...m.aggregate,
    n1: { ...state, contributions: state.contributions.map(s => s.contributionId === input.contributionId
      ? { ...s, commit: input.commit, authorRunId: slot.dispatchRunId!, proof, contributionRecovery: recovery } : s) },
    journal: [...m.aggregate.journal, { action: "owner_recovered_contribution", ...recovery, reason: input.reason,
      contributionId: input.contributionId, commit: input.commit, originalAuthorRunId: slot.dispatchRunId,
      assistance: "owner-native-work-product", at: new Date().toISOString() }],
  };
}
