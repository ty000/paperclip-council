import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ProjectMandate } from "../src/project-mandate-state.js";
import { rebindUnstartedTask } from "../src/project-intake-rebind.js";
function fixture() {
  let row: any = { company_id: "company", project_id: "project", root_issue_id: "root", mission_id: "retained", policy_revision_id: "v1", version: 4,
    state: { commands: {}, questions: { old: { confirmed: true } } } };
  const execute = vi.fn(async (_sql: string, p: any[]) => { if (p[5] !== row.version) return { rowCount: 0 };
    row = { ...row, policy_revision_id: p[1], state: JSON.parse(p[0]), version: row.version + 1 }; return { rowCount: 1 }; });
  const ctx = { db: { namespace: "council", query: async () => [structuredClone(row)], execute } } as unknown as PluginContext;
  const policy = { companyId: "company", projectId: "project", authorizedBy: "owner", revisionId: "v2", content: { enabled: true, baselineRootIds: [] } } as unknown as ProjectMandate;
  const body = { commandId: randomUUID(), rootIssueId: "root", policyRevisionId: "v2", authorizeRebind: true, expectedIntakeVersion: 4 };
  return { ctx, policy, body, execute, row: () => row };
}
describe("explicit unstarted intake revision", () => {
  it("preserves mission identity, questions and history and replays only the original command", async () => {
    const f = fixture(); await rebindUnstartedTask(f.ctx, f.policy, "owner", f.body);
    expect(f.row()).toMatchObject({ mission_id: "retained", policy_revision_id: "v2", state: { questions: { old: { confirmed: true } } } });
    expect(f.row().state.policyRebindings[0]).toMatchObject({ fromRevisionId: "v1", toRevisionId: "v2" });
    expect((await rebindUnstartedTask(f.ctx, f.policy, "owner", f.body)).outcome).toBe("replayed"); expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(rebindUnstartedTask(f.ctx, f.policy, "owner", { ...f.body, authorizeRebind: false })).rejects.toMatchObject({ code: "project_rebind_identity" });
  });
  it.each(["createBody", "snapshot", "plan", "commands", "linearIntake"])("refuses %s preparation or uncertainty without changing any state", async field => {
    const f = fixture(); f.row().state[field] = { original: "retained" };
    await expect(rebindUnstartedTask(f.ctx, f.policy, "owner", f.body)).rejects.toMatchObject({ code: "project_rebind_unavailable" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("refuses stale versions, excluded roots and failed CAS without retry", async () => {
    const f = fixture(); f.body.expectedIntakeVersion = 3;
    await expect(rebindUnstartedTask(f.ctx, f.policy, "owner", f.body)).rejects.toMatchObject({ code: "project_rebind_unavailable" });
    f.body.expectedIntakeVersion = 4; f.policy.content.baselineRootIds = ["root"];
    await expect(rebindUnstartedTask(f.ctx, f.policy, "owner", f.body)).rejects.toMatchObject({ code: "project_rebind_unavailable" });
    f.policy.content.baselineRootIds = []; f.execute.mockResolvedValueOnce({ rowCount: 0 });
    await expect(rebindUnstartedTask(f.ctx, f.policy, "owner", f.body)).rejects.toMatchObject({ code: "project_rebind_version" });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
