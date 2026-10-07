import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
const fake = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for("nodejs.util.promisify.custom")]: fake.execute,
}) }));
import { assertWorkspacePreflight, readWorkspacePreflightProfile } from "../src/workspace-preflight.js";

function fixture() {
  const profile = { codexHome: "/native/company/home", codexCommand: "/tools/codex", sandboxHelper: "/tools/codex-linux-sandbox" };
  const mission = { companyId: "company", projectId: "project", aggregate: { workspacePreflight: profile } } as unknown as MissionRecord;
  const get = vi.fn(async () => ({ id: "project", companyId: "company", archivedAt: null, primaryWorkspace: { cwd: "/workspace/clone" } }));
  const ctx = { projects: { get } } as unknown as PluginContext;
  const report = { schemaVersion: "council-workspace-preflight.v1", status: "pass", repository: "/workspace/clone", codexHome: profile.codexHome,
    providerTurns: 0, nativeAgentExecutionObserved: false, githubAccessObserved: false,
    checks: { boundedSandbox: true, gitTemporaryIndexWrite: true, workspacePreserved: true, homeConfigPreserved: true } };
  fake.execute.mockResolvedValue({ stdout: JSON.stringify(report) });
  return { ctx, mission, profile, get, report };
}
beforeEach(() => vi.resetAllMocks());

it("does not inspect or upgrade a historical mission without opt-in", async () => {
  const f = fixture(); delete f.mission.aggregate.workspacePreflight;
  expect(await assertWorkspacePreflight(f.ctx, f.mission)).toBeUndefined();
  expect(f.get).not.toHaveBeenCalled(); expect(fake.execute).not.toHaveBeenCalled();
});
it("uses the mission's pinned home and current explicit project workspace without any wake", async () => {
  const f = fixture(); expect(await assertWorkspacePreflight(f.ctx, f.mission)).toEqual(f.report);
  const [command, args, options] = fake.execute.mock.calls[0]!;
  expect(command).toBe("python3");
  expect(args.slice(1)).toEqual(["probe", "--repo", "/workspace/clone", "--codex-home", f.profile.codexHome,
    "--codex-command", f.profile.codexCommand, "--sandbox-helper", f.profile.sandboxHelper]);
  expect(args[0]).toMatch(/scripts\/operations\/workspace_preflight\.py$/);
  expect(options.timeout).toBe(55_000);
});
it("rejects a changed company/workspace before invoking any local process", async () => {
  const f = fixture(); f.get.mockResolvedValue({ companyId: "other", primaryWorkspace: { cwd: "/foreign" } } as never);
  await expect(assertWorkspacePreflight(f.ctx, f.mission)).rejects.toMatchObject({ code: "workspace_preflight_workspace_unknown" });
  expect(fake.execute).not.toHaveBeenCalled();
});
it.each([
  { status: "blocked" }, { codexHome: "/wrong-home" }, { repository: "/sibling" }, { providerTurns: 1 },
  { checks: { boundedSandbox: true, gitTemporaryIndexWrite: true, workspacePreserved: false, homeConfigPreserved: true } },
])("refuses inconclusive or mismatched probe readback: %j", async patch => {
  const f = fixture(); fake.execute.mockResolvedValue({ stdout: JSON.stringify({ ...f.report, ...patch }) });
  await expect(assertWorkspacePreflight(f.ctx, f.mission)).rejects.toMatchObject({ code: "workspace_preflight_blocked" });
  expect(fake.execute).toHaveBeenCalledTimes(1);
});
it("retains a structured blocked report and does not retry the probe", async () => {
  const f = fixture(); const report = { schemaVersion: "council-workspace-preflight.v1", status: "blocked", reason: "sandbox_git_write_failed" };
  fake.execute.mockRejectedValue({ stdout: JSON.stringify(report), stderr: "private diagnostic" });
  await expect(assertWorkspacePreflight(f.ctx, f.mission)).rejects.toMatchObject({ code: "workspace_preflight_blocked", details: report });
  expect(fake.execute).toHaveBeenCalledTimes(1);
});
it("does not expose arbitrary transport diagnostics as a readiness report", async () => {
  const f = fixture(); fake.execute.mockRejectedValue({ stdout: "invalid response", stderr: "secret-looking diagnostic" });
  await expect(assertWorkspacePreflight(f.ctx, f.mission)).rejects.toMatchObject({ code: "workspace_preflight_unavailable" });
});
it("validates optional registration without inferring a home", () => {
  expect(readWorkspacePreflightProfile(undefined)).toBeUndefined();
  expect(readWorkspacePreflightProfile({ codexHome: "/home/native" })).toEqual({ codexHome: "/home/native" });
  for (const invalid of [null, [], { codexHome: "relative" }, { codexHome: "/home", codexCommand: "codex" },
    { codexHome: "/home", sandboxHelper: "relative" }, { codexHome: "/home", unexpected: true }]) {
    expect(() => readWorkspacePreflightProfile(invalid)).toThrow(/registration|absolute/);
  }
});
