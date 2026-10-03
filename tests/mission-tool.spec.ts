import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/decision-adapter.js", () => ({ councilNativeRequest: vi.fn() }));
import { councilNativeRequest } from "../src/decision-adapter.js";
import { missionToolRequest, registerMissionTool } from "../src/mission-tool.js";
const binding = { companyId: "company", agentId: "agent", runId: "run", projectId: "project" };
const run = { id: "run", companyId: "company", agentId: "agent", nativeIssueId: "issue", contextSnapshot: { issueId: "issue" }, status: "running", startedAt: "now", finishedAt: null };
const ctx = { issues: { get: vi.fn() }, tools: { register: vi.fn() } };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: run }); ctx.issues.get.mockResolvedValue({ companyId: "company", projectId: "project" }); });
it("binds existing dispatch exclusively to the native gateway context and run issue", async () => {
  const request = await missionToolRequest(ctx as never, { operation: "command", body: { command: "inspect", missionId: "mission" } }, binding);
  expect(request).toMatchObject({ routeKey: "mission-agent-command", companyId: "company", params: { issueId: "issue" }, actor: { actorType: "agent", actorId: "agent", runId: "run" } });
});
it.each(["companyId", "agentId", "actor", "runId", "issueId", "projectId", "headers"])("refuses model identity override %s", async key => {
  await expect(missionToolRequest(ctx as never, { operation: "command", body: { command: "inspect", [key]: "other" } }, binding)).rejects.toMatchObject({ code: "mission_tool_identity_override" });
  expect(councilNativeRequest).not.toHaveBeenCalled();
});
it.each(["start-review", "configure-delivery", "request-delivery-correction", "start-lead", "configure"])("refuses owner command %s", async command => {
  await expect(missionToolRequest(ctx as never, { operation: "command", body: { command } }, binding)).rejects.toMatchObject({ code: "mission_tool_agent_only" });
});
it.each([{ agentId: "other" }, { companyId: "other" }, { contextSnapshot: { issueId: "other" } }, { status: "succeeded" }])("rejects mismatched or finished run %j", async patch => {
  vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: { ...run, ...patch } });
  await expect(missionToolRequest(ctx as never, { operation: "decision", body: { verdict: "approved" } }, binding)).rejects.toThrow();
});
it("registers a single adapter and delegates decision validation without reimplementing it", async () => {
  const dispatch = vi.fn().mockResolvedValue({ status: 422, body: { code: "existing_guard" } });
  registerMissionTool(ctx as never, dispatch);
  const callback = ctx.tools.register.mock.calls[0]![2];
  expect(await callback({ operation: "decision", body: { verdict: "approved" } }, binding)).toMatchObject({ data: { status: 422, body: { code: "existing_guard" } } });
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ routeKey: "decision", params: { issueId: "issue" } }));
});
