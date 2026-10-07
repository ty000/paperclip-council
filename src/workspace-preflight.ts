import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { ModelSelectionError } from "./model-state.js";

const execute = promisify(execFile);

/** Operator registration of the observed native home, not automatic discovery. */
export type WorkspacePreflightProfile = {
  codexHome: string;
  codexCommand?: string;
  sandboxHelper?: string;
};

export function readWorkspacePreflightProfile(value: unknown): WorkspacePreflightProfile | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelSelectionError("workspace_preflight_config_invalid", "Workspace preflight requires an explicit native home registration");
  }
  const profile = value as Record<string, unknown>;
  if (Object.keys(profile).some(key => !["codexHome", "codexCommand", "sandboxHelper"].includes(key))
    || typeof profile.codexHome !== "string" || !isAbsolute(profile.codexHome)
    || profile.codexCommand !== undefined && (typeof profile.codexCommand !== "string" || !isAbsolute(profile.codexCommand))
    || profile.sandboxHelper !== undefined && (typeof profile.sandboxHelper !== "string" || !isAbsolute(profile.sandboxHelper))) {
    throw new ModelSelectionError("workspace_preflight_config_invalid", "Home and optional executable registrations require absolute paths");
  }
  return { codexHome: profile.codexHome, ...(profile.codexCommand ? { codexCommand: profile.codexCommand as string } : {}),
    ...(profile.sandboxHelper ? { sandboxHelper: profile.sandboxHelper as string } : {}) };
}

/** Read/probe only. Runs before selection/child creation and again before wake claim. */
export async function assertWorkspacePreflight(ctx: PluginContext, mission: MissionRecord) {
  const profile = mission.aggregate.workspacePreflight;
  if (!profile) return;
  const project = await ctx.projects.get(mission.projectId, mission.companyId);
  const cwd = project?.primaryWorkspace?.cwd;
  if (!project || project.companyId !== mission.companyId || project.archivedAt || !cwd || !isAbsolute(cwd)) {
    throw new ModelSelectionError("workspace_preflight_workspace_unknown", "A current explicit primary workspace is required before dispatch");
  }
  const script = fileURLToPath(new URL("../scripts/operations/workspace_preflight.py", import.meta.url));
  const args = [script, "probe", "--repo", cwd, "--codex-home", profile.codexHome];
  if (profile.codexCommand) args.push("--codex-command", profile.codexCommand);
  if (profile.sandboxHelper) args.push("--sandbox-helper", profile.sandboxHelper);
  let output: string;
  try {
    const result = await execute("python3", args, { timeout: 55_000, maxBuffer: 128 * 1024 });
    output = result.stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (stdout) {
      let report: Record<string, unknown> | undefined;
      try { report = JSON.parse(stdout); } catch { /* Transport errors are not a probe verdict. */ }
      if (report?.schemaVersion === "council-workspace-preflight.v1" && report.status === "blocked") {
        throw new ModelSelectionError("workspace_preflight_blocked", "Workspace sandbox preflight blocked the launch before wake", report);
      }
    }
    throw new ModelSelectionError("workspace_preflight_unavailable", "No conclusive provider-free workspace probe; launch remains unclaimed");
  }
  let report: Record<string, unknown>;
  try { report = JSON.parse(output); } catch {
    throw new ModelSelectionError("workspace_preflight_unavailable", "Invalid workspace probe response");
  }
  const checks = report.checks as Record<string, unknown> | undefined;
  if (report.schemaVersion !== "council-workspace-preflight.v1" || report.status !== "pass"
    || report.repository !== cwd || report.codexHome !== profile.codexHome || report.providerTurns !== 0
    || !checks || ["boundedSandbox", "gitTemporaryIndexWrite", "workspacePreserved", "homeConfigPreserved"].some(key => checks[key] !== true)) {
    throw new ModelSelectionError("workspace_preflight_blocked", "Workspace probe did not establish bounded Git writes and state preservation", report);
  }
  return report;
}
