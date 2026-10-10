import { physicalAgent } from "./model-state.js";
import { assertNativeRunInventory } from "./native-runs.js";
import { getMissionByN6WorkIssue } from "./missions.js";
import { reconcileN6 } from "./n6-runtime.js";
import { reconcileN5 } from "./n5-runtime.js";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { parseCouncilConfig } from "./decision-adapter.js";
import {
  DecisionReceiptError,
  executeCouncilDecision,
} from "./decision-receipts.js";
import { getMissionByOrdinaryIssue, getMissionByRootIssue, getMissionsDependingOn, MissionError } from "./missions.js";
import {
  findPreparedN2Decision,
  recordN2Decision,
  settlePreparedN2ReviewUsage,
} from "./n2-missions.js";

type FinishedRunPayload = {
  runId: string;
  agentId: string;
  issueId: string;
  status: "succeeded";
};

export type N2FinishedEventResult =
  | { outcome: "reconciled" }
  | { outcome: "ignored"; reason: string }
  | { outcome: "prepared"; reason: "usage_not_ready"; attempts: number }
  | { outcome: "prepared"; reason: "receipt_pending"; operationId: string }
  | { outcome: "applied" | "application_unknown"; operationId: string; replayed: boolean };

function uuid(value: unknown): string | null {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

function finishedRun(event: PluginEvent): FinishedRunPayload | null {
  if (event.eventType !== "agent.run.finished" || !event.payload
      || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const runId = uuid(payload.runId);
  const agentId = uuid(payload.agentId);
  const issueId = uuid(payload.issueId);
  if (!runId || !agentId || !issueId || payload.status !== "succeeded"
      || event.entityType !== "heartbeat_run" || event.entityId !== runId
      || event.actorType !== "agent" || event.actorId !== agentId) return null;
  return { runId, agentId, issueId, status: "succeeded" };
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function handleN2RunFinished(
  ctx: PluginContext,
  event: PluginEvent,
  options: { attempts?: number; delayMs?: number; wait?: (milliseconds: number) => Promise<void> } = {},
): Promise<N2FinishedEventResult> {
  const run = finishedRun(event);
  if (!run) return { outcome: "ignored", reason: "event_identity_unqualified" };
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 250;
  const pause = options.wait ?? wait;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 40
      || !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 1_000) {
    throw new Error("Invalid bounded N2 finished-event observation profile");
  }

  let mission = await getMissionByOrdinaryIssue(ctx, event.companyId, run.issueId);
  if (mission?.aggregate.n2?.ordinary) {
    if (mission.aggregate.n5?.publication?.issueId === run.issueId) {
      if (mission.aggregate.n5.publication.runId !== run.runId || physicalAgent(mission, mission.aggregate.n5.authority.publisherAgentId, { issueId: run.issueId, runId: run.runId }) !== run.agentId) return { outcome: "ignored", reason: "n5_child_unbound" };
      await reconcileN5(ctx, mission); return { outcome: "reconciled" };
    }
    const task = mission.aggregate.n2.ordinary.tasks.find(task => task.issueId === run.issueId && task.runId === run.runId && physicalAgent(mission!, task.agentId, { issueId: run.issueId, runId: run.runId }) === run.agentId);
    if (!task) return { outcome: "ignored", reason: "ordinary_task_unbound" };
    const { reconcileOrdinaryN2 } = await import("./n2-ordinary-runtime.js");
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { const latest = await reconcileOrdinaryN2(ctx, mission);
        if (latest.aggregate.n5 && latest.aggregate.n2?.status === "accepted") await reconcileN5(ctx, latest);
        return { outcome: "reconciled" }; }
      catch (error) {
        const retryable = error instanceof AdmissionError && ["g4_usage_unavailable", "g4_run_not_terminal", "version_conflict"].includes(error.code)
          || error instanceof MissionError && error.code === "version_conflict";
        if (!retryable) throw error;
        if (attempt === attempts) return { outcome: "prepared", reason: "usage_not_ready", attempts };
        await pause(delayMs);
        mission = (await getMissionByOrdinaryIssue(ctx, event.companyId, run.issueId))!;
      }
    }
  }
  mission = await getMissionByRootIssue(ctx, event.companyId, run.issueId);
  if (!mission) {
    const issue = await ctx.issues.get(run.issueId, event.companyId);
    if (issue?.parentId) mission = await getMissionByRootIssue(ctx, event.companyId, issue.parentId);
  }
  if (mission?.aggregate.n5?.publication?.issueId === run.issueId) {
    if (mission.aggregate.n5.publication.runId !== run.runId || physicalAgent(mission, mission.aggregate.n5.authority.publisherAgentId, { issueId: run.issueId, runId: run.runId }) !== run.agentId) return { outcome: "ignored", reason: "n5_child_unbound" };
    await reconcileN5(ctx, mission);
    return { outcome: "reconciled" };
  }
  if (mission?.aggregate.n3 && run.issueId !== mission.rootIssueId
      && !mission.aggregate.n3.rounds.some(round => round.specialists.some(item => item.issueId === run.issueId && item.runId === run.runId))) return { outcome: "ignored", reason: "n3_child_unbound" };
  if (!mission?.aggregate.n2) return { outcome: "ignored", reason: "n2_mission_unavailable" };
  if (mission.aggregate.n2.native) {
    const { reconcileNativeN2 } = await import("./n2-native-runtime.js");
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await reconcileNativeN2(ctx, mission);
        const latest = (await getMissionByRootIssue(ctx, event.companyId, mission.rootIssueId))!;
        if (latest.aggregate.n5 && latest.aggregate.n2?.status === "accepted") await reconcileN5(ctx, latest);
        return { outcome: "reconciled" };
      } catch (error) {
        const retryable = error instanceof AdmissionError && ["g4_usage_unavailable", "g4_run_not_terminal", "version_conflict"].includes(error.code)
          || error instanceof MissionError && error.code === "version_conflict";
        if (!retryable) throw error;
        if (attempt === attempts) return { outcome: "prepared", reason: "usage_not_ready", attempts };
        await pause(delayMs);
        mission = (await getMissionByRootIssue(ctx, event.companyId, mission.rootIssueId))!;
      }
    }
  }
  let prepared = findPreparedN2Decision(mission, { runId: run.runId, actorAgentId: run.agentId });
  if (!prepared) return { outcome: "ignored", reason: "prepared_decision_unavailable" };

  const config = parseCouncilConfig(await ctx.config.get(event.companyId));
  if (config.councilAgentId !== run.agentId) {
    return { outcome: "ignored", reason: "configured_reviewer_mismatch" };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      mission = await settlePreparedN2ReviewUsage(ctx, mission, prepared);
      const common = {
        companyId: mission.companyId,
        issueId: mission.rootIssueId,
        actorAgentId: prepared.actorAgentId,
        runId: prepared.runId,
        operationId: prepared.operationId,
        resultReference: prepared.resultReference,
        justification: prepared.justification,
      };
      const decision = prepared.verdict === "approved"
        ? { ...common, verdict: "approved" as const, approvedCommit: prepared.approvedCommit! }
        : { ...common, verdict: "changes_requested" as const };
      if (decision.verdict === "changes_requested" && mission.aggregate.n2!.correctionLimit === 0) {
        // Recheck immediately before the legacy PATCH, including after restart.
        const { assertNativeLeadWakePolicy } = await import("./n2-native-report.js");
        await assertNativeLeadWakePolicy(ctx, mission, true);
      }
      const result = await executeCouncilDecision(ctx, config, decision);
      if (result.replayed && result.receipt.state === "indeterminate") {
        return { outcome: "prepared", reason: "receipt_pending", operationId: prepared.operationId };
      }
      await recordN2Decision(ctx, mission.missionId, prepared, result.receipt);
      return {
        outcome: result.receipt.state === "native_observed" ? "applied" : "application_unknown",
        operationId: prepared.operationId,
        replayed: result.replayed,
      };
    } catch (error) {
      const retryableUsage = error instanceof AdmissionError
        && (error.code === "g4_usage_unavailable" || error.code === "g4_run_not_terminal");
      const retryableVersion = error instanceof MissionError && error.code === "version_conflict";
      if (!retryableUsage && !retryableVersion) {
        if (error instanceof DecisionReceiptError) throw error;
        throw error;
      }
      if (attempt === attempts) return { outcome: "prepared", reason: "usage_not_ready", attempts };
      await pause(delayMs);
      const refreshed = await getMissionByRootIssue(ctx, event.companyId, run.issueId);
      if (!refreshed?.aggregate.n2) return { outcome: "ignored", reason: "n2_mission_unavailable" };
      const refreshedPrepared = findPreparedN2Decision(refreshed, { runId: run.runId, actorAgentId: run.agentId });
      if (!refreshedPrepared) return { outcome: "ignored", reason: "prepared_decision_unavailable" };
      mission = refreshed;
      prepared = refreshedPrepared;
    }
  }
  return { outcome: "prepared", reason: "usage_not_ready", attempts };
}

export function registerN2FinishedEventHandler(ctx: PluginContext) {
  return ctx.events.on("agent.run.finished", async (event) => {
    await observeNativeFinished(ctx, event);
    const run = finishedRun(event);
    if (!run) return;
    const coordination = await getMissionByN6WorkIssue(ctx, event.companyId, run.issueId);
    if (coordination) { await reconcileN6(ctx, coordination); return; }
    await handleN2RunFinished(ctx, event);
    const source = await getMissionByOrdinaryIssue(ctx, event.companyId, run.issueId)
      ?? await getMissionByRootIssue(ctx, event.companyId, run.issueId);
    if (source) for (const target of await getMissionsDependingOn(ctx, source.companyId, source.missionId)) await reconcileN6(ctx, target);
  });
}

async function observeNativeFinished(ctx: PluginContext, event: PluginEvent) {
  const identity = nativeFinishedIdentity(event);
  if (!identity) return;
  const issueId = identity.issueId;
  let mission = await getMissionByN6WorkIssue(ctx, event.companyId, issueId)
    ?? await getMissionByOrdinaryIssue(ctx, event.companyId, issueId) ?? await getMissionByRootIssue(ctx, event.companyId, issueId);
  if (!mission) {
    const issue = await ctx.issues.get(issueId, event.companyId);
    if (issue?.parentId) mission = await getMissionByRootIssue(ctx, event.companyId, issue.parentId);
  }
  if (mission) await assertNativeRunInventory(ctx, mission);
}

function nativeFinishedIdentity(event: PluginEvent) {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return null;
  const runId = uuid(payload.runId), issueId = uuid(payload.issueId), agentId = uuid(payload.agentId);
  if (!runId || !issueId || !agentId) return null;
  const fields = { entityType: "heartbeat_run", entityId: runId, actorType: "agent", actorId: agentId };
  const matches = Object.entries(fields).every(([key, value]) => event[key as keyof typeof fields] === value);
  return matches && ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(String(payload.status)) ? { runId, issueId, agentId } : null;
}
