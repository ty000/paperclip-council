import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
} from "@paperclipai/plugin-sdk";
import type { CouncilDecisionPayload } from "./contracts.js";
import { emitCouncilDecision, parseCouncilConfig } from "./decision-adapter.js";
import { ApprovalPreflightError, verifyApprovalCandidate } from "./delivery-manifest.js";

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
  return record.verdict === "approved"
    ? { verdict: "approved", approvedCommit: approvedCommit as string, justification, resultReference }
    : { verdict: "changes_requested", justification, resultReference };
}

export async function handleDecision(input: PluginApiRequestInput, context: PluginContext = ctx) {
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

  const result = await emitCouncilDecision(context, config, {
    companyId: input.companyId,
    issueId,
    runId,
    ...decision,
  });
  return {
    status: result.nativeStatus,
    body: {
      integration: "plugin route -> Paperclip secret_ref -> public issue PATCH",
      councilAgentId: config.councilAgentId,
      runId,
      ...result,
    },
  };
}

const plugin = definePlugin({
  async setup(context) { ctx = context; },
  async onHealth() { return { status: "ok", message: "Council decision adapter ready" }; },
  async onApiRequest(input) {
    if (input.routeKey !== "decision") return { status: 404, body: { error: "Unknown route" } };
    return handleDecision(input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
