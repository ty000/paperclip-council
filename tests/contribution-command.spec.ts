import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contributionCommand } from "../src/contribution-command.js";
import { contributionDescription, inspectN1State } from "../src/n1-missions.js";
import type { MissionRecord } from "../src/missions.js";

const missionId = randomUUID(), contributionId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
const key = "test-only-not-a-real-credential";
let directory: string, endpoint: string, server: Server;
let requests: Array<{ body: any; auth?: string; run?: string; url?: string }>;
let recorded: string | undefined;
let mode: "ok" | "refused" | "lost" | "moved";

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function execute() {
  // Exercise the exact shell block a native contributor receives, in an unrelated repo.
  const description = contributionDescription({ missionId, contributionId, ownedPaths: ["panel.ts"] });
  const command = description.split("```sh\n")[1]!.split("\n```")[0]!;
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("bash", ["-s"], {
      cwd: directory,
      env: { ...process.env, PAPERCLIP_API_URL: endpoint, PAPERCLIP_API_KEY: key, PAPERCLIP_RUN_ID: runId, PAPERCLIP_TASK_ID: issueId },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
    child.stdin.end(command);
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "council-contribution-command-"));
  git("init", "--quiet");
  git("config", "user.name", "Transport test");
  git("config", "user.email", "transport@example.test");
  await writeFile(join(directory, "panel.ts"), "export const panel = true;\n");
  git("add", "panel.ts");
  git("commit", "--quiet", "-m", "Panel");
  requests = []; recorded = undefined; mode = "ok";
  server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, auth: request.headers.authorization, run: request.headers["x-paperclip-run-id"] as string, url: request.url });
    if (body.command === "inspect") {
      const n1 = inspectN1State({ aggregate: {
        phase: "executing", readiness: { blockers: [] },
        n1: { contributions: [{ contributionId, childIssueId: issueId, commit: recorded }], periodKey: "test" },
      } } as unknown as MissionRecord);
      if (mode === "moved") git("commit", "--quiet", "--allow-empty", "-m", "Concurrent writer");
      response.end(JSON.stringify({ missionId, version: 26, n1 }));
      return;
    }
    if (mode === "refused") {
      response.writeHead(409);
      response.end(JSON.stringify({ code: "version_conflict", detail: key }));
    } else {
      recorded = body.commit;
      if (mode === "lost") response.destroy();
      else response.end(JSON.stringify({ outcome: "applied", mission: { aggregate: { n1: { contributions: [{ contributionId, commit: recorded }] } } } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server");
  endpoint = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

describe("generated contribution transport", () => {
  it("sends actual full Git HEAD and authenticated run through the public inspection shape", async () => {
    const head = git("rev-parse", "HEAD");
    const result = await execute();
    expect(result.code).toBe(0);
    expect(requests.map(r => r.body.command)).toEqual(["inspect", "record-contribution"]);
    expect(requests[1]!.body).toMatchObject({ missionId, contributionId, commit: head, expectedVersion: 26 });
    expect(requests[1]!.body.commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requests[1]).toMatchObject({ auth: "Bearer " + key, run: runId, url: `/api/plugins/private.paperclip-council/api/issues/${issueId}/council/commands` });
    expect(result.output).not.toContain(key);
    expect(result.output).toContain(JSON.stringify({ request: requests[1]!.body }));
  });

  it("does not replace an existing record, even if its SHA is wrong", async () => {
    recorded = "71b5f95145410736c691552b836df8f20df3880e";
    expect((await execute()).code).toBe(1);
    expect(requests).toHaveLength(1);
    expect(recorded).toBe("71b5f95145410736c691552b836df8f20df3880e");
  });

  it("retains the request identity and does not retry after a lost mutation response", async () => {
    mode = "lost";
    const result = await execute();
    expect(result.code).toBe(1);
    expect(recorded).toBe(git("rev-parse", "HEAD"));
    expect(requests).toHaveLength(2);
    expect(result.output).toContain(JSON.stringify({ request: requests[1]!.body }));
    expect(result.output).toContain("do not rerun or replace the key");
    expect(result.output).not.toContain(key);
  });

  it("stops on a known refusal without changing version/key or leaking credentials", async () => {
    mode = "refused";
    const result = await execute();
    expect(result.code).toBe(1);
    expect(requests).toHaveLength(2);
    expect(result.output).toContain('"httpStatus":409');
    expect(result.output).toContain("version_conflict");
    expect(result.output).not.toContain(key);
  });

  it("does not record a different HEAD after inspection", async () => {
    mode = "moved";
    const result = await execute();
    expect(result.code).toBe(1);
    expect(result.output).toContain("HEAD changed");
    expect(requests).toHaveLength(1);
  });

  it("requires committed work before any HTTP request", async () => {
    await writeFile(join(directory, "panel.ts"), "uncommitted\n");
    expect((await execute()).code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it("rejects invalid instruction identities before generating executable text", () => {
    expect(() => contributionCommand("not-an-id", contributionId)).toThrow("UUIDs");
  });
});
