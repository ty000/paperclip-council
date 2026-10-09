import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadCommand } from "../src/lead-command.js";

const missionId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), key = "fixture-lead-key-do-not-print";
let directory: string, endpoint: string, server: Server, requests: any[], participants: any[];
let mode: "ok" | "lost" | "wrong" | "refused" | "invalid-inspection";
let hierarchy: any, proofPolicy: any;
function git(...args: string[]) { return execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function execute(operation = "plan", input = "") {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn("bash", ["-s"], { cwd: directory, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PAPERCLIP_API_URL: endpoint, PAPERCLIP_API_KEY: key, PAPERCLIP_RUN_ID: runId,
        PAPERCLIP_TASK_ID: issueId, COUNCIL_LEAD_OPERATION: operation, COUNCIL_LEAD_INPUT: input } });
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.on("error", reject); child.on("close", code => resolve({ code, output }));
    child.stdin.end(leadCommand(missionId));
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "council-lead-command-"));
  git("init", "--quiet"); git("config", "user.name", "Lead test"); git("config", "user.email", "lead@example.test");
  git("commit", "--quiet", "--allow-empty", "-m", "Base");
  mode = "ok"; requests = []; participants = []; proofPolicy = { protocol: "council-proof-close-v1" };
  hierarchy = { leaves: [1, 2].map(i => ({ contributionId: randomUUID(), assigneeAgentId: randomUUID(), title: "Leaf " + i, ownedPaths: ["leaf" + i + ".txt"] })) };
  server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push({ body, auth: request.headers.authorization, run: request.headers["x-paperclip-run-id"] });
    response.setHeader("content-type", "application/json");
    if (body.command === "inspect") {
      response.end(JSON.stringify({ missionId, version: mode === "invalid-inspection" ? "stale" : 26,
        n1: { participants, hierarchy, coordinationIssueId: issueId, proofPolicy } })); return;
    }
    if (mode === "refused") { response.writeHead(409); response.end(JSON.stringify({ detail: key })); return; }
    if (body.command === "plan") participants = body.contributions.map((slot: any) => ({ ...slot, issueState: "planned" }));
    else participants = participants.map(slot => slot.contributionId === body.contributionId ? { ...slot, issueState: "confirmed" } : slot);
    if (mode === "lost") { response.destroy(); return; }
    response.end(JSON.stringify({ outcome: "applied", mission: { missionId, version: 27, aggregate: {
      n1: { contributions: mode === "wrong" ? [] : participants, sourceBaseCommit: body.sourceBaseCommit } } } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await new Promise<void>(r => server.close(() => r())); await rm(directory, { recursive: true, force: true }); });

describe("native lead command block", () => {
  it("uses the exact pinned leaves, fresh version, UUID and actual Git source base", async () => {
    const result = await execute(); expect(result.code).toBe(0);
    expect(requests.map(r => r.body.command)).toEqual(["inspect", "plan"]);
    expect(requests[1].body).toMatchObject({ contributions: hierarchy.leaves, expectedVersion: 26, sourceBaseCommit: git("rev-parse", "HEAD") });
    expect(requests[1].body.commandId).toMatch(/^[a-f0-9-]{36}$/);
    expect(requests[1]).toMatchObject({ auth: "Bearer " + key, run: runId });
    const journal = JSON.parse(await readFile(join(directory, ".git/council-lead-intents", missionId + "-plan.json"), "utf8"));
    expect(journal.request).toEqual(requests[1].body); expect(result.output).not.toContain(key);
  });
  it("generates ordinary contribution IDs from business-only input", async () => {
    hierarchy = undefined; const business = { commandId: "invented", expectedVersion: 1,
      contributions: [1, 2].map(i => ({ contributionId: "invented", assigneeAgentId: randomUUID(), title: "Work " + i, ownedPaths: [i + ".txt"] })) };
    const file = join(directory, "business.json"); await writeFile(file, JSON.stringify(business));
    expect((await execute("plan", file)).code).toBe(0);
    expect(new Set(requests[1].body.contributions.map((slot: any) => slot.contributionId)).size).toBe(2);
    expect(JSON.stringify(requests[1].body)).not.toContain("invented");
    expect(requests[1].body.expectedVersion).toBe(26);
  });
  it("selects a materialization by existing index and verifies its business state", async () => {
    participants = hierarchy.leaves.map((slot: any) => ({ ...slot, issueState: "planned" }));
    expect((await execute("materialize", "2")).code).toBe(0);
    expect(requests[1].body.contributionId).toBe(participants[1].contributionId);
    expect(participants[1].issueState).toBe("confirmed");
    expect((await execute("materialize", "2")).code).toBe(1);
    expect(requests.filter(r => r.body.command === "materialize")).toHaveLength(1);
  });
  it.each(["lost", "wrong", "refused"] as const)("retains the exact intent after %s and a second invocation sends only inspect", async kind => {
    mode = kind; const first = await execute(); expect(first.code).toBe(1);
    const original = requests[1].body; mode = "ok";
    const again = await execute(); expect(again.code).toBe(1);
    expect(requests.map(r => r.body.command)).toEqual(["inspect", "plan", "inspect"]);
    expect(again.output).toContain(JSON.stringify(original));
    expect(first.output + again.output).not.toContain(key);
  });
  it("never mutates with an invalid inspection or a claimed materialization", async () => {
    mode = "invalid-inspection"; expect((await execute()).code).toBe(1); expect(requests).toHaveLength(1);
    mode = "ok"; participants = hierarchy.leaves.map((slot: any) => ({ ...slot, issueState: "creation_claimed" }));
    expect((await execute("materialize", "1")).code).toBe(1);
    expect(requests.every(r => r.body.command === "inspect")).toBe(true);
  });
});
