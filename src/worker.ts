import { registerContinuityJob } from "./continuity-runtime.js";
import { handleProjectMandate } from "./project-mandate-configuration.js";
import { listContinuityMissions } from "./missions.js";
import { handleModelProfiles, chooseModelProfile, inspectModelSelections, reconcileModelMeasurements } from "./model-api.js";
import { ModelSelectionError } from "./model-state.js";
import { handleN6WorkAgent } from "./n6-work-api.js";
import { getMissionByN6WorkIssue } from "./missions.js";
import { handleN6Board } from "./n6-runtime.js";
import { handleN5Agent, handleN5Board } from "./n5-runtime.js";
import { handleN3Specialist } from "./n3-runtime.js";
import { N3OpinionError } from "./n3-opinions.js";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import type { CouncilDecisionPayload } from "./contracts.js";
import { parseCouncilConfig } from "./decision-adapter.js";
import {
  DecisionReceiptError,
  executeCouncilDecision,
  findDecisionReplay,
  handleDecisionReceiptApi,
  registerDecisionReceiptBridge,
  type DecisionReceipt,
} from "./decision-receipts.js";
import { ApprovalPreflightError, verifyApprovalCandidate } from "./delivery-manifest.js";
import { handleFoundationProbe } from "./foundation-probe.js";
import { getMissionByN1Issue, getMissionByOrdinaryIssue, getMissionByRootIssue, handleMissionApi, MissionError } from "./missions.js";
import { handleN1AdmissionApi, handleN1AgentApi } from "./n1-missions.js";
import { handleN2AgentApi, prepareN2Decision, recordN2Decision } from "./n2-missions.js";
import { registerN2FinishedEventHandler } from "./n2-finished-event.js";
import { AdmissionError } from "./admission.js";
import { handleRosterApi, registerRosterBridge } from "./rosters.js";

import { registerMissionTool } from "./mission-tool.js";
import { publicResponse } from "./public-response.js";

let ctx: PluginContext;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}`);
  return value.trim();
}

function parseBody(body: unknown): CouncilDecisionPayload {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (record.verdict !== "changes_requested" && record.verdict !== "approved") {
    throw new Error("verdict must be changes_requested or approved");
  }
  const approvedCommit = record.verdict === "approved" ? record.approvedCommit : undefined;
  if (record.verdict === "approved" && (typeof approvedCommit !== "string" || !/^[a-f0-9]{40}$/.test(approvedCommit))) {
    throw new Error("approvedCommit must be a 40-character lowercase Git commit hash for approved");
  }
  const justification = requiredString(record.justification, "justification");
  const resultReference = requiredString(record.resultReference, "resultReference");
  if (justification.length > 8_000) throw new Error("justification must not exceed 8000 characters");
  if (resultReference.length > 2_048) throw new Error("resultReference must not exceed 2048 characters");
  const operationId = requiredString(record.operationId, "operationId");
  if (operationId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
    throw new Error("operationId must use 1-128 letters, digits, dots, underscores, colons, or hyphens");
  }
  return record.verdict === "approved"
    ? { verdict: "approved", approvedCommit: approvedCommit as string, justification, resultReference, operationId }
    : { verdict: "changes_requested", justification, resultReference, operationId };
}

function decisionResponse(receipt: DecisionReceipt, replayed: boolean) {
  const requestedIssueStatus = receipt.verdict === "changes_requested" ? "in_progress" : "done";
  return {
    status: receipt.state === "native_observed" ? receipt.nativeObservation!.status : 202,
    body: {
      integration: "plugin receipt -> Paperclip secret_ref -> public issue PATCH",
      councilAgentId: receipt.actorAgentId,
      runId: receipt.runId,
      verdict: receipt.verdict,
      requestedIssueStatus,
      nativeStatus: receipt.nativeObservation?.status ?? null,
      nativeResponse: receipt.nativeObservation?.body ?? null,
      receipt,
      replayed,
    },
  };
}

export async function handleDecision(
  input: PluginApiRequestInput,
  context: PluginContext = ctx,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ordinary = await getMissionByOrdinaryIssue(context, input.companyId, input.params.issueId);
  if (ordinary?.aggregate.n2?.ordinary) return { status: 409, body: { code: "ordinary_verdict_required", error: "Use ordinary-verdict on the admitted Council task; no live issue PATCH is a verdict" } };
  let decision;
  try {
    decision = parseBody(input.body);
  } catch (error) {
    return { status: 422, body: { error: error instanceof Error ? error.message : String(error) } };
  }

  const config = parseCouncilConfig(await context.config.get(input.companyId));
  if (input.actor.actorType !== "agent" || input.actor.agentId !== config.councilAgentId) {
    return { status: 403, body: { error: "Configured council identity required" } };
  }
  const runId = requiredString(input.actor.runId, "council run id");
  const issueId = requiredString(input.params.issueId, "issueId");
  const decisionInput = {
    companyId: input.companyId,
    issueId,
    actorAgentId: config.councilAgentId,
    runId,
    ...decision,
  };
  const mission = await getMissionByRootIssue(context, input.companyId, issueId);
  if (mission?.aggregate.n2) {
    try {
      if (mission.aggregate.n2.native) {
        const { decideNativeN2 } = await import("./n2-native-runtime.js");
        return await decideNativeN2(context, mission, input, decisionInput);
      }
      const issue = await context.issues.get(issueId, input.companyId);
      if (!issue) return { status: 404, body: { error: "Issue not found" } };
      if (issue.companyId !== input.companyId || issue.status !== "in_review" || issue.assigneeAgentId !== config.councilAgentId) {
        return { status: 409, body: { error: "Issue is not pending this council" } };
      }
      const n2DecisionInput = {
        operationId: decision.operationId,
        verdict: decision.verdict,
        actorAgentId: config.councilAgentId,
        runId,
        resultReference: decision.resultReference,
        ...(decision.verdict === "approved" ? { approvedCommit: decision.approvedCommit } : {}),
        justification: decision.justification,
      };
      const prepared = await prepareN2Decision(
        context,
        mission,
        n2DecisionInput,
        typeof (input.body as Record<string, unknown>).correctionReservationId === "string"
          ? (input.body as Record<string, unknown>).correctionReservationId as string
          : undefined,
      );
      return {
        status: 202,
        body: {
          integration: "prepared N2 decision -> terminal run event -> settled usage -> public issue PATCH",
          verdict: decision.verdict,
          operationId: decision.operationId,
          runId,
          prepared: true,
          missionVersion: prepared.version,
        },
      };
    } catch (error) {
      if (error instanceof MissionError || error instanceof AdmissionError) {
        return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
      }
      throw error;
    }
  }
  try {
    const replay = await findDecisionReplay(context, config, decisionInput);
    if (replay) {
      if (mission?.aggregate.n2) await recordN2Decision(context, mission.missionId, decisionInput, replay.receipt);
      return decisionResponse(replay.receipt, true);
    }
  } catch (error) {
    if (error instanceof DecisionReceiptError) {
      return { status: error.status, body: { error: error.message, code: error.code, receipt: error.receipt } };
    }
    if (error instanceof MissionError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
  const issue = await context.issues.get(issueId, input.companyId);
  if (!issue) return { status: 404, body: { error: "Issue not found" } };
  if (issue.companyId !== input.companyId || issue.status !== "in_review" || issue.assigneeAgentId !== config.councilAgentId) {
    return { status: 409, body: { error: "Issue is not pending this council" } };
  }

  if (decision.verdict === "approved") {
    try {
      await verifyApprovalCandidate(context, issue, input.companyId, decision.approvedCommit);
    } catch (error) {
      if (!(error instanceof ApprovalPreflightError)) throw error;
      return { status: error.status, body: { error: error.message } };
    }
  }

  try {
    const result = await executeCouncilDecision(context, config, decisionInput);
    if (mission?.aggregate.n2) await recordN2Decision(context, mission.missionId, decisionInput, result.receipt);
    return decisionResponse(result.receipt, result.replayed);
  } catch (error) {
    if (error instanceof DecisionReceiptError) {
      return { status: error.status, body: { error: error.message, code: error.code, receipt: error.receipt } };
    }
    if (error instanceof MissionError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}

async function handleInspection(input: PluginApiRequestInput, context: PluginContext) {
  const mission = await getMissionByRootIssue(context, input.companyId, input.params.issueId)
    ?? await getMissionByN1Issue(context, input.companyId, input.params.issueId);
  if (mission && !(input.body as Record<string, unknown>).missionId) {
    input = { ...input, body: { ...(input.body as Record<string, unknown>), missionId: mission.missionId } };
  }
  return mission?.aggregate.n2 && input.params.issueId === mission.rootIssueId ? handleN2AgentApi(input, context) : handleN1AgentApi(input, context);
}

async function handleMissionAgentCommand(input: PluginApiRequestInput, context: PluginContext) {
  const command = input.body && typeof input.body === "object" && !Array.isArray(input.body)
    ? (input.body as Record<string, unknown>).command : null;
  if (String(command).startsWith("n6-") || await getMissionByN6WorkIssue(context, input.companyId, input.params.issueId)) return handleN6WorkAgent(context, input);
  if (typeof command === "string" && command.startsWith("n5-")) return handleN5Agent(context, input);
  const ordinary = await getMissionByOrdinaryIssue(context, input.companyId, input.params.issueId);
  if (ordinary) return handleN2AgentApi(input, context);
  if (["n3-inspect", "n3-opinion"].includes(command as string)) {
    try { return { status: 200, body: await handleN3Specialist(context, input) }; }
    catch (error) {
      if (error instanceof N3OpinionError) return { status: 409, body: { code: error.code, error: error.message } };
      if (error instanceof MissionError || error instanceof AdmissionError) return { status: error.status, body: { code: error.code, error: error.message } };
      throw error;
    }
  }
  if (command === "inspect") return handleInspection(input, context);
  if (["ordinary-inspect", "ordinary-verdict", "confirm-review-handoff", "prepare-resubmission", "attest-transmission", "attest-n3-transmission", "n3-synthesize"].includes(command as string)) {
    return handleN2AgentApi(input, context);
  }
  return handleN1AgentApi(input, context);
}

export async function handlePluginRequest(input: PluginApiRequestInput, context: PluginContext = ctx) {
  try { return publicResponse(await handleRequest(input, context)); }
  catch (error) {
    if (error instanceof ModelSelectionError) return publicResponse({ status: 409, body: { code: error.code, error: error.message, details: error.details } });
    if (error instanceof MissionError) return publicResponse({ status: error.status, body: { code: error.code, error: error.message, details: error.details } });
    throw error;
  }
}
async function handleRequest(input: PluginApiRequestInput, context: PluginContext) {
  if (input.params.companyId !== undefined && input.params.companyId !== input.companyId) {
    throw new MissionError(403, "company_scope_mismatch", "Path company does not match the host-authorized company scope");
  }
  if (input.routeKey.startsWith("model-profiles-")) return handleModelProfiles(context, input);
  if (input.routeKey.startsWith("project-mandate-")) return handleProjectMandate(context, input);
  if (input.routeKey === "model-selection-read") return inspectModelSelections(context, input);
  const profileCommand = (input.body as { command?: string } | null)?.command;
  if (["mission-command", "mission-agent-command"].includes(input.routeKey) && profileCommand === "select-model-profile") return chooseModelProfile(context, input);
  if (input.routeKey === "mission-command" && profileCommand === "reconcile-model-measurements") return reconcileModelMeasurements(context, input);
  if (input.routeKey === "mission-command" && ["configure-result-dependency", "reconcile-result-dependency", "transfer-result-coordinator", "rebind-result-dependency", "resolve-result-coordination"].includes(String((input.body as { command?: string })?.command))) return handleN6Board(context, input);
  if (input.routeKey === "decision") return handleDecision(input, context);
  if (input.routeKey.startsWith("council-decision")) return handleDecisionReceiptApi(input, context);
  if (input.routeKey === "admission-read" || input.routeKey === "admission-command") return handleN1AdmissionApi(input, context);
  if (input.routeKey === "mission-agent-command") return handleMissionAgentCommand(input, context);
  if (input.routeKey.startsWith("roster")) return handleRosterApi(input, context);
  if (input.routeKey === "mission-command" && ["configure-delivery", "reconcile-delivery", "request-delivery-correction"].includes(String((input.body as { command?: string })?.command))) return handleN5Board(context, input);
  if (input.routeKey.startsWith("mission")) return handleMissionApi(input, context);
  if (input.routeKey !== "foundation-probe") {
    return { status: 404, body: { error: "Unknown route" } };
  }
  try {
    const config = parseCouncilConfig(await context.config.get(input.companyId));
    return await handleFoundationProbe(input, context, config);
  } catch (error) {
    return { status: 422, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    registerMissionTool(context, input => handlePluginRequest(input, context));
    registerRosterBridge(context);
    registerDecisionReceiptBridge(context);
    registerN2FinishedEventHandler(context);
    registerContinuityJob(context, () => listContinuityMissions(context));
  },
  async onHealth() { return { status: "ok", message: "Council decision adapter ready" }; },
  async onApiRequest(input) { return handlePluginRequest(input); },
});

export default plugin;
runWorker(plugin, import.meta.url);
