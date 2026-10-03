import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** An explicitly simulated active heartbeat, not a campaign execution or provider proof. */
export async function n45ToolBoundary(input: any, campaign: any) {
  const { PaperclipRunnerToolAuthority } = await input.hostImport("server/src/services/native-runtime/paperclip-runner-tool-authority.ts");
  const issue = await campaign.api("POST", `/api/companies/${campaign.companyId}/issues`, { title: "Provider-free native gateway contract fixture", projectId: campaign.projectId, assigneeAgentId: campaign.agents.quality.id, status: "backlog" });
  const binding = { companyId: campaign.companyId, agentId: campaign.agents.quality.id, issueId: issue.id, runId: randomUUID(), projectId: campaign.projectId };
  await input.db.insert(input.tables.heartbeatRuns).values({ id: binding.runId, companyId: binding.companyId, agentId: binding.agentId,
    nativeIssueId: issue.id, runtimeMode: "native", invocationSource: "on_demand", triggerDetail: "fixture:n45:gateway-only", status: "running",
    responsibleUserId: input.ownerUserId, contextSnapshot: { issueId: issue.id, fixture: "fixture:n45:gateway-only", providerInvocation: "none" }, startedAt: new Date() });
  await input.db.update(input.tables.issues).set({ executionRunId: binding.runId, checkoutRunId: binding.runId }).where(input.eq(input.tables.issues.id, issue.id));
  const authority = new PaperclipRunnerToolAuthority(input.db, { ...binding, apiUrl: input.baseUrl, apiToolsEnabled: true });
  const call = async (operationId: string, body?: any) => authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId, ...(body ? { body } : {}) } });
  const runContext = { companyId: binding.companyId, agentId: binding.agentId, runId: binding.runId, projectId: binding.projectId };
  try {
    const catalog = await call("GET /api/plugins/tools");
    assert(JSON.stringify(catalog).includes("mission-command"), "native runner catalogue must expose Council tool");
    const execute = (parameters: any, context = runContext) => call("POST /api/plugins/tools/execute", { tool: "private.paperclip-council:mission-command", parameters, runContext: context });
    // A real handler refusal proves dispatch reached Council with this native identity.
    // The fixture is deliberately outside the campaign mission and must not mutate it.
    const nominal = await execute({ operation: "command", body: { command: "inspect", missionId: campaign.missionId } });
    assert(JSON.stringify(nominal).includes("mission_inactive"), JSON.stringify(nominal));
    const owner = await execute({ operation: "command", body: { command: "configure-delivery" } });
    assert(JSON.stringify(owner).includes("mission_tool_agent_only"), JSON.stringify(owner));
    const override = await execute({ operation: "command", body: { command: "inspect", issueId: campaign.rootIssueId } });
    assert(JSON.stringify(override).includes("mission_tool_identity_override"), JSON.stringify(override));
    const contextOverride = await execute({ operation: "command", body: { command: "inspect" } }, { ...runContext, agentId: campaign.agents.lead.id });
    assert(!JSON.stringify(contextOverride).includes("mission_inactive"));
    return { fixture: "one directly inserted active native heartbeat; no provider or wake", binding, catalog, nominal, owner, override, contextOverride,
      chain: "PaperclipRunnerToolAuthority.call_api -> run JWT -> HTTP auth -> plugin gateway -> Council adapter -> existing handler" };
  } finally {
    await input.db.update(input.tables.heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(input.eq(input.tables.heartbeatRuns.id, binding.runId));
    await input.db.update(input.tables.issues).set({ executionRunId: null, checkoutRunId: null }).where(input.eq(input.tables.issues.id, issue.id));
  }
}
