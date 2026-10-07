import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { handleProjectMandate } from "../src/project-mandate-configuration.js";
import { canonicalPayloadHash } from "../src/missions.js";

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), revision = randomUUID();
  const current = { company_id: companyId, project_id: projectId, version: 1, revision_id: revision, authorized_by: "owner",
    content: { enabled: true, baselineRootIds: ["historical"], operatingProfileHash: "fixed", template: { limits: { correctionLimit: 1 } } } };
  let receipt: any = null;
  const execute = vi.fn(async (_sql: string, params: any[]) => {
    receipt = { ...current, version: 2, revision_id: params[3], command_id: params[4], payload_hash: params[5], content: JSON.parse(params[7]) };
    return { rowCount: 1 };
  });
  const config = vi.fn(async () => { throw new Error("Accounting/actors unavailable"); });
  const ctx = { db: { namespace: "council", query: async (sql: string) => sql.includes("command_id") ? receipt ? [receipt] : [] : [receipt ?? current], execute },
    companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) }, projects: { get: async () => ({ companyId }) }, config: { get: config } } as unknown as PluginContext;
  const input = { method: "POST", companyId, params: { projectId }, actor: { actorType: "user", userId: "owner" },
    body: { companyId, command: "suspend", commandId: randomUUID(), expectedVersion: 1 } } as unknown as PluginApiRequestInput;
  return { ctx, input, execute, config, current };
}
describe("project owner policy versions", () => {
  it("can suspend without available actors or accounting and preserves the original limits and historical baseline", async () => {
    const f = fixture(); const result = await handleProjectMandate(f.ctx, f.input);
    expect(result.body.policy!.content).toEqual({ ...f.current.content, enabled: false });
    expect(f.config).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]![1][5]).toBe(canonicalPayloadHash(f.input.body));
    expect((await handleProjectMandate(f.ctx, f.input)).body.outcome).toBe("replayed"); expect(f.execute).toHaveBeenCalledTimes(1);
    (f.input.body as any).expectedVersion = 2;
    await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_command_conflict" });
  });
  it("rejects another principal before any version write", async () => {
    const f = fixture(); f.input.actor.userId = "other";
    await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_owner_required" });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("requires current versions and explicit new-task delegation and reports a failed CAS without retry", async () => {
    const f = fixture(); (f.input.body as any).expectedVersion = -1;
    await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_authorization_required" });
    (f.input.body as any).expectedVersion = 1; (f.input.body as any).command = "configure";
    await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_authorization_required" });
    (f.input.body as any).command = "suspend"; f.execute.mockResolvedValueOnce({ rowCount: 0 });
    await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_version_conflict" });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
