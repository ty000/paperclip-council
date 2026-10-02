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
import { getMissionByRootIssue, handleMissionApi, MissionError } from "./missions.js";
import { handleN1AdmissionApi, handleN1AgentApi } from "./n1-missions.js";
import { handleN2AgentApi, prepareN2Decision, recordN2Decision } from "./n2-missions.js";
import { registerN2FinishedEventHandler } from "./n2-finished-event.js";
import { AdmissionError } from "./admission.js";
import { handleRosterApi, registerRosterBridge } from "./rosters.js";

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

export async function handlePluginRequest(input: PluginApiRequestInput, context: PluginContext = ctx) {
  if (input.routeKey === "decision") return handleDecision(input, context);
  if (input.routeKey.startsWith("council-decision")) return handleDecisionReceiptApi(input, context);
  if (input.routeKey === "admission-read" || input.routeKey === "admission-command") return handleN1AdmissionApi(input, context);
  if (input.routeKey === "mission-agent-command") {
    const command = input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>).command : null;
    if (command === "inspect") {
      const mission = await getMissionByRootIssue(context, input.companyId, input.params.issueId);
      if (mission?.aggregate.n2) return handleN2AgentApi(input, context);
    }
    if (command === "confirm-review-handoff" || command === "prepare-resubmission") {
      return handleN2AgentApi(input, context);
    }
    return handleN1AgentApi(input, context);
  }
  if (input.routeKey.startsWith("roster")) return handleRosterApi(input, context);
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
    registerRosterBridge(context);
    registerDecisionReceiptBridge(context);
    registerN2FinishedEventHandler(context);
  },
  async onHealth() { return { status: "ok", message: "Council decision adapter ready" }; },
  async onApiRequest(input) { return handlePluginRequest(input); },
});

export default plugin;
runWorker(plugin, import.meta.url);
