import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { CouncilConfig } from "../../src/contracts.js";
import { type DecisionReceipt, getDecisionReceipt, listDecisionReceipts, recordDecisionHumanDisposition, registerDecisionReceiptBridge } from "../../src/decision-receipts.js";
import { handleDecision } from "../../src/worker.js";
import { isolatedPostgres } from "./isolated-postgres.js";
import { checkReceiptBrowser } from "./browser.js";

const pg = await isolatedPostgres();
const companyId = randomUUID(), councilId = randomUUID();
const ns = pg.db.namespace;
const sends = new Map<string, number>();
const effects = new Set<string>();
const modes = new Map<string, "ok" | "lost" | "deny" | "malformed" | "crash" | "late">();
let crashAccepted!: () => void, lateAccepted!: () => void, releaseLate!: () => void;
const crashSeen = new Promise<void>((done) => { crashAccepted = done; });
const lateSeen = new Promise<void>((done) => { lateAccepted = done; });
const lateRelease = new Promise<void>((done) => { releaseLate = done; });
const server = createServer(async (request, response) => {
  const issueId = request.url!.split("/").pop()!;
  sends.set(issueId, (sends.get(issueId) ?? 0) + 1);
  assert.equal(request.method, "PATCH");
  assert.equal(request.headers.authorization, "Bearer synthetic-only");
  let content = ""; for await (const chunk of request) content += chunk;
  const body = JSON.parse(content);
  const mode = modes.get(issueId) ?? "ok";
  if (mode === "deny") { response.writeHead(403, { "content-type": "application/json" }); return response.end('{"error":"synthetic refusal"}'); }
  effects.add(issueId);
  if (mode === "lost") return request.socket.destroy();
  if (mode === "crash") { crashAccepted(); return; }
  if (mode === "late") { lateAccepted(); await lateRelease; }
  response.setHeader("content-type", "application/json");
  response.end(mode === "malformed" ? '{bad' : JSON.stringify({ id: issueId, companyId, status: body.status, executionState: { lastDecisionId: randomUUID(), lastDecisionOutcome: "changes_requested" } }));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert(address && typeof address !== "string");
const config: CouncilConfig = { apiBaseUrl: `http://127.0.0.1:${address.port}`, councilAgentId: councilId, councilApiKey: { type: "secret_ref", secretId: "synthetic" } };
const ctx = () => ({
  db: pg.db, config: { get: async () => config }, secrets: { resolve: async () => "synthetic-only" },
  issues: { get: async (id: string) => ({ id, companyId, status: "in_review", assigneeAgentId: councilId }) },
  companies: { get: async (id: string) => ({ id, defaultResponsibleUserId: "owner" }) },
}) as unknown as PluginContext;
function request(issueId: string, operationId = randomUUID()): PluginApiRequestInput {
  return { routeKey: "decision", method: "POST", path: `/issues/${issueId}/decision`, params: { issueId }, query: {}, companyId, headers: {},
    actor: { actorType: "agent", actorId: councilId, agentId: councilId, runId: randomUUID() },
    body: { operationId, verdict: "changes_requested", justification: "Fixture revision required", resultReference: "fixture://review/v1" } };
}
async function issue(mode: "ok" | "lost" | "deny" | "malformed" | "crash" | "late" = "ok") {
  const id = randomUUID(); await pg.sql.unsafe("INSERT INTO public.issues(id) VALUES ($1)", [id]); modes.set(id, mode); return id;
}
function receiptOf(result: Awaited<ReturnType<typeof handleDecision>>): DecisionReceipt {
  assert(result.body.receipt && typeof result.body.receipt === "object");
  return result.body.receipt as DecisionReceipt;
}
const results: Record<string, string> = {};
let child: ReturnType<typeof spawn> | undefined;
try {
  // Minimal public fixtures exist only to satisfy private migration foreign keys.
  await pg.sql.unsafe(`CREATE TABLE public.companies(id uuid PRIMARY KEY); CREATE TABLE public.issues(id uuid PRIMARY KEY); CREATE TABLE public.projects(id uuid PRIMARY KEY); CREATE SCHEMA ${ns};`);
  await pg.sql.unsafe("INSERT INTO public.companies(id) VALUES ($1)", [companyId]);
  for (const file of ["001_foundation_probe.sql", "002_revisioned_rosters.sql", "003_missions.sql"]) await pg.migration(resolve("migrations", file));
  const legacyIssue = await issue();
  await pg.sql.unsafe(`INSERT INTO ${ns}.foundation_probes(company_id, issue_id, probe_id, payload) VALUES ($1,$2,'legacy','{"keep":true}')`, [companyId, legacyIssue]);
  await pg.migration(resolve("migrations/004_decision_receipts.sql"));
  assert.deepEqual((await pg.sql.unsafe(`SELECT payload FROM ${ns}.foundation_probes WHERE probe_id='legacy'`))[0].payload, { keep: true });
  results.additiveMigrationAndHostSqlGuards = "PASS";

  const nominalId = await issue(); const nominal = request(nominalId);
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => handleDecision(structuredClone(nominal), ctx())));
  assert.equal(sends.get(nominalId), 1); assert(concurrent.every((value) => [200, 202].includes(value.status)));
  const changedStage = ctx(); changedStage.issues.get = async () => { throw new Error("Replay must not revalidate an advanced stage"); };
  const replay = await handleDecision({ ...nominal, actor: { ...nominal.actor, runId: randomUUID() } }, changedStage);
  assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(receiptOf(replay).runId, nominal.actor.runId);
  results.nominalAndTwentyConcurrentDuplicates = "PASS";
  const conflict = await handleDecision({ ...nominal, body: { ...nominal.body as object, justification: "Different content" } }, ctx());
  assert.equal(conflict.status, 409); assert.equal(sends.get(nominalId), 1);
  const otherIssue = await issue();
  assert.equal((await handleDecision({ ...nominal, params: { issueId: otherIssue } }, ctx())).status, 409);
  results.contentAndTargetConflict = "PASS";

  const unauthorized = request(await issue());
  assert.equal((await handleDecision({ ...unauthorized, actor: { actorType: "user", userId: "owner", actorId: "owner" } }, ctx())).status, 403);
  assert.equal(sends.get(unauthorized.params.issueId), undefined);
  const denied = request(await issue("deny")); const denial = await handleDecision(denied, ctx());
  assert.equal(receiptOf(denial).state, "indeterminate"); assert.equal(receiptOf(denial).nativeObservation!.status, 403);
  assert.equal(sends.get(denied.params.issueId), 1);
  results.authorizationAndNoFallback = "PASS (native HTTP errors conservatively held)";

  const lost = request(await issue("lost")); const lostResult = await handleDecision(lost, ctx());
  assert(effects.has(lost.params.issueId)); assert.equal(receiptOf(lostResult).state, "indeterminate");
  await handleDecision(structuredClone(lost), ctx());
  assert.equal((await handleDecision(request(lost.params.issueId), ctx())).status, 409);
  assert.equal(sends.get(lost.params.issueId), 1);
  const malformed = request(await issue("malformed"));
  assert.equal(receiptOf(await handleDecision(malformed, ctx())).state, "indeterminate");
  results.lostSuccessMalformedAndNewKeyHold = "PASS";

  const crashing = request(await issue("crash"));
  child = spawn(process.execPath, ["--import", "tsx", "tests/receipts/crash-child.ts"], { cwd: process.cwd(), env: { ...process.env, COUNCIL_CRASH_FIXTURE: JSON.stringify({ connection: pg.connection, config, input: { ...crashing.body as object, companyId, issueId: crashing.params.issueId, runId: crashing.actor.runId, actorAgentId: councilId } }) }, stdio: ["ignore", "pipe", "pipe"] });
  let childErrors = ""; child.stderr!.on("data", (data) => { childErrors += data; });
  await Promise.race([crashSeen, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error(`Crash child did not dispatch: ${childErrors}`)), 15000); timeout.unref(); child!.once("exit", () => reject(new Error(`Crash child exited early: ${childErrors}`))); })]);
  const exited = new Promise<void>((done) => child!.once("exit", () => done())); child.kill("SIGKILL"); await exited; child = undefined;
  assert.equal(receiptOf(await handleDecision(crashing, ctx())).state, "indeterminate");
  assert.equal((await handleDecision(request(crashing.params.issueId), ctx())).status, 409);
  assert.equal(sends.get(crashing.params.issueId), 1);
  results.processKillAfterSendAndRestart = "PASS";

  const operationId = (lost.body as { operationId: string }).operationId;
  await assert.rejects(recordDecisionHumanDisposition(ctx(), { companyId, operationId, action: "abandon", note: "spoof", actorUserId: "intruder" }), /owner/);
  const data = new Map<string, any>(), actions = new Map<string, any>();
  const bridge = ctx(); bridge.data = { register: (name: string, fn: any) => data.set(name, fn) } as any; bridge.actions = { register: (name: string, fn: any) => actions.set(name, fn) } as any;
  registerDecisionReceiptBridge(bridge);
  await assert.rejects(actions.get("council-decision-human")({ operationId, action: "abandon", userId: "owner" }, { companyId, actor: { type: "user", userId: "intruder" } }), /owner/);
  await checkReceiptBrowser({ operationId, read: () => data.get("council-decisions")({ companyId }), act: (payload, actor) => actions.get("council-decision-human")(payload, { companyId, actor: { type: "user", userId: actor } }) });
  const afterHuman = await getDecisionReceipt(ctx(), companyId, lost.params.issueId, operationId);
  assert.equal(afterHuman!.state, "indeterminate"); assert.equal(afterHuman!.nativeObservation, null);
  assert.deepEqual(afterHuman!.humanDecisions.map((entry) => entry.action), ["acknowledge", "abandon"]);
  assert.equal((await handleDecision(request(lost.params.issueId), ctx())).status, 409);
  results.ownerAuditAndPersistentRenderedOperator = "PASS (real browser, synthetic SDK transport)";

  const late = request(await issue("late")); const pending = handleDecision(late, ctx()); await lateSeen;
  await recordDecisionHumanDisposition(ctx(), { companyId, operationId: (late.body as any).operationId, action: "abandon", note: "Response pending", actorUserId: "owner" });
  releaseLate(); const lateResult = await pending;
  assert.equal(receiptOf(lateResult).state, "native_observed"); assert.equal(receiptOf(lateResult).humanDecisions[0]!.action, "abandon");
  results.lateOriginalResponseRetainsHumanHistory = "PASS";
  assert.equal((await listDecisionReceipts(ctx(), randomUUID())).length, 0);
  results.companyIsolation = "PASS";
  const evidence = { schemaVersion: 1, completedAt: new Date().toISOString(), candidate: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), workingTreeDiff: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "", proofClass: "real isolated PostgreSQL and browser; synthetic native HTTP server and SDK transport", noProviderCalls: true, hostSourceWrites: false, results };
  const path = process.env.COUNCIL_RECEIPTS_EVIDENCE ?? "/tmp/council-receipts-evidence.json";
  await mkdir(resolve(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  child?.kill("SIGKILL"); releaseLate(); server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done())); await pg.cleanup();
}
