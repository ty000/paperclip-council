import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AdmissionError, configureAdmission, readAdmission, reserveAdmission, settleAdmission } from "../../../src/admission.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const host = resolve(repository, ".paperclip/qualification/paperclip");
const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hostSha = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
assert.equal(gitAt(host, "rev-parse", "HEAD"), hostSha);
assert.equal(gitAt(host, "status", "--porcelain", "--untracked-files=no"), "");
const runtime = await mkdtemp("/tmp/council-n2-intermediate-");
const output = resolve(repository, process.argv[2] ?? `artifacts/n2-intermediate-${Date.now()}.json`);
assert(output.startsWith(resolve(repository, "artifacts/n2-intermediate-")));
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw new Error("Evidence output already exists"); }, () => undefined);
const fixture = resolve(here, "fixture-cli.mjs");
const proof: any = { schema: "council-n2-intermediate-provider-free-v1", outcome: "RUNNING", startedAt: new Date().toISOString(),
  source: { head: gitAt(repository, "rev-parse", "HEAD"), branch: gitAt(repository, "branch", "--show-current"), hostSha,
    files: Object.fromEntries(await Promise.all([fixture, fileURLToPath(import.meta.url)].map(async p => [p, createHash("sha256").update(await readFile(p)).digest("hex")]))) },
  boundary: { model: "deterministic CLI fixture; no provider", adapter: "real codex_local engine=cli and JSONL parser",
    controller: "explicit owner-assisted probe; sole dispatcher; no automatic Council integration claimed",
    admission: "real Council utilities and CAS persisted in fresh PostgreSQL; context bridge supplies DB and standard API key",
    accounting: "synthetic token values persisted by real heartbeat cost path; monetary cost may remain unknown",
    candidate: "concrete owned Git fixture; no product feature or real model judgment", nativeExecutionPolicy: false,
    qualification: "feasibility only; not N2/N6/LIVE qualification" }, runtime, timeline: [], runs: [], checks: {} };
const record = (event: string, details: any = {}) => proof.timeline.push({ ordinal: proof.timeline.length + 1, at: new Date().toISOString(), event, ...details });
const save = () => writeFile(output, `${JSON.stringify(proof, null, 2)}\n`);
await save();
Object.assign(process.env, { PAPERCLIP_HOME: runtime, PAPERCLIP_INSTANCE_ID: "n2-intermediate", PAPERCLIP_CONFIG: resolve(runtime, "config.json"),
  PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: resolve(runtime, "master.key"), PAPERCLIP_TELEMETRY_ENABLED: "false", PAPERCLIP_LOG_LEVEL: "warn",
  PAPERCLIP_UI_DEV_MIDDLEWARE: "false", PAPERCLIP_STORAGE_PROVIDER: "local_disk", PAPERCLIP_STORAGE_LOCAL_DIR: resolve(runtime, "storage"),
  OTEL_SDK_DISABLED: "true", NODE_ENV: "test" });
for (const key of ["DATABASE_URL", "DATABASE_MIGRATION_URL", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_CLOUD_TENANT_TOKEN", "PAPERCLIP_TRUSTED_USER_ID", "PAPERCLIP_PUBLIC_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[key];
const hostImport = (path: string) => import(pathToFileURL(resolve(host, path)).href);
let database: any, db: any, app: any, workerManager: any;
let server: ReturnType<typeof createServer> | undefined;
let base = "";
async function api(method: string, path: string, body?: any) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function waitFor<T>(label: string, read: () => Promise<T>, ok: (v: T) => boolean, timeout = 60000): Promise<T> {
  const end = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (ok(value)) return value;
    assert(Date.now() < end, `${label} timed out: ${JSON.stringify(value)}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
// CLI runs have no nativeIssueId. This explicitly owned controller bridges their
// public contextSnapshot identity to the unchanged Council admission CAS utility.
async function settleCliRun(ctx: any, input: any) {
  const run = await api("GET", `/api/heartbeat-runs/${input.runId}`);
  assert.equal(run.id, input.runId);
  assert.equal(run.companyId, input.companyId);
  assert.equal(run.agentId, input.agentId);
  assert.equal(run.contextSnapshot.issueId, input.issueId);
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) {
    throw new AdmissionError(409, "g4_run_not_terminal", "CLI run must finish successfully before its usage settles");
  }
  const usage = run.usageJson;
  if (usage?.usageSource !== "per_run" || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every(n => Number.isSafeInteger(n) && n >= 0)
    || usage.cachedInputTokens > usage.inputTokens || usage.inputTokens + usage.outputTokens <= 0) {
    throw new AdmissionError(409, "g4_usage_unavailable", "CLI usage remains unknown; reservation stays held");
  }
  const source = `probe:public-cli-terminal-per_run;run=${run.id};issue=${input.issueId};agent=${run.agentId}`;
  return settleAdmission(ctx, { commandId: input.commandId, companyId: input.companyId, periodKey: input.periodKey,
    reservationId: input.reservationId, expectedVersion: input.expectedVersion,
    usage: { status: "known", source, units: usage.inputTokens + usage.outputTokens }, remainingExposure: { status: "known", source, units: 0 } });
}
try {
  const tables = await hostImport("packages/db/src/index.ts");
  const { createApp } = await hostImport("server/src/app.ts");
  const { createPluginWorkerManager } = await hostImport("server/src/services/plugin-worker-manager.ts");
  const { createStorageService } = await hostImport("server/src/storage/service.ts");
  const { createLocalDiskStorageProvider } = await hostImport("server/src/storage/local-disk-provider.ts");
  database = await tables.startEmbeddedPostgresTestDatabase("council-n2-intermediate-");
  db = tables.createDb(database.connectionString);
  server = createServer();
  await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  process.env.PAPERCLIP_API_URL = base;
  workerManager = createPluginWorkerManager();
  app = await createApp(db, { uiMode: "none", serverPort: address.port,
    storageService: createStorageService(createLocalDiskStorageProvider(resolve(runtime, "storage"))),
    deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
    companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "" }, instanceId: "n2-intermediate",
    hostVersion: "0.3.1", localPluginDir: resolve(runtime, "plugins"), pluginWorkerManager: workerManager });
  server.on("request", app);
  await app.locals.bundledPluginsStartup;
  const company = await api("POST", "/api/companies", { name: "N2 ordinary tasks feasibility", issuePrefix: "NIP", requireBoardApprovalForNewAgents: false });
  const companyId = company.id;
  proof.companyId = companyId;
  // Local-trusted owner setup is fixture data; no business runs/costs are inserted.
  await db.insert(tables.authUsers).values({ id: "local-board", name: "Ephemeral owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  await db.insert(tables.companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" }).onConflictDoNothing();
  await db.insert(tables.instanceUserRoles).values({ userId: "local-board", role: "instance_admin" }).onConflictDoNothing();
  const repoPath = resolve(runtime, "candidate");
  await mkdir(repoPath);
  gitAt(repoPath, "init", "-b", "fixture");
  gitAt(repoPath, "config", "user.name", "Council deterministic fixture");
  gitAt(repoPath, "config", "user.email", "fixture@example.test");
  await writeFile(resolve(repoPath, "candidate.txt"), "V1 defective\n");
  gitAt(repoPath, "add", "candidate.txt");
  gitAt(repoPath, "commit", "-m", "fixture: concrete V1 candidate");
  const v1 = gitAt(repoPath, "rev-parse", "HEAD");
  proof.candidates = { v1 };
  await chmod(fixture, 0o755);
  const actors: any = {};
  for (const role of ["technical", "council", "correction"]) {
    const agent = await api("POST", `/api/companies/${companyId}/agents`, { name: `Intermediate ${role}`, role: "engineer",
      adapterType: "codex_local", adapterConfig: { engine: "cli", command: fixture, cwd: repoPath, model: "fixture-no-provider",
        env: { CODEX_HOME: resolve(runtime, `codex-${role}`), INTERMEDIATE_RUNTIME: runtime }, timeoutSec: 60 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    actors[role] = agent;
  }
  proof.actors = Object.fromEntries(Object.entries(actors).map(([k, v]: any) => [k, v.id]));
  const credential = await api("POST", `/api/agents/${actors.council.id}/keys`, { name: "intermediate-readback", scope: { kind: "standard" } });
  const sql = db.$client;
  const namespace = "plugin_private_paperclip_council_270061461e";
  await sql.unsafe(`CREATE SCHEMA ${namespace}`);
  await sql.unsafe(await readFile(resolve(repository, "migrations/005_admission.sql"), "utf8"));
  const ctx: any = { db: { namespace,
    query: async (query: string, params: any[]) => [...await sql.unsafe(query, params)],
    execute: async (query: string, params: any[]) => ({ rowCount: (await sql.unsafe(query, params)).count }) },
    config: { get: async () => ({ apiBaseUrl: base, councilAgentId: actors.council.id, councilApiKey: { type: "secret_ref", secretId: "ephemeral-probe-key" } }) },
    secrets: { resolve: async () => credential.token } };
  const periodKey = "intermediate-feasibility";
  const binding = { companyId, periodKey };
  await configureAdmission(ctx, { ...binding, commandId: randomUUID(), periodStart: new Date(Date.now() - 60000).toISOString(), periodEnd: new Date(Date.now() + 3600000).toISOString(),
    measurement: { status: "known", source: "synthetic CLI tokens through native heartbeat", unit: "tokens" },
    allowance: { status: "known", source: "owner-controlled fixture envelope", periodUnits: 5000, taskUnits: 1000, knownUsageUnits: 0 },
    exposure: { status: "known", source: "fresh isolated company", units: 0 }, limits: { maxConcurrent: 1, maxRetries: 0, maxCorrections: 1 } });
  let previous: any;
  async function stage(kind: string, candidateCommit: string, reviewIssueId?: string) {
    if (previous) {
      const envelope = await readAdmission(ctx, binding);
      assert(envelope!.reservations.every(r => r.status === "settled"));
      if (kind === "correction") {
        assert.equal(previous.report.verdict, "changes_requested");
        assert.equal(previous.report.candidateCommit, candidateCommit);
        assert.equal(previous.terminal.status, "succeeded");
      }
    }
    const actor = actors[kind];
    const issue = await api("POST", `/api/companies/${companyId}/issues`, { title: `${kind} ${candidateCommit.slice(0, 8)}`,
      description: JSON.stringify({ kind, candidateCommit, repoPath, reviewIssueId }), assigneeAgentId: actor.id, status: "todo" });
    assert(!issue.executionPolicy);
    record("ordinary_task_created", { kind, issueId: issue.id, candidateCommit });
    const reservationId = randomUUID();
    let envelope = await readAdmission(ctx, binding);
    await reserveAdmission(ctx, { ...binding, expectedVersion: envelope!.version, reservationId, missionId: issue.id, effectId: randomUUID(),
      requestedUnits: 1000, attempt: { kind: kind === "correction" ? "correction" : "initial", ordinal: kind === "correction" ? 1 : 0 } });
    record("reserved", { kind, issueId: issue.id, reservationId });
    await api("PATCH", `/api/agents/${actor.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    const wake = await api("POST", `/api/agents/${actor.id}/wakeup`, { source: "on_demand", triggerDetail: "manual", reason: "intermediate_owner_dispatch", idempotencyKey: issue.id,
      forceFreshSession: true, payload: { issueId: issue.id } });
    assert(wake.id, JSON.stringify(wake));
    record("wake_requested", { kind, issueId: issue.id, runId: wake.id });
    const entry: any = { kind, issueId: issue.id, agentId: actor.id, runId: wake.id, reservationId, candidateCommit };
    proof.runs.push(entry);
    const ready = await waitFor("fixture report", async () => {
      const run = await api("GET", `/api/heartbeat-runs/${wake.id}`);
      assert(!["failed", "cancelled", "timed_out", "interrupted"].includes(run.status), JSON.stringify(run));
      return readFile(resolve(runtime, `${issue.id}.ready.json`), "utf8").then(JSON.parse, () => null);
    }, v => Boolean(v));
    const comments = await api("GET", `/api/issues/${issue.id}/comments`);
    const reportComment = comments.find((comment: any) => {
      try { return JSON.parse(comment.body).runId === wake.id; } catch { return false; }
    });
    assert(reportComment, "Report must be available through public comments API");
    entry.reportComment = reportComment;
    entry.report = JSON.parse(reportComment.body);
    assert.deepEqual(entry.report, ready.report);
    assert.equal(entry.report.candidateCommit, candidateCommit);
    assert.equal(entry.report.agentId, actor.id);
    assert.equal(entry.report.issueId, issue.id);
    assert.equal(entry.reportComment.authorAgentId, actor.id);
    entry.fixtureArgv = ready.argv;
    entry.active = await api("GET", `/api/heartbeat-runs/${wake.id}`);
    entry.taskWhileActive = await api("GET", `/api/issues/${issue.id}`);
    assert.equal(entry.active.status, "running");
    assert.equal(entry.taskWhileActive.status, "in_progress");
    assert.equal(entry.taskWhileActive.assigneeAgentId, actor.id);
    record("report_visible_run_active", { kind, issueId: issue.id, runId: wake.id, verdict: entry.report.verdict });
    envelope = await readAdmission(ctx, binding);
    await assert.rejects(() => settleCliRun(ctx, { ...binding, commandId: randomUUID(), expectedVersion: envelope!.version,
      reservationId, issueId: issue.id, runId: wake.id, agentId: actor.id }), (e: any) => e.code === "g4_run_not_terminal");
    await assert.rejects(() => reserveAdmission(ctx, { ...binding, expectedVersion: envelope!.version, reservationId: randomUUID(), missionId: issue.id, effectId: randomUUID(),
      requestedUnits: 1000, attempt: { kind: "initial", ordinal: 0 } }), (e: any) => e.code === "admission_blocked");
    record("premature_settlement_and_admission_rejected", { kind, issueId: issue.id });
    await writeFile(resolve(runtime, `${issue.id}.release`), "release\n");
    entry.terminal = await waitFor("terminal usage", () => api("GET", `/api/heartbeat-runs/${wake.id}`), r => !["running", "queued"].includes(r.status));
    assert.equal(entry.terminal.status, "succeeded", JSON.stringify(entry.terminal));
    assert.equal(entry.terminal.usageJson.usageSource, "per_run");
    record("run_terminal_usage_readback", { kind, issueId: issue.id, runId: wake.id, usage: entry.terminal.usageJson });
    entry.closedTask = await api("PATCH", `/api/issues/${issue.id}`, { status: "done" });
    assert.equal(entry.closedTask.status, "done");
    record("ordinary_task_closed_by_controller", { kind, issueId: issue.id, verdict: entry.report.verdict });
    entry.costSummary = await api("GET", `/api/issues/${issue.id}/cost-summary`);
    envelope = await readAdmission(ctx, binding);
    const settled = await settleCliRun(ctx, { ...binding, commandId: randomUUID(), expectedVersion: envelope!.version,
      reservationId, issueId: issue.id, runId: wake.id, agentId: actor.id });
    assert.equal(settled.reservation!.status, "settled");
    entry.settlement = settled.reservation;
    record("settled", { kind, issueId: issue.id, reservationId, usage: settled.reservation!.usage });
    await api("PATCH", `/api/agents/${actor.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    previous = entry;
    await save();
    return entry;
  }
  const tech1 = await stage("technical", v1);
  const council1 = await stage("council", v1, tech1.issueId);
  assert.equal(council1.report.verdict, "changes_requested");
  const correction = await stage("correction", v1);
  const v2 = gitAt(repoPath, "rev-parse", "HEAD");
  assert.equal(correction.report.resultCommit, v2);
  assert.notEqual(v1, v2);
  assert.equal(gitAt(repoPath, "rev-parse", "HEAD^"), v1);
  proof.candidates.v2 = v2;
  proof.candidates.diff = gitAt(repoPath, "diff", v1, v2);
  const tech2 = await stage("technical", v2);
  const council2 = await stage("council", v2, tech2.issueId);
  assert.equal(council2.report.verdict, "accepted");
  assert.equal(council2.report.candidateCommit, v2);
  await new Promise(r => setTimeout(r, 1000));
  proof.allRuns = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
  assert.equal(proof.allRuns.length, 5);
  assert(proof.allRuns.every((r: any) => r.status === "succeeded" && proof.runs.some((expected: any) => expected.runId === r.id)));
  proof.admission = await readAdmission(ctx, binding);
  assert.equal(proof.admission.allowance.knownUsageUnits, 750);
  assert(proof.admission.reservations.every((r: any) => r.status === "settled" && r.remainingExposure.units === 0));
  proof.checks = { realCliAdapterAndParser: "PASS", fiveExpectedRunsSucceededNoCancellation: "PASS", noUnexpectedRecoveryRun: "PASS",
    doneIsNotRunTerminalOrAcceptance: "PASS", prematureSettlementAndAdmissionRejected: "PASS", exactCandidateV1V2Binding: "PASS",
    realSingleGitCorrection: "PASS", separateTechnicalAndCouncilActors: "PASS", realCouncilReservationSettlement: "PASS" };
  proof.outcome = "PROVIDER-FREE INTERMEDIATE FEASIBILITY VALIDATED";
} catch (error) {
  proof.outcome = "BLOCKED";
  proof.error = { message: String(error), stack: error instanceof Error ? error.stack : undefined };
  process.exitCode = 1;
} finally {
  try {
    await workerManager?.stopAll();
    await app?.locals.paperclipShutdown();
    if (server) await new Promise<void>((r, reject) => server!.close(e => e ? reject(e) : r()));
    await db?.$client?.end();
    await database?.cleanup();
    await rm(runtime, { recursive: true, force: true });
    proof.cleanup = { databaseCleaned: true, serverStopped: true, runtimeRemoved: true };
  } catch (error) { proof.cleanup = { error: String(error) }; proof.outcome = "BLOCKED"; process.exitCode = 1; }
  proof.source.hostTrackedUnchanged = gitAt(host, "status", "--porcelain", "--untracked-files=no") === "";
  proof.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ outcome: proof.outcome, output, error: proof.error, cleanup: proof.cleanup }));
}
