import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getMission, MissionError, type MissionRecord } from "./missions.js";
import { executeN1BoardCommand, dispatchHierarchyContribution, type N1State } from "./n1-missions.js";
import { n2Cas } from "./n2-missions.js";
import { readNativeG4Profile, readOrdinaryRun } from "./g4-native.js";
import { physicalAgent } from "./model-state.js";
import { advanceHierarchyIntegration } from "./hierarchy-integration.js";
import { assertContinuityDeparture, assertN1DepartureWindow } from "./continuity-policy.js";

const state = (m: MissionRecord) => m.aggregate.n1 as N1State;
const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;

async function prepare(ctx: PluginContext, initial: MissionRecord, key: string, fields: Record<string, unknown>) {
  let m = initial;
  let body = state(m).hierarchyCommands?.[key];
  if (!body) {
    body = { companyId: m.companyId, commandId: randomUUID(), expectedVersion: m.version + 1, ...fields };
    m = await n2Cas(ctx, m, { ...m.aggregate, n1: { ...state(m), hierarchyCommands: { ...state(m).hierarchyCommands, [key]: body } } });
  }
  return { m, body };
}

async function reconcileChild(ctx: PluginContext, initial: MissionRecord, contributionId: string) {
  const slot = state(initial).contributions.find(s => s.contributionId === contributionId)!;
  if (slot.dispatchState !== "requested" || !slot.dispatchRunId) throw new MissionError(409, "hierarchy_child_effect_unknown", "Retain the original child dispatch; no replacement wake");
  const run = await readOrdinaryRun(ctx, { companyId: initial.companyId, issueId: slot.childIssueId!, runId: slot.dispatchRunId,
    agentId: physicalAgent(initial, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.dispatchRunId }) });
  if (["queued", "running", "scheduled_retry"].includes(run.status)) return false;
  const { m, body } = await prepare(ctx, initial, `settle:${contributionId}`, { command: "reconcile-contribution-usage", contributionId });
  await executeN1BoardCommand(ctx, { companyId: m.companyId, missionId: m.missionId, actorUserId: m.aggregate.continuity!.authorizedBy, body });
  if (run.status !== "succeeded" || !slot.commit || !slot.proof) throw new MissionError(409, "hierarchy_child_incomplete", "Terminal usage is retained; successful attributed contribution proof is required");
  return true;
}

/** Continue an admitted sequential plan after the planner finishes, without impersonating it. */
export async function advanceHierarchyChildren(ctx: PluginContext, initial: MissionRecord) {
  let m = initial;
  const leaves = m.aggregate.hierarchy!.leaves!;
  if (state(m).contributions.length !== leaves.length || state(m).contributions.some((slot, index) =>
    slot.contributionId !== leaves[index]!.contributionId || slot.childIssueId !== leaves[index]!.issueId || slot.issueState !== "confirmed")) {
    throw new MissionError(409, "hierarchy_plan_incomplete", "The native planner must materialize the exact admitted hierarchy before delegated progression");
  }
  for (const contribution of state(m).contributions) {
    if (!contribution.dispatchState) {
      assertContinuityDeparture(m); assertN1DepartureWindow(m);
      const profile = await readNativeG4Profile(ctx, m.companyId);
      if (!profile) throw new MissionError(409, "g4_measurement_unqualified", "Native reservation estimate required");
      const preserved = state(m).resume?.preparedContributions?.find(target => target.contributionId === contribution.contributionId);
      const prepared = await prepare(ctx, m, `dispatch:${contribution.contributionId}`, { command: "dispatch", contributionId: contribution.contributionId,
        reservationId: preserved?.reservationId ?? randomUUID(), requestedUnits: profile.runReservationUnits });
      await dispatchHierarchyContribution(ctx, prepared.m, prepared.body);
      return "hierarchy_child_dispatched";
    }
    if (!await reconcileChild(ctx, m, contribution.contributionId)) return "hierarchy_child_running";
    m = await fresh(ctx, m);
    const proof = state(m).contributions.find(s => s.contributionId === contribution.contributionId)!.proof;
    if (!(proof?.closedAt || m.aggregate.projectMandate?.completion?.result === "integrated-verified" && proof?.readyAt)) {
      throw new MissionError(409, "hierarchy_child_closure_pending", "Exact native child closure must precede the next stage");
    }
  }
  return advanceHierarchyIntegration(ctx, m);
}
