import type { PluginApiRequestInput, PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { missionToolDeclaration } from "./manifest.js";
import { councilNativeRequest } from "./decision-adapter.js";
import { readNativeRun, readOrdinaryRun } from "./g4-native.js";
import { AdmissionError } from "./admission.js";
import { getMissionByOrdinaryIssue, getMissionByN6WorkIssue, MissionError } from "./missions.js";

const agentCommands = new Set(["select-model-profile", "n6-inspect", "n6-coordinate", "n6-facilitation-outcome", "inspect", "plan", "materialize", "dispatch", "reconcile-usage", "record-contribution", "publish",
  "ordinary-inspect", "ordinary-verdict",
  "confirm-review-handoff", "prepare-resubmission", "attest-transmission", "attest-n3-transmission", "n3-inspect", "n3-opinion", "n3-synthesize",
  "n5-inspect", "n5-rebind-plan", "n5-claim-publication", "n5-observe-delivery"]);
export async function missionToolRequest(ctx: PluginContext, value: unknown, runCtx: ToolRunContext): Promise<PluginApiRequestInput> {
  const params = value as { operation?: string; body?: Record<string, unknown> };
  if (!params || Object.keys(params).some(k => !["operation", "body"].includes(k)) || !["command", "decision"].includes(params.operation ?? "")
      || !params.body || typeof params.body !== "object" || Array.isArray(params.body)) throw new MissionError(422, "mission_tool_input", "Only operation and command body are accepted");
  if (params.operation === "command" && !agentCommands.has(String(params.body.command))) throw new MissionError(403, "mission_tool_agent_only", "Only existing agent commands are available; owner commands require the board API");
  if (Object.keys(params.body).some(key => ["actor", "actorType", "actorId", "agentId", "companyId", "runId", "issueId", "projectId", "headers"].includes(key))) {
    throw new MissionError(422, "mission_tool_identity_override", "Caller identity and issue come from the native gateway and run readback");
  }
  if (![runCtx.companyId, runCtx.agentId, runCtx.runId].every(value => typeof value === "string" && /^[a-zA-Z0-9-]+$/.test(value))) {
    throw new MissionError(403, "mission_tool_context", "Exact native company, agent and run context required");
  }
  // The runner gateway authenticates the JWT identity. Board callers retain the host's
  // separate authority; ToolRunContext itself does not attest an actor type.
  const response = await councilNativeRequest(ctx, runCtx.companyId, `/api/heartbeat-runs/${runCtx.runId}`);
  const publicRun = response.body as { nativeIssueId?: string; contextSnapshot?: { issueId?: string } } | null;
  const issueId = publicRun?.nativeIssueId ?? publicRun?.contextSnapshot?.issueId;
  if (response.status !== 200 || !issueId) throw new MissionError(409, "mission_tool_issue", "Native run must identify its issue");
  const ordinary = publicRun?.nativeIssueId ? null : (await getMissionByOrdinaryIssue(ctx, runCtx.companyId, issueId) ?? await getMissionByN6WorkIssue(ctx, runCtx.companyId, issueId));
  const run = await (ordinary ? readOrdinaryRun : readNativeRun)(ctx, { ...runCtx, issueId });
  if (run.status !== "running" || !run.startedAt || run.finishedAt) throw new MissionError(409, "mission_tool_inactive", "Exact native run must be active");
  const issue = await ctx.issues.get(issueId, runCtx.companyId);
  if (!issue || issue.companyId !== runCtx.companyId || (runCtx.projectId && issue.projectId !== runCtx.projectId)) {
    throw new MissionError(409, "mission_tool_issue", "Native issue must match gateway company and project");
  }
  return { routeKey: params.operation === "decision" ? "decision" : "mission-agent-command", method: "POST",
    path: `/issues/${issueId}/${params.operation === "decision" ? "decision" : "mission"}`, params: { issueId }, query: {},
    body: params.body, companyId: runCtx.companyId, headers: {},
    actor: { actorType: "agent", actorId: runCtx.agentId, agentId: runCtx.agentId, runId: runCtx.runId } };
}

export function registerMissionTool(ctx: PluginContext, dispatch: (request: PluginApiRequestInput) => Promise<{ status?: number; body?: unknown }>) {
  ctx.tools.register("mission-command", missionToolDeclaration, async (params, runCtx) => {
    try {
      const result = await dispatch(await missionToolRequest(ctx, params, runCtx));
      return { data: result, ...(result.status && result.status >= 400 ? { error: `Council command refused (${result.status})` } : {}) };
    } catch (error) {
      if (!(error instanceof MissionError || error instanceof AdmissionError)) throw error;
      return { data: { status: error.status, body: { code: error.code, error: error.message } }, error: error.message };
    }
  });
}
