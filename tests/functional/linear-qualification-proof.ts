import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { LinearHost } from "./linear-intake-host.js";
import { hierarchyLaunchGuidance } from "../../src/hierarchy-guidance.js";
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const councilSchema = "plugin_private_paperclip_council_270061461e";

export function verifyNativeSourceDescription(issue: { id: string; description: string }, original: string, missions: any[]) {
  const guidance = missions.map(mission => hierarchyLaunchGuidance(mission, issue.id)).filter(Boolean);
  const allowed = [original, ...guidance.map(text => `${original}\n\n${text}`)];
  assert(allowed.includes(issue.description), "Only the exact native Council execution guidance may accompany the retained source description");
}

async function buildFiles(root: string, directory = "dist"): Promise<string[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return buildFiles(root, path);
    assert(entry.isFile(), `Build evidence must contain ordinary files: ${path}`);
    return [path];
  }));
  return nested.flat();
}

export async function packageDigests(root: string) {
  const tracked = git(root, "ls-files", "src", "migrations", "package.json").split("\n");
  const added = git(root, "ls-files", "--others", "--exclude-standard", "src", "migrations").split("\n").filter(Boolean);
  const paths = [...new Set([...tracked, ...added, ...await buildFiles(root)])]
    .filter(Boolean).sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path,
    createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
}

export async function journals(host: LinearHost, companyId: string) {
  const intake = await host.db.$client.unsafe(`SELECT root_issue_id, mission_id, policy_revision_id, version, state
    FROM ${councilSchema}.project_task_intakes WHERE company_id = $1 ORDER BY root_issue_id`, [companyId]);
  const challenges = await host.db.$client.unsafe(`SELECT challenge_id, mission_id, stage, generation, request_hash,
    response, consumed_at FROM ${councilSchema}.linear_intake_challenges WHERE company_id = $1 ORDER BY created_at`, [companyId]);
  return { intake: Array.from(intake) as any[], challenges: Array.from(challenges) as any[] };
}

export async function jobRuns(host: LinearHost, pluginId: string) {
  const jobs = await host.api("GET", `/api/plugins/${pluginId}/jobs`);
  return Promise.all(jobs.map(async (job: any) => ({ jobKey: job.jobKey,
    runs: await host.api("GET", `/api/plugins/${pluginId}/jobs/${job.id}/runs`) })));
}

