import { prepareHierarchyTasks, verifyHierarchyTasks } from "./hierarchy-scenario.js";
import { prepareN6Scenario } from "./n6-scenario.js";
import { qualifyNativeRunException } from "./native-run-exception-scenario.js";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installOrdinaryGitHubTransport, nominalDeliveryObserver, prepareOrdinaryDelivery } from "./ordinary-delivery-scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../..");
const host = resolve(process.env.PAPERCLIP_TEST_HOST_ROOT ?? resolve(repository, ".paperclip/qualification/paperclip"));
const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hostSha = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
assert.equal(gitAt(host, "rev-parse", "HEAD"), hostSha);
assert.equal(gitAt(host, "status", "--porcelain", "--untracked-files=no"), "");
const n6Mode = process.env.COUNCIL_N6_DEPENDENCIES === "1";
const coordinationMode = process.env.COUNCIL_N6_COORDINATION === "1";
assert(!coordinationMode || n6Mode);
const continuityMode = process.env.COUNCIL_CONTINUITY === "1";
const projectIntakeMode = process.env.COUNCIL_PROJECT_INTAKE === "1";
const nativeSetupMode = process.env.COUNCIL_NATIVE_SETUP === "1";
assert(!nativeSetupMode || projectIntakeMode);
const prePlanResumeMode = process.env.COUNCIL_PREPLAN_RESUME === "1";
const leadCommandMode = process.env.COUNCIL_LEAD_COMMAND_BLOCK === "1";
const deliveryMode = process.env.COUNCIL_ORDINARY_DELIVERY === "1";
const hierarchyCount = Number(process.env.COUNCIL_HIERARCHY_COUNT ?? 0);
assert([0, 1, 3].includes(hierarchyCount) && (!hierarchyCount || projectIntakeMode));
assert(!prePlanResumeMode || hierarchyCount > 0 && projectIntakeMode);
assert(!(n6Mode && deliveryMode));
assert(!continuityMode || deliveryMode);
assert(!projectIntakeMode || continuityMode);
const feedbackMode = process.env.COUNCIL_PR_FEEDBACK === "1";
assert(!feedbackMode || hierarchyCount === 3 && projectIntakeMode);
const integrationMode = process.env.COUNCIL_INTEGRATED_DELIVERY === "1";
const completionMode = process.env.COUNCIL_PROOF_COMPLETION === "1" || integrationMode;
assert(!completionMode || feedbackMode && hierarchyCount === 3 || integrationMode && hierarchyCount === 1);
assert(!prePlanResumeMode || !completionMode && leadCommandMode);
const success = completionMode ? "INSTALLED PROOF COMPLETION PROVIDER-FREE VALIDATED" : feedbackMode ? "INSTALLED PR FEEDBACK PROVIDER-FREE VALIDATED" : hierarchyCount ? "INSTALLED VARIABLE HIERARCHY PROVIDER-FREE VALIDATED" : n6Mode ? "INSTALLED N6 DEPENDENCY PROVIDER-FREE VALIDATED" : deliveryMode ? "INSTALLED ORDINARY DELIVERY PROVIDER-FREE VALIDATED" : "INSTALLED ORDINARY COUNCIL PROVIDER-FREE VALIDATED";
const artifactPrefix = integrationMode ? "integrated-delivery-installed-" : completionMode ? "proof-completion-installed-" : feedbackMode ? "pr-feedback-installed-" : hierarchyCount ? `hierarchy-${hierarchyCount}-installed-` : n6Mode ? "n6-installed-" : deliveryMode ? "n5-ordinary-installed-" : "n2-ordinary-installed-";
const runtime = await mkdtemp("/tmp/council-ordinary-installed-");
const output = resolve(repository, process.argv[2] ?? `artifacts/${artifactPrefix}${Date.now()}.json`);
assert(output.startsWith(resolve(repository, `artifacts/${artifactPrefix}`)));
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw new Error("Evidence output already exists"); }, () => undefined);
const fixture = resolve(here, "ordinary-cli-fixture.mjs");
const proof: any = { schema: "council-ordinary-installed-v1", outcome: "RUNNING", startedAt: new Date().toISOString(),
  head: gitAt(repository, "rev-parse", "HEAD"), hostSha, hostRoot: host, runtime, timeline: [], checks: {},
  boundary: "Installed Council owns N1 child completion/root waiting, N2/N3 state, admission, dispatch and reconciliation. Only CLI model/content/usage are deterministic. Owner prepares N1; Council finishes recorded children without implicit parent wakes and parks its verified candidate awaiting review. Agent demand wake policy remains enabled.",
  source: Object.fromEntries(await Promise.all([...new Set([fixture, fileURLToPath(import.meta.url), resolve(here, "ordinary-delivery-fixture.mjs"), resolve(here, "ordinary-delivery-scenario.ts"), resolve(here, "n6-scenario.ts"), resolve(here, "n6-coordination-fixture.mjs"), resolve(repository, "dist/worker.js"), resolve(repository, "dist/contribution-command.js"),
    resolve(repository, "scripts/operations/workspace_preflight.py"), resolve(repository, "scripts/operations/publisher_preflight.py"), resolve(repository, "scripts/operations/github_feedback.py"), resolve(here, "native-run-exception-scenario.ts"), resolve(here, "hierarchy-scenario.ts"), resolve(here, "integration-fixture.mjs"), resolve(repository, "scripts/operations/github_integration.py"), resolve(repository, "scripts/operations/integrate_delivery.py"),
    ...gitAt(repository, "ls-files", "src").split("\n").map(path => resolve(repository, path)),
    ...gitAt(repository, "ls-files", "--others", "--exclude-standard", "src").split("\n").filter(Boolean).map(path => resolve(repository, path))])].map(async p => [p, createHash("sha256").update(await readFile(p)).digest("hex")]))) };
const record = (event: string, details: any = {}) => proof.timeline.push({ ordinal: proof.timeline.length + 1, at: new Date().toISOString(), event, ...details });
const save = () => writeFile(output, `${JSON.stringify(proof, null, 2)}\n`);
await save();
const restoreFetch = deliveryMode ? await installOrdinaryGitHubTransport(runtime, proof) : undefined;
if (deliveryMode) proof.boundary += " N5 uses real plugin APIs, owner resume, Git, documents, work products and native GitHub refresh; GitHub publication and HTTP response content alone are simulated. Owner waits the native refresh backoff then reconciles without another run.";
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
async function api(method: string, path: string, body?: any, allowedConflict?: string) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (response.status === 409 && value.code === allowedConflict) return value;
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
  const { eq } = await hostImport("server/node_modules/drizzle-orm/index.js");
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
  for (const name of ["lead", "alpha", "beta", ...(hierarchyCount === 3 ? ["gamma"] : []), "product", "quality", "council", ...deliveryMode ? ["publisher"] : [], ...coordinationMode ? ["pm", "pmSuccessor", "facilitator"] : []]) {
    const agent = await api("POST", `/api/companies/${companyId}/agents`, { name: `Ordinary ${name}`, role: "engineer", adapterType: "codex_local",
      adapterConfig: { engine: "cli", command: fixture, model: "fixture-no-provider", cwd: repoPath,
        env: { CODEX_HOME: resolve(runtime, `codex-${name}`), COUNCIL_ORDINARY_FIXTURE: fixtureConfig }, timeoutSec: feedbackMode && name === "publisher" ? 400 : 120 },
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
    councilApiKey: { type: "secret_ref", secretId: secret.id }, n1OperatingProfile: profile, n2RuntimeProfile: "ordinary-cli-v1",
    ...(prePlanResumeMode ? { nativeRunLimit: hierarchyCount + 6 } : {}) } });
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
    members: ["lead", "alpha", "beta", ...(hierarchyCount === 3 ? ["gamma"] : [])].map(name => ({ agentId: actors[name], responsibilities: [name === "lead" ? "integration_lead" : "contributor"] })),
    integrationLeadAgentId: actors.lead, finalReviewerAgentId: null, requiredPerspectives: [] } });
  const council = await api("POST", rosters, { companyId, command: "create", roster: { kind: "council", name: "Council", projectId,
    members: [{ agentId: actors.council, responsibilities: ["final_reviewer"] }], integrationLeadAgentId: null, finalReviewerAgentId: actors.council, requiredPerspectives: ["integration_quality"] } });
  const pair = await api("POST", rosters, { companyId, command: "activate-pair", teamRosterId: team.head.rosterId, teamExpectedVersion: team.head.version,
    councilRosterId: council.head.rosterId, councilExpectedVersion: council.head.version });
  const { nativeAdmissionConfiguration } = await import("../../src/g4-native.js");
  const admissionPath = `/api/plugins/${pluginId}/api/companies/${companyId}/admission`;
  await api("POST", admissionPath, { companyId, command: "configure", configuration: nativeAdmissionConfiguration(profile as any, companyId, randomUUID()) });
  const n3Slots = ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective, specialistAgentId: actors[perspective], required: true, question: `${perspective} review of the exact candidate and alpha correction marker` }));
  const mandate = { objective: "Two contributions and independent Council correction", acceptanceCriteria: hierarchyCount ? [`${hierarchyCount} existing attributed leaves`, "Native dependencies retained", "Reviewed authorized publication"] : deliveryMode ? ["Two attributed contributions", "Bounded post-publication correction remains within mandate"] : ["Alpha must contain corrected marker", "Two attributed contributions"],
    commitments: ["Provider-free CLI fixture", "One correction maximum"], limits: { taskPolicy: "1000 tokens reserved", periodPolicy: "20000 token envelope", correctionLimit: 1, elapsedMinutes: 30 } };
  let root: any, missionId = randomUUID(), created: any;
  const missions = `/api/plugins/${pluginId}/api/companies/${companyId}/missions`;
  let missionPath = `${missions}/${missionId}`;
  if (projectIntakeMode) {
    const historical = await api("POST", `/api/companies/${companyId}/issues`, { title: "Historical task retained", description: "Do not adopt without explicit inclusion", projectId, status: "backlog", assigneeAgentId: actors.lead });
    const settings = await api("GET", "/api/instance/settings/experimental");
    await api("PATCH", "/api/instance/settings/experimental", { ...settings, enableExternalObjects: true });
    await writeFile(fixtureConfig, JSON.stringify({ pluginId, companyId, projectId, projectIntake: true, hierarchyCount, feedbackMode, completionMode, integrationMode,
      prePlanResume: prePlanResumeMode, leadCommandBlock: leadCommandMode, councilRepository: repository, repoPath, runtime, actors, baseCommit, delivery: true }));
    const policyPath = `/api/plugins/${pluginId}/api/companies/${companyId}/projects/${projectId}/mandate`;
    const policyBody = { companyId, commandId: randomUUID(), expectedVersion: 0, enabled: true, authorizeNewTasks: true,
      teamRosterId: team.head.rosterId, councilRosterId: council.head.rosterId, n3Slots, template: mandate,
      criteriaSource: "project-defaults", allowedPaths: ["alpha.txt", "beta.txt", ...(hierarchyCount === 3 ? ["gamma.txt"] : [])],
      ...(completionMode ? { completion: { protocol: "council-proof-close-v1", result: integrationMode ? "integrated-verified" : "draft-pr" } } : {}),
      ...(hierarchyCount ? { hierarchy: { protocol: "council-hierarchy-v1", maxContributions: hierarchyCount, execution: "sequential", adoptExistingChildren: true } } : {}),
      publication: { publisherAgentId: actors.publisher, qaAgentId: actors.quality, repository: "ty000/paperclip-council", baseRef: "main", headRefPrefix: "codex/project-task", ...(integrationMode ? { contract: { protocol: "council-pr-contract-v1", draftOnly: false, result: "integrated-verified", feedback: "review-and-correct", requiredChecks: ["fixture-ci"], integration: { protocol: "council-integrated-delivery-v1", mergeMethod: "squash", requiredChecks: ["integrated-ci"], parentObligations: [] } } } : feedbackMode ? { contract: { protocol: "council-pr-contract-v1", draftOnly: true, result: "draft-pr", feedback: "review-and-correct", requiredChecks: ["fixture-ci"] } } : {}) } };
    const configured = await api("POST", policyPath, policyBody);
    assert.equal((await api("POST", policyPath, policyBody)).outcome, "replayed");
    if (nativeSetupMode) {
      const setup = await api("GET", `${policyPath}?companyId=${companyId}&readiness=true`);
      assert.equal(setup.readiness.configurationReady, true);
      assert.equal(setup.readiness.launchAuthorized, false);
      assert.equal(setup.policy.revisionId, configured.policy.revisionId);
      proof.projectReadiness = setup.readiness;
      record("native_project_setup_inspected_before_new_task", { revisionId: configured.policy.revisionId });
    }
    const incomplete = await api("POST", `/api/companies/${companyId}/issues`, { title: "Incomplete task", projectId, status: "backlog", assigneeAgentId: actors.lead });
    const hierarchy = await api("POST", `/api/companies/${companyId}/issues`, { title: "Existing hierarchy", description: "Retain existing children for lot #51", projectId, status: "backlog" });
    const child = await api("POST", `/api/companies/${companyId}/issues`, { title: "Existing child retained", parentId: hierarchy.id, projectId, status: "backlog" });
    await api("PATCH", `/api/issues/${hierarchy.id}`, { assigneeAgentId: actors.lead });
    if (hierarchyCount) {
      proof.hierarchyTasks = await prepareHierarchyTasks(api, companyId, projectId, actors, hierarchyCount);
      root = integrationMode ? proof.hierarchyTasks.leaves[0] : proof.hierarchyTasks.root;
    } else {
    root = await api("POST", `/api/companies/${companyId}/issues`, { title: "Ordinary N1 to N2", description: "Produce two attributed complementary contributions and the reviewed publication", projectId, status: "backlog", assigneeAgentId: actors.lead });
    }
    created = await waitFor("scheduled project task admission", () => api("GET", `${missions}?companyId=${companyId}`),
      view => view.missions?.some((item: any) => item.mission.rootIssueId === root.id && item.mission.aggregate.n1), 180000);
    const admitted = created.missions.find((item: any) => item.mission.rootIssueId === root.id).mission;
    missionId = admitted.missionId; missionPath = `${missions}/${missionId}`;
    assert.equal(admitted.aggregate.projectMandate.revisionId, configured.policy.revisionId);
    proof.projectIntake = { policy: configured.policy, historicalRootId: historical.id, incompleteRootId: incomplete.id, hierarchyRootId: hierarchy.id, childId: child.id,
      createCommandsByOwner: 0, activationCommandsByOwner: 0, deliveryCommandsByOwner: 0, missionId };
  } else {
    root = await api("POST", `/api/companies/${companyId}/issues`, { title: "Ordinary N1 to N2", projectId, status: "backlog", assigneeAgentId: actors.lead });
    created = await api("POST", missions, { companyId, command: "create", commandId: randomUUID(), missionId, rootIssueId: root.id, projectId,
    teamRosterId: team.head.rosterId, teamRevision: pair.team.revision.revision, councilRosterId: council.head.rosterId, councilRevision: pair.council.revision.revision,
      mandate });
    await writeFile(fixtureConfig, JSON.stringify({ pluginId, companyId, projectId, missionId, rootIssueId: root.id, repoPath, runtime, actors, baseCommit, delivery: deliveryMode, n6: n6Mode, coordination: coordinationMode }));
  }
  let delivery: any;
  if (integrationMode) delivery = { advance: async () => {}, complete: (m: any) => m.aggregate.completion?.state === "closed", finish: async () => {
    const view = await api("GET", `${missionPath}?companyId=${companyId}`);
    assert.equal(view.n5.integratedReady, true);
    const remote = JSON.parse(await readFile(resolve(runtime, "github-transport.json"), "utf8"));
    assert.equal(remote.mergeCount, 1); assert.equal(remote.createCount, 1);
    proof.delivery = { remote, final: view.n5, integrated: true };
  } };
  else if (projectIntakeMode) delivery = nominalDeliveryObserver({ api, companyId, missionPath, runtime, proof });
  else if (continuityMode) {
    delivery = await prepareOrdinaryDelivery({ api, companyId, actors, rootIssueId: root.id, missionPath, runtime, proof, save, nominal: true });
    created = await api("GET", `${missionPath}?companyId=${companyId}`);
    created = await api("POST", `${missionPath}/commands`, { companyId, command: "configure-continuity", commandId: randomUUID(),
      expectedVersion: created.mission.version, authorizeProgression: true, n3Slots });
    proof.continuityAuthorization = created.mission.aggregate.continuity;
  }
  const activate = projectIntakeMode ? null : await api("POST", `${missionPath}/commands`, { companyId, command: "activate", commandId: randomUUID(), expectedVersion: created.mission.version,
    periodKey: profile.periodKey, reservationId: randomUUID(), requestedUnits: 1000 });
  let rootRunId: string;
  if (continuityMode) {
    const dispatched = await waitFor("scheduled lead dispatch", async () => (await api("GET", `${missionPath}?companyId=${companyId}`)).mission,
      m => Boolean(m.aggregate.n1.rootDispatchRunId), 180000);
    rootRunId = dispatched.aggregate.n1.rootDispatchRunId;
  } else {
    const started = await api("POST", `${missionPath}/commands`, { companyId, command: "start-lead", commandId: randomUUID(), expectedVersion: activate.mission.version });
    assert.equal(started.outcome, "requested", JSON.stringify(started));
    rootRunId = started.mission.aggregate.n1.rootDispatchRunId;
  }
  await waitFor("real N1 prerequisite", async () => {
    const runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
    for (const run of runs) {
      assert(!["failed", "cancelled", "timed_out"].includes(run.status), `N1 ${run.id} ${run.status} ${run.error}`);
    }
    return runs.find((run: any) => run.id === rootRunId);
  }, run => run?.status === "succeeded", 120000);
  if (prePlanResumeMode) {
    const before = await waitFor("terminal pre-plan usage reconciled", () => api("GET", `${missionPath}?companyId=${companyId}`),
      view => view.continuity?.observation?.code === "continuity_candidate_missing", 180000);
    assert.equal(before.mission.aggregate.n1.contributions.length, 0);
    const original = before.mission, coordinator = original.aggregate.n1.coordination.issueId;
    const oldReservation = original.aggregate.n1.activationReservationId;
    const suspend = await api("POST", `${missionPath}/commands`, { companyId, command: "suspend-continuity", commandId: randomUUID(), expectedVersion: original.version });
    await api("PATCH", `/api/issues/${coordinator}`, { status: "blocked", unblockDescriptor: {
      owner: "board", action: "Authorize the original Council pre-plan resume after settled terminal costs" } });
    const grant = { companyId, command: "prepare-n1-resume", commandId: randomUUID(), expectedVersion: suspend.mission.version,
      authorizeOneResume: true, authorizeContinuityResume: true, previousOwnerUserId: "local-board", reason: "Qualify one explicitly authorized terminal pre-plan resume" };
    const resumed = await api("POST", `${missionPath}/commands`, grant);
    assert.equal((await api("POST", `${missionPath}/commands`, grant)).outcome, "replayed");
    assert.deepEqual(resumed.mission.aggregate.hierarchy, original.aggregate.hierarchy);
    assert.deepEqual(resumed.mission.aggregate.n1.coordination, original.aggregate.n1.coordination);
    assert.equal(resumed.mission.aggregate.continuity.deadline, original.aggregate.continuity.deadline);
    assert.deepEqual(resumed.mission.aggregate.mandate, original.aggregate.mandate);
    const next = await waitFor("one scheduled resumed lead", () => api("GET", `${missionPath}?companyId=${companyId}`),
      view => Boolean(view.mission.aggregate.n1.rootDispatchRunId) && view.mission.aggregate.n1.rootDispatchRunId !== rootRunId, 180000);
    proof.prePlanResume = { originalMissionId: original.missionId, originalRootId: original.rootIssueId, coordinator,
      priorRunId: rootRunId, priorReservationId: oldReservation, grant, resumedRunId: next.mission.aggregate.n1.rootDispatchRunId,
      originalDeadline: original.aggregate.continuity.deadline };
    rootRunId = next.mission.aggregate.n1.rootDispatchRunId;
    await waitFor("resumed lead plan and candidate", () => api("GET", `/api/companies/${companyId}/heartbeat-runs`),
      runs => runs.some((run: any) => run.id === rootRunId && run.status === "succeeded"), 120000);
    proof.boundary += " One fixture lead terminates before planning. Native job settles its usage; owner explicitly suspends continuity, parks the original coordinator and grants one same-mission resume, with no rights/instruction/workspace repair. The grant is replayed without an extra run; the scheduled job starts the resumed lead.";
  }
  let mission = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  if (continuityMode) {
    await waitFor("scheduled N1 settlement", async () => (await api("GET", `${missionPath}?companyId=${companyId}`)).mission,
      m => m.aggregate.phase === "ready_for_review", integrationMode ? 360000 : 180000);
    const jobs = await api("GET", `/api/plugins/${pluginId}/jobs`);
    const job = jobs.find((j: any) => j.jobKey === "mission-continuity"); assert(job);
    await waitFor("completed native job before restart", () => api("GET", `/api/plugins/${pluginId}/jobs/${job.id}/runs`),
      runs => runs.length > 0 && runs.every((run: any) => run.status !== "running"), 30000);
    const before = await api("GET", `/api/plugins/${pluginId}/dashboard`);
    const beforeView = await api("GET", `${missionPath}?companyId=${companyId}`);
    const pinned = beforeView.mission.aggregate.continuity;
    await api("POST", `/api/plugins/${pluginId}/disable`, {});
    await api("POST", `/api/plugins/${pluginId}/enable`, {});
    const after = await api("GET", `/api/plugins/${pluginId}/dashboard`);
    assert.notEqual(before.worker.pid, after.worker.pid);
    const afterView = await api("GET", `${missionPath}?companyId=${companyId}`);
    assert.deepEqual(afterView.mission.aggregate.continuity, pinned);
    assert.deepEqual(afterView.continuity, beforeView.continuity);
    assert.equal(afterView.continuity.documentObserved, true);
    proof.continuityRestart = { beforePid: before.worker.pid, afterPid: after.worker.pid, pinned, observation: afterView.continuity };
  } else {
    const settleBody = { companyId, command: "reconcile-lead-usage", commandId: randomUUID(), expectedVersion: mission.version };
    await waitFor("N1 source settlement", async () => {
      const response = await fetch(`${base}${missionPath}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settleBody) });
      const body = await response.json();
      if (response.ok) return body;
      assert(["g4_usage_unavailable", "g4_run_not_terminal"].includes(body.code), JSON.stringify(body)); return null;
    }, Boolean);
  }
  mission = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  assert.equal(mission.aggregate.phase, "ready_for_review");
  assert.equal(mission.aggregate.nativeWakePolicy.protocol, "council-native-wake-v2");
  assert.equal((await api("GET", `/api/issues/${root.id}`)).status, "blocked");
  const nativeChildren = await Promise.all(mission.aggregate.n1.contributions.map((slot: any) => api("GET", `/api/issues/${slot.childIssueId}`)));
  assert(nativeChildren.every((issue: any) => issue.status === (integrationMode ? "blocked" : "done")));
  assert.equal((await api("GET", `/api/agents/${actors.lead}`)).runtimeConfig.heartbeat.wakeOnDemand, true);
  proof.nativeWaiting = { rootStatus: "blocked", childrenStatus: integrationMode ? "blocked" : "done", leadDemandWakes: true, operatorChildCloses: 0 };
  proof.prerequisite = mission;
  if (!continuityMode && deliveryMode) delivery = await prepareOrdinaryDelivery({ api, companyId, actors, rootIssueId: root.id, missionPath, runtime, proof, save });
  mission = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  const n6 = n6Mode ? prepareN6Scenario({ api, companyId, projectId, actors, missions, missionPath, profile, runtime, fixtureConfig, proof, coordinationMode }) : undefined;
  const reviewBody = { companyId, command: "start-review", commandId: randomUUID(), expectedVersion: mission.version, submissionId: randomUUID(), n3Slots };
  if (!continuityMode) await api("POST", `${missionPath}/commands`, reviewBody);
  record(continuityMode ? "waiting_for_scheduled_review" : "ordinary_review_started");
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
    await delivery?.advance(value);
    await n6?.advance(value);
    return value;
  }, value => completionMode ? value.aggregate.completion?.state === "closed" : delivery ? delivery.complete(value) : value.aggregate.n2?.status === "accepted", continuityMode ? integrationMode ? 720000 : feedbackMode ? 900000 : 300000 : 120000);
  await delivery?.finish();
  await n6?.finish();
  if (continuityMode) {
    const final = await waitFor("scheduled complete observation", () => api("GET", `${missionPath}?companyId=${companyId}`),
      view => view.continuity?.observation?.state === "complete" && view.continuity.documentObserved === true, 180000);
    proof.mission = final.mission; proof.continuityFinalObservation = final.continuity;
    const jobs = await api("GET", `/api/plugins/${pluginId}/jobs`);
    const job = jobs.find((j: any) => j.jobKey === "mission-continuity");
    proof.continuityJobRuns = await waitFor("final native job completion", () => api("GET", `/api/plugins/${pluginId}/jobs/${job.id}/runs`),
      runs => runs.every((run: any) => run.status !== "running"), 30000);
    assert(proof.continuityJobRuns.length >= 4);
    assert(proof.continuityJobRuns.every((run: any) => run.trigger === "schedule" && run.status === "succeeded"));
    proof.boundary += " Native scheduled jobs dispatch the admitted lead, settle N1 and start review from an explicit persisted owner delegation. Worker restart occurs after N1 settlement and before review. Observation after activation is read-only; no manual job trigger or owner transition.";
  } else {
    await api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-ordinary-n2" });
    const replay = await api("POST", `${missionPath}/commands`, reviewBody);
    assert.equal(replay.outcome, "replayed");
    const after = await api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-ordinary-n2" });
    proof.mission = after.mission;
  }
  proof.runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
  proof.admission = (await api("GET", `${admissionPath}?companyId=${companyId}&periodKey=${profile.periodKey}`)).envelope;
  assert.equal(proof.runs.length, (integrationMode ? 8 : feedbackMode ? 16 : hierarchyCount ? hierarchyCount + 5 : continuityMode ? 7 : coordinationMode ? 14 : n6Mode ? 11 : deliveryMode ? 12 : 10) + Number(prePlanResumeMode));
  assert(proof.runs.every((run: any) => run.status === "succeeded"));
  assert.equal(proof.mission.aggregate.n2.ordinary.tasks.length, feedbackMode ? 10 : continuityMode ? 3 : 7);
  assert(proof.admission.reservations.every((item: any) => item.status === "settled"));
  assert.equal(proof.admission.allowance.knownUsageUnits, (integrationMode ? 1200 : feedbackMode ? 2400 : hierarchyCount ? (hierarchyCount + 5) * 150 : continuityMode ? 1050 : coordinationMode ? 2100 : n6Mode ? 1650 : deliveryMode ? 1800 : 1500) + Number(prePlanResumeMode) * 150);
  if (prePlanResumeMode) {
    assert.equal(proof.mission.missionId, proof.prePlanResume.originalMissionId);
    assert.equal(proof.mission.rootIssueId, proof.prePlanResume.originalRootId);
    const old = proof.admission.reservations.find((item: any) => item.reservationId === proof.prePlanResume.priorReservationId);
    assert.equal(old.status, "settled"); assert.equal(old.usage.units, 150);
    assert.equal(proof.runs.filter((run: any) => run.contextSnapshot.issueId === proof.prePlanResume.coordinator).length, 2);
    proof.prePlanResume.checks = { sameMissionSourceDeadline: "PASS", oldCostRetained: "PASS", replayNoExtraDeparture: "PASS", exactRunLimit: "PASS" };
  }
  const { acceptedN5Submission } = await import("../../src/n5-preflight.js");
  proof.n5Handoff = acceptedN5Submission(proof.mission);
  const n2 = proof.mission.aggregate.n2;
  if (!continuityMode) {
    assert.notEqual(n2.submissions[0].candidateCommit, n2.submissions[1].candidateCommit);
    proof.candidateDiff = gitAt(repoPath, "diff", n2.submissions[0].candidateCommit, n2.submissions[1].candidateCommit);
    assert.equal(Object.keys(proof.runningReportObservations ?? {}).length, 2);
  } else assert.equal(Object.keys(proof.runningReportObservations ?? {}).length, feedbackMode ? 3 : 1);
  proof.agentApiReadbacks = await Promise.all((await readdir(runtime)).filter(name => name.startsWith("api-")).map(async name => JSON.parse(await readFile(resolve(runtime, name), "utf8"))));
  assert.equal(proof.agentApiReadbacks.length, feedbackMode ? 10 : continuityMode ? 3 : 7);
  proof.gatewayRefusal = JSON.parse(await readFile(resolve(runtime, "gateway-refusal.json"), "utf8"));
  proof.issues = await Promise.all([...new Set(proof.mission.aggregate.n2.ordinary.tasks.map((task: any) => task.issueId))].map(id => api("GET", `/api/issues/${id}`)));
  if (hierarchyCount && !integrationMode) await verifyHierarchyTasks(api, proof, root.id);
  if (completionMode) {
    const c = proof.mission.aggregate.completion;
    assert.equal(c.state, "closed"); assert.equal(c.notification.state, "confirmed");
    const doc = await api("GET", `/api/issues/${root.id}/documents/${c.documentKey}`);
    assert.equal(doc.latestRevisionId, c.documentRevisionId); assert.equal(doc.body, c.body);
    const evidence = JSON.parse(doc.body); assert.equal(evidence.proofId, c.proofId);
    assert.equal(evidence.submission.candidateCommit, proof.mission.aggregate.n2.submissions.at(-1).candidateCommit);
    const comments = await api("GET", `/api/issues/${root.id}/comments`);
    const matching = comments.filter((comment: any) => comment.body === c.notification.body);
    assert.equal(matching.length, 1); assert.equal(matching[0].id, c.notification.commentId);
    for (const slot of proof.mission.aggregate.n1.contributions) {
      assert(slot.proof.closedAt && slot.proof.checks.every((check: any) => check.status === "passed"));
      const held = JSON.parse(await readFile(resolve(runtime, `child-proof-${slot.authorRunId}.json`), "utf8"));
      assert.equal(held.statusWhileRunning, "blocked");
    }
    proof.completion = { state: c, evidence, comment: matching[0], checks: { childrenHeldUntilTerminalProof: "PASS", parentResultProof: "PASS", singleNativeNotification: "PASS", noAdditionalRun: "PASS" } };
    proof.boundary += " Explicit draft-result proof closure verifies child bundles before recording, holds children until exact succeeded run costs settle, closes all original parents bottom-up after dependencies and accepted exact-head publication, and confirms one agent-attributed native comment without another provider wake. No manual task transition after activation, no merge/deployment/install result inferred.";
  }
  if (integrationMode) {
    const parent = await api("GET", `/api/issues/${proof.hierarchyTasks.root.id}`);
    assert.notEqual(parent.status, "done", "Parent own obligations remain separate");
    proof.boundary += " One native existing code leaf owns one PR and a separately admitted integration run; real Git squash commit and post-merge report pass, while GitHub HTTP/writes are deterministic fixtures. Original parent stays pending its own obligations. No recette activation or real GitHub merge occurred.";
  }
  if (projectIntakeMode && !integrationMode) {
    const view = await api("GET", `${missions}?companyId=${companyId}`);
    assert.equal(view.missions.length, 1);
    for (const id of [proof.projectIntake.incompleteRootId, proof.projectIntake.hierarchyRootId]) {
      const interactions = await api("GET", `/api/issues/${id}/interactions`);
      assert.equal(interactions.length, 1); assert.equal(interactions[0].addresseeUserId, "local-board");
      assert.equal(interactions[0].continuationPolicy, "none");
    }
    assert.equal((await api("GET", `/api/issues/${proof.projectIntake.historicalRootId}`)).status, "backlog");
    assert.equal((await api("GET", `/api/issues/${proof.projectIntake.childId}`)).status, "backlog");
    assert.equal(proof.mission.aggregate.projectMandate.publication.headRefPrefix, "codex/project-task");
    proof.projectIntake.checks = { oneMissionFromCreatedTask: "PASS", singleOwnerQuestions: "PASS", historicalAndChildTasksPreserved: "PASS", explicitPublicationAuthority: "PASS", noOwnerMissionTransitions: "PASS" };
    proof.boundary += " The native job creates and admits the sole complete newly created manual Backlog task under a pinned project mandate, configures continuity and publication, and ignores historical tasks. Incomplete and existing-hierarchy roots each retain one native owner question, without model wake or duplicate child.";
  }
  assert(proof.issues.every((issue: any) => issue.status === "done" && !issue.executionPolicy && !issue.executionState));
  assert(proof.issues.filter((issue: any) => issue.id !== root.id).every((issue: any) => !issue.parentId));
  proof.checks = { exactAgentApiBindings: "PASS", reportWhileRunningDoesNotAdmit: "PASS", realN1Prerequisite: "PASS", installedOrdinaryN2N3: "PASS", expectedCliRunsSucceeded: "PASS", replayNoExtraRun: "PASS", allReservationsSettled: "PASS", n5Handoff: "PASS" };
  if (deliveryMode && !continuityMode) {
    proof.admittedRunCount = proof.runs.length;
    await qualifyNativeRunException({ api, db, tables, eq, companyId, actors, rootIssueId: root.id, pluginId, missionPath, admissionPath, profile, proof });
    proof.boundary += " Native exception qualification seeds one heartbeat row, then uses installed APIs and a real plugin restart; it does not launch an external wake or provider.";
  }
  proof.outcome = success;
} catch (error) {
  proof.outcome = "BLOCKED"; proof.error = { message: String(error), stack: error instanceof Error ? error.stack : undefined };
} finally {
  try {
    if (proof.companyId && base) {
      proof.runs = await api("GET", `/api/companies/${proof.companyId}/heartbeat-runs`);
      proof.fixtureFailures = (await Promise.all(proof.runs.map((run: any) => readFile(resolve(runtime, `fixture-failure-${run.id}.json`), "utf8").then(body => JSON.parse(body)).catch(() => null)))).filter(Boolean);
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
  restoreFetch?.();
  process.exit(proof.outcome === success ? 0 : 1);
}
