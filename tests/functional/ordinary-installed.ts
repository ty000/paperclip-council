import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const host = resolve(repository, ".paperclip/qualification/paperclip");
const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hostSha = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
assert.equal(gitAt(host, "rev-parse", "HEAD"), hostSha);
assert.equal(gitAt(host, "status", "--porcelain", "--untracked-files=no"), "");
const runtime = await mkdtemp("/tmp/council-ordinary-installed-");
const output = resolve(repository, process.argv[2] ?? `artifacts/n2-ordinary-installed-${Date.now()}.json`);
assert(output.startsWith(resolve(repository, "artifacts/n2-ordinary-installed-")));
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw new Error("Evidence output already exists"); }, () => undefined);
const fixture = resolve(here, "ordinary-cli-fixture.mjs");
const proof: any = { schema: "council-ordinary-installed-v1", outcome: "RUNNING", startedAt: new Date().toISOString(),
  head: gitAt(repository, "rev-parse", "HEAD"), hostSha, runtime, timeline: [], checks: {},
  boundary: "Installed Council owns N2/N3 state, admission, dispatch and reconciliation. Only CLI model/content/usage are deterministic. Owner prepares N1 and closes finished N1 children with lead demand wakes disabled.",
  source: Object.fromEntries(await Promise.all([...new Set([fixture, fileURLToPath(import.meta.url), resolve(repository, "dist/worker.js"),
    ...gitAt(repository, "ls-files", "src").split("\n").map(path => resolve(repository, path)),
    ...gitAt(repository, "ls-files", "--others", "--exclude-standard", "src").split("\n").filter(Boolean).map(path => resolve(repository, path))])].map(async p => [p, createHash("sha256").update(await readFile(p)).digest("hex")]))) };
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

try {
  const tables = await hostImport("packages/db/src/index.ts");
  const { createApp } = await hostImport("server/src/app.ts");
  const { createPluginWorkerManager } = await hostImport("server/src/services/plugin-worker-manager.ts");
  const { createStorageService } = await hostImport("server/src/storage/service.ts");
  const { createLocalDiskStorageProvider } = await hostImport("server/src/storage/local-disk-provider.ts");
  database = await tables.startEmbeddedPostgresTestDatabase("council-ordinary-installed-");
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
  const company = await api("POST", "/api/companies", { name: "Ordinary installed Council", requireBoardApprovalForNewAgents: false });
  const companyId = company.id;
  proof.companyId = companyId;
  await db.insert(tables.authUsers).values({ id: "local-board", name: "Ephemeral owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
  await db.insert(tables.companyMemberships).values({ companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" }).onConflictDoNothing();
  await db.insert(tables.instanceUserRoles).values({ userId: "local-board", role: "instance_admin" }).onConflictDoNothing();
  await api("PATCH", `/api/companies/${companyId}`, { defaultResponsibleUserId: "local-board" });
  const repoPath = resolve(runtime, "candidate");
  await mkdir(repoPath);
  gitAt(repoPath, "init", "-b", "work");
  gitAt(repoPath, "config", "user.name", "Council fixture");
  gitAt(repoPath, "config", "user.email", "fixture@example.test");
  await writeFile(resolve(repoPath, "README.md"), "Ordinary Council fixture\n");
  gitAt(repoPath, "add", "."); gitAt(repoPath, "commit", "-m", "fixture base");
  const baseCommit = gitAt(repoPath, "rev-parse", "HEAD");
  gitAt(repoPath, "branch", "base", baseCommit);
  await chmod(fixture, 0o755);
  const fixtureConfig = resolve(runtime, "fixture.json");
  const actors: Record<string, string> = {};
  for (const name of ["lead", "alpha", "beta", "product", "quality", "council"]) {
    const agent = await api("POST", `/api/companies/${companyId}/agents`, { name: `Ordinary ${name}`, role: "engineer", adapterType: "codex_local",
      adapterConfig: { engine: "cli", command: fixture, model: "fixture-no-provider", cwd: repoPath,
        env: { CODEX_HOME: resolve(runtime, `codex-${name}`), COUNCIL_ORDINARY_FIXTURE: fixtureConfig }, timeoutSec: 120 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    actors[name] = agent.id;
  }
  proof.actors = actors;
  const key = await api("POST", `/api/agents/${actors.council}/keys`, { name: "council", scope: { kind: "standard" } });
  const secret = await api("POST", `/api/companies/${companyId}/secrets`, { name: "Council readback", key: "COUNCIL_TEST_KEY", provider: "local_encrypted", value: key.token });
  const install = await api("POST", "/api/plugins/install", { packageName: repository, isLocalPath: true });
  const pluginId = install.id;
  proof.pluginId = pluginId;
  const profile = { kind: "paperclip-orchestration-tokens-v1", periodKey: "ordinary-installed", periodStart: new Date(Date.now() - 60000).toISOString(),
    periodEnd: new Date(Date.now() + 3600000).toISOString(), periodAllowanceUnits: 20000, runReservationUnits: 1000,
    initialKnownUsageUnits: 0, initialExposureUnits: 0, initialTokenAccountingSource: "fresh-isolated-company", maxCorrections: 1 as const };
  await api("POST", `/api/plugins/${pluginId}/config`, { companyId, configJson: { apiBaseUrl: base, councilAgentId: actors.council,
    councilApiKey: { type: "secret_ref", secretId: secret.id }, n1OperatingProfile: profile, n2RuntimeProfile: "ordinary-cli-v1" } });
  await workerManager.stopAll(); await app.locals.paperclipShutdown();
  await new Promise<void>((r, reject) => server!.close(e => e ? reject(e) : r()));
  workerManager = createPluginWorkerManager();
  app = await createApp(db, { uiMode: "none", serverPort: address.port,
    storageService: createStorageService(createLocalDiskStorageProvider(resolve(runtime, "storage"))),
    deploymentMode: "local_trusted", deploymentExposure: "private", allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1",
    companyDeletionEnabled: false, announcements: { enabled: false, feedUrl: "" }, instanceId: "n2-intermediate",
    hostVersion: "0.3.1", localPluginDir: resolve(runtime, "plugins"), pluginWorkerManager: workerManager });
  server = createServer(app); await new Promise<void>(r => server!.listen(address.port, "127.0.0.1", r));
  await app.locals.bundledPluginsStartup;
  assert(workerManager.isRunning(pluginId), "Installed worker must be running");
  record("installed_worker_started", { pluginId });
  const project = await api("POST", `/api/companies/${companyId}/projects`, { name: "Ordinary fixture", status: "in_progress",
    workspace: { name: "fixture", sourceType: "local_path", cwd: repoPath, isPrimary: true },
    executionWorkspacePolicy: { enabled: true, sharedWorkspaceConcurrency: "allow", defaultMode: "shared_workspace", allowIssueOverride: false, workspaceStrategy: { type: "project_primary" } } });
  const projectId = project.id;
  const rosters = `/api/plugins/${pluginId}/api/companies/${companyId}/rosters`;
  const team = await api("POST", rosters, { companyId, command: "create", roster: { kind: "team", name: "Team", projectId,
    members: ["lead", "alpha", "beta"].map(name => ({ agentId: actors[name], responsibilities: [name === "lead" ? "integration_lead" : "contributor"] })),
    integrationLeadAgentId: actors.lead, finalReviewerAgentId: null, requiredPerspectives: [] } });
  const council = await api("POST", rosters, { companyId, command: "create", roster: { kind: "council", name: "Council", projectId,
    members: [{ agentId: actors.council, responsibilities: ["final_reviewer"] }], integrationLeadAgentId: null, finalReviewerAgentId: actors.council, requiredPerspectives: ["integration_quality"] } });
  const pair = await api("POST", rosters, { companyId, command: "activate-pair", teamRosterId: team.head.rosterId, teamExpectedVersion: team.head.version,
    councilRosterId: council.head.rosterId, councilExpectedVersion: council.head.version });
  const { nativeAdmissionConfiguration } = await import("../../src/g4-native.js");
  const admissionPath = `/api/plugins/${pluginId}/api/companies/${companyId}/admission`;
  await api("POST", admissionPath, { companyId, command: "configure", configuration: nativeAdmissionConfiguration(profile as any, companyId, randomUUID()) });
  const root = await api("POST", `/api/companies/${companyId}/issues`, { title: "Ordinary N1 to N2", projectId, status: "backlog", assigneeAgentId: actors.lead });
  const missionId = randomUUID();
  const missions = `/api/plugins/${pluginId}/api/companies/${companyId}/missions`;
  const missionPath = `${missions}/${missionId}`;
  const created = await api("POST", missions, { companyId, command: "create", commandId: randomUUID(), missionId, rootIssueId: root.id, projectId,
    teamRosterId: team.head.rosterId, teamRevision: pair.team.revision.revision, councilRosterId: council.head.rosterId, councilRevision: pair.council.revision.revision,
    mandate: { objective: "Two contributions and independent Council correction", acceptanceCriteria: ["Alpha must contain corrected marker", "Two attributed contributions"],
      commitments: ["Provider-free CLI fixture", "One correction maximum"], limits: { taskPolicy: "1000 tokens reserved", periodPolicy: "20000 token envelope", correctionLimit: 1, elapsedMinutes: 30 } } });
  await writeFile(fixtureConfig, JSON.stringify({ pluginId, companyId, projectId, missionId, rootIssueId: root.id, repoPath, runtime, actors, baseCommit }));
  const activate = await api("POST", `${missionPath}/commands`, { companyId, command: "activate", commandId: randomUUID(), expectedVersion: created.mission.version,
    periodKey: profile.periodKey, reservationId: randomUUID(), requestedUnits: 1000 });
  const started = await api("POST", `${missionPath}/commands`, { companyId, command: "start-lead", commandId: randomUUID(), expectedVersion: activate.mission.version });
  assert.equal(started.outcome, "requested", JSON.stringify(started));
  const rootRunId = started.mission.aggregate.n1.rootDispatchRunId;
  // N1 preparation only: prevent its legacy parent-close notification from creating a second lead run.
  await api("PATCH", `/api/agents/${actors.lead}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  await waitFor("real N1 prerequisite", async () => {
    const runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
    for (const run of runs) {
      assert(!["failed", "cancelled", "timed_out"].includes(run.status), `N1 ${run.id} ${run.status} ${run.error}`);
      if (run.id !== rootRunId && run.status === "succeeded") {
        const issueId = run.contextSnapshot?.issueId;
        const issue = await api("GET", `/api/issues/${issueId}`);
        if (issue.status !== "done") { await api("PATCH", `/api/issues/${issueId}`, { status: "done" }); record("owner_closed_finished_N1_child", { issueId, runId: run.id }); }
      }
    }
    return runs.find((run: any) => run.id === rootRunId);
  }, run => run?.status === "succeeded", 120000);
  let mission = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  const settleBody = { companyId, command: "reconcile-lead-usage", commandId: randomUUID(), expectedVersion: mission.version };
  await waitFor("N1 source settlement", async () => {
    const response = await fetch(`${base}${missionPath}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settleBody) });
    const body = await response.json();
    if (response.ok) return body;
    assert(["g4_usage_unavailable", "g4_run_not_terminal"].includes(body.code), JSON.stringify(body)); return null;
  }, Boolean);
  mission = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  assert.equal(mission.aggregate.phase, "ready_for_review");
  proof.prerequisite = mission;
  await api("PATCH", `/api/agents/${actors.lead}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  const n3Slots = ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective, specialistAgentId: actors[perspective], required: true, question: `${perspective} review of the exact candidate and alpha correction marker` }));
  const reviewBody = { companyId, command: "start-review", commandId: randomUUID(), expectedVersion: mission.version, submissionId: randomUUID(), n3Slots };
  await api("POST", `${missionPath}/commands`, reviewBody);
  record("ordinary_review_started");
  await save();
  mission = await waitFor("installed ordinary acceptance", async () => {
    const value = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
    const runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
    assert(runs.every((run: any) => !["failed", "cancelled", "timed_out"].includes(run.status)), JSON.stringify(runs.map((run: any) => ({ id: run.id, status: run.status, error: run.error }))));
    for (const [index, task] of (value.aggregate.n2?.ordinary?.tasks ?? []).entries()) {
      const run = runs.find((run: any) => run.id === task.runId);
      if (task.kind === "council" && task.report && run?.status === "running") {
        assert(!task.settledAt && !task.receiptRecordedAt);
        assert.notEqual(value.aggregate.n2.status, "accepted");
        assert(value.aggregate.n2.ordinary.tasks.slice(index + 1).every((later: any) => !later.runId));
        proof.runningReportObservations ??= {};
        proof.runningReportObservations[task.taskId] = { taskId: task.taskId, runId: run.id, status: run.status, report: task.report, at: new Date().toISOString() };
      }
    }
    proof.latest = value;
    return value;
  }, value => value.aggregate.n2?.status === "accepted", 120000);
  await api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-ordinary-n2" });
  const replay = await api("POST", `${missionPath}/commands`, reviewBody);
  assert.equal(replay.outcome, "replayed");
  const after = await api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-ordinary-n2" });
  proof.mission = after.mission;
  proof.runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
  proof.admission = (await api("GET", `${admissionPath}?companyId=${companyId}&periodKey=${profile.periodKey}`)).envelope;
  assert.equal(proof.runs.length, 10);
  assert(proof.runs.every((run: any) => run.status === "succeeded"));
  assert.equal(proof.mission.aggregate.n2.ordinary.tasks.length, 7);
  assert(proof.admission.reservations.every((item: any) => item.status === "settled"));
  assert.equal(proof.admission.allowance.knownUsageUnits, 1500);
  const { acceptedN5Submission } = await import("../../src/n5-preflight.js");
  proof.n5Handoff = acceptedN5Submission(proof.mission);
  const n2 = proof.mission.aggregate.n2;
  assert.notEqual(n2.submissions[0].candidateCommit, n2.submissions[1].candidateCommit);
  proof.candidateDiff = gitAt(repoPath, "diff", n2.submissions[0].candidateCommit, n2.submissions[1].candidateCommit);
  assert.equal(Object.keys(proof.runningReportObservations ?? {}).length, 2);
  proof.agentApiReadbacks = await Promise.all((await readdir(runtime)).filter(name => name.startsWith("api-")).map(async name => JSON.parse(await readFile(resolve(runtime, name), "utf8"))));
  assert.equal(proof.agentApiReadbacks.length, 7);
  proof.gatewayRefusal = JSON.parse(await readFile(resolve(runtime, "gateway-refusal.json"), "utf8"));
  proof.issues = await Promise.all([...new Set(proof.mission.aggregate.n2.ordinary.tasks.map((task: any) => task.issueId))].map(id => api("GET", `/api/issues/${id}`)));
  assert(proof.issues.every((issue: any) => issue.status === "done" && !issue.executionPolicy && !issue.executionState));
  assert(proof.issues.filter((issue: any) => issue.id !== root.id).every((issue: any) => !issue.parentId));
  proof.checks = { exactAgentApiBindings: "PASS", reportWhileRunningDoesNotAdmit: "PASS", realN1Prerequisite: "PASS", installedOrdinaryN2N3: "PASS", tenExpectedCliRunsSucceeded: "PASS", replayNoExtraRun: "PASS", allReservationsSettled: "PASS", n5Handoff: "PASS" };
  proof.outcome = "INSTALLED ORDINARY COUNCIL PROVIDER-FREE VALIDATED";
} catch (error) {
  proof.outcome = "BLOCKED"; proof.error = { message: String(error), stack: error instanceof Error ? error.stack : undefined };
} finally {
  try {
    if (proof.companyId && base) {
      proof.runs = await api("GET", `/api/companies/${proof.companyId}/heartbeat-runs`);
      if (proof.outcome === "BLOCKED") {
        for (const agentId of Object.values(proof.actors ?? {})) await api("PATCH", `/api/agents/${agentId}`, { status: "paused" });
        for (const run of proof.runs.filter((run: any) => ["queued", "running", "scheduled_retry"].includes(run.status))) {
          await api("POST", `/api/heartbeat-runs/${run.id}/cancel`);
        }
        record("owned_failure_cleanup_cancelled_pending_runs");
      }
      // Heartbeat persists post-terminal events/costs asynchronously; drain before dropping its database.
      await new Promise(r => setTimeout(r, 1000));
    }
    await workerManager?.stopAll(); await app?.locals.paperclipShutdown();
    if (server) await new Promise<void>((r, reject) => server!.close(e => e ? reject(e) : r()));
    await db?.$client?.end(); await database?.cleanup(); await rm(runtime, { recursive: true, force: true });
    proof.cleanup = { databaseCleaned: true, serverStopped: true, runtimeRemoved: true };
  } catch (error) { proof.cleanup = { error: String(error) }; proof.outcome = "BLOCKED"; }
  proof.hostTrackedUnchanged = gitAt(host, "status", "--porcelain", "--untracked-files=no") === "";
  proof.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ outcome: proof.outcome, output, error: proof.error, cleanup: proof.cleanup }));
  process.exit(proof.outcome === "INSTALLED ORDINARY COUNCIL PROVIDER-FREE VALIDATED" ? 0 : 1);
}
