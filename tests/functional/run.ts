import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCandidatePackage } from "./candidate-package.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const expectedCandidateCommit = process.env.COUNCIL_PACKAGE_EXPECTED_COMMIT;
if (!expectedCandidateCommit || !/^[0-9a-f]{40}$/.test(expectedCandidateCommit)) {
  throw new Error("COUNCIL_PACKAGE_EXPECTED_COMMIT must be the exact 40-character candidate commit");
}
const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
assert.equal(candidateCommit, expectedCandidateCommit, "functional candidate must match the expected commit");
const candidateStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
assert.equal(candidateStatus, "", "functional candidate worktree must be clean");
const candidateBranch = execFileSync("git", ["branch", "--show-current"], {
  cwd: packageRoot,
  encoding: "utf8",
}).trim();
const hostRootInput = process.env.PAPERCLIP_TEST_HOST_ROOT;
if (!hostRootInput) {
  throw new Error("PAPERCLIP_TEST_HOST_ROOT must point to the Paperclip checkout under test");
}
const root = resolve(hostRootInput);
const expectedHostCommit = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
const hostCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(hostCommit, expectedHostCommit, `functional host must be Paperclip ${expectedHostCommit}`);
const hostImport = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const qualificationId = randomUUID();
const runtime = await mkdtemp(resolve(tmpdir(), "paperclip-council-package-"));
const preparedCandidate = await prepareCandidatePackage(packageRoot, candidateCommit, runtime);
const evidencePath = process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
  ?? resolve(packageRoot, "artifacts", "functional.json");
await mkdir(dirname(evidencePath), { recursive: true });

Object.assign(process.env, {
  PAPERCLIP_HOME: runtime,
  PAPERCLIP_INSTANCE_ID: `council-package-${qualificationId}`,
  PAPERCLIP_CONFIG: resolve(runtime, "config.json"),
  PAPERCLIP_SECRETS_MASTER_KEY_FILE: resolve(runtime, "master.key"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  PAPERCLIP_AUTH_RATE_LIMIT_ENABLED: "false",
  PAPERCLIP_LOG_LEVEL: "warn",
  PAPERCLIP_UI_DEV_MIDDLEWARE: "false",
  PAPERCLIP_TELEMETRY_ENABLED: "false",
  PAPERCLIP_STORAGE_PROVIDER: "local_disk",
  PAPERCLIP_STORAGE_LOCAL_DIR: resolve(runtime, "storage"),
  OTEL_SDK_DISABLED: "true",
  NODE_ENV: "test",
});
for (const key of [
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PAPERCLIP_MANAGED_CONFIG",
  "PAPERCLIP_CLOUD_TENANT_TOKEN",
  "PAPERCLIP_TRUSTED_USER_ID",
  "BETTER_AUTH_URL",
  "PAPERCLIP_PUBLIC_URL",
]) delete process.env[key];

const requireServer = createRequire(resolve(root, "server/package.json"));
const { eq } = requireServer("drizzle-orm");
const evidence: Record<string, any> = {
  schemaVersion: 1,
  proofId: "paperclip-council-s1-configuration-2026-09-30",
  startedAt: new Date().toISOString(),
  head: hostCommit,
  branch: execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version,
  command: "COUNCIL_PACKAGE_EXPECTED_COMMIT=<candidate-sha> PAPERCLIP_TEST_HOST_ROOT=<checkout> PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH=<chromium> pnpm test:functional",
  candidate: {
    commit: candidateCommit,
    branch: candidateBranch,
    clean: candidateStatus === "",
    source: "git archive of the exact candidate commit, built in an isolated temporary directory",
    sourceArchiveSha256: preparedCandidate.sourceArchiveSha256,
    distSha256: preparedCandidate.distSha256,
  },
  configuration: {
    database: "fresh embedded PostgreSQL test cluster",
    deploymentMode: "authenticated/private",
    models: "none",
    fixtureBoundary: "agents, issues, policies, and heartbeat runs are synthetic test preparation",
    credentials: "agent keys created by native board API; council token transferred directly to local_encrypted secret",
  },
  steps: [],
  results: {},
  outcome: "RUNNING",
};
const save = () => writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
await save();

let database: any;
let db: any;
let app: any;
let server: Server | undefined;
let workerManager: any;
let baseUrl = "";
let cookie = "";
let intruderCookie = "";
let tables: any;
let issueId: string | undefined;
const companyId = randomUUID();
const projectId = randomUUID();
const executorId = randomUUID();
const councilId = randomUUID();
const foreignCompanyId = randomUUID();
const agentTokens = new Map<string, { token: string; keyId: string; runId: string; agentId: string }>();

async function safeSnapshot() {
  if (!issueId) return null;
  const [issue] = await db.select().from(tables.issues).where(eq(tables.issues.id, issueId));
  const decisions = await db.select({
    id: tables.issueExecutionDecisions.id,
    actorAgentId: tables.issueExecutionDecisions.actorAgentId,
    outcome: tables.issueExecutionDecisions.outcome,
    body: tables.issueExecutionDecisions.body,
    createdByRunId: tables.issueExecutionDecisions.createdByRunId,
  }).from(tables.issueExecutionDecisions).where(eq(tables.issueExecutionDecisions.issueId, issueId));
  return { issue, decisions };
}

function redactedResponse(method: string, path: string, value: any) {
  if (path.startsWith("/_plugins/")) {
    return { installedUiBundle: typeof value === "string", byteLength: typeof value === "string" ? Buffer.byteLength(value) : null };
  }
  if (path.startsWith("/api/auth/")) {
    return { user: value?.user ? { id: value.user.id, email: value.user.email } : null };
  }
  if (path.includes("/secrets")) {
    return { id: value?.id, name: value?.name, key: value?.key, provider: value?.provider };
  }
  if (method === "POST" && /^\/api\/agents\/[^/]+\/keys$/.test(path)) {
    return { id: value?.id, agentId: value?.agentId, name: value?.name, scope: value?.scope };
  }
  return value;
}

async function request(actor: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: baseUrl };
  if (actor === "human") headers.cookie = cookie;
  if (actor === "intruder") headers.cookie = intruderCookie;
  const agent = agentTokens.get(actor);
  if (agent) {
    headers.authorization = `Bearer ${agent.token}`;
    headers["x-paperclip-run-id"] = agent.runId;
  }
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const raw = await response.text();
  let value: any;
  try { value = JSON.parse(raw); } catch { value = raw; }
  evidence.steps.push({
    actor,
    authenticatedAgentId: agent?.agentId ?? null,
    runId: agent?.runId || null,
    method,
    path,
    body: path.startsWith("/api/auth/") || path.includes("/secrets") ? "[credential material omitted]" : body,
    httpStatus: response.status,
    response: redactedResponse(method, path, value),
    persistentSnapshot: await safeSnapshot(),
    at: new Date().toISOString(),
  });
  await save();
  return { status: response.status, body: value, headers: response.headers };
}

async function freshRun(actor: "executor" | "council") {
  const current = agentTokens.get(actor)!;
  const runId = randomUUID();
  await db.insert(tables.heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: current.agentId,
    status: "running",
    responsibleUserId: evidence.configuration.humanUserId,
    contextSnapshot: { issueId, fixture: "deterministic council package qualification" },
  });
  agentTokens.set(actor, { ...current, runId });
  return runId;
}

async function checkoutExecutor(expectedStatus: string) {
  await freshRun("executor");
  const principal = agentTokens.get("executor")!;
  const result = await request("executor", "POST", `/api/issues/${issueId}/checkout`, {
    agentId: principal.agentId,
    expectedStatuses: [expectedStatus],
  });
  assert.equal(result.status, 200, "executor checkout must succeed");
}

async function closeApp() {
  await workerManager?.stopAll();
  if (app) await app.locals.paperclipShutdown();
  if (server) await new Promise<void>((resolveClose, reject) => {
    server!.close((error) => error ? reject(error) : resolveClose());
  });
  server = undefined;
  app = undefined;
}

try {
  tables = await hostImport("packages/db/src/index.ts");
  const { createApp } = await hostImport("server/src/app.ts");
  const {
    createBetterAuthInstance,
    createBetterAuthHandler,
    resolveBetterAuthSession,
  } = await hostImport("server/src/auth/better-auth.ts");
  const { createPluginWorkerManager } = await hostImport("server/src/services/plugin-worker-manager.ts");
  const { createStorageService } = await hostImport("server/src/storage/service.ts");
  const { createLocalDiskStorageProvider } = await hostImport("server/src/storage/local-disk-provider.ts");

  database = await tables.startEmbeddedPostgresTestDatabase("paperclip-council-package-");
  db = tables.createDb(database.connectionString);
  server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const authConfig: any = {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl: baseUrl,
    authDisableSignUp: false,
    allowedHostnames: ["127.0.0.1"],
    port: address.port,
  };
  const auth = createBetterAuthInstance(db, authConfig, [baseUrl]);
  const opts = (uiMode: "none" | "vite-dev" = "none") => ({
    uiMode,
    serverPort: address.port,
    storageService: createStorageService(createLocalDiskStorageProvider(resolve(runtime, "storage"))),
    deploymentMode: "authenticated" as const,
    deploymentExposure: "private" as const,
    allowedHostnames: ["127.0.0.1"],
    bindHost: "127.0.0.1",
    authPublicBaseUrl: baseUrl,
    authReady: true,
    companyDeletionEnabled: false,
    announcements: { enabled: false, feedUrl: "" },
    instanceId: `council-package-${qualificationId}`,
    hostVersion: "0.3.1",
    localPluginDir: resolve(runtime, "plugins"),
    pluginWorkerManager: workerManager,
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
    betterAuthHandler: createBetterAuthHandler(auth),
    resolveSession: (req: any) => resolveBetterAuthSession(auth, req),
  });
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts());
  server.on("request", app);
  await app.locals.bundledPluginsStartup;

  const password = randomBytes(24).toString("hex");
  assert.equal((await request("anonymous", "POST", "/api/auth/sign-up/email", {
    email: "council-package@example.test",
    password,
    name: "Council Package Test",
  })).status, 200);
  const signin = await request("anonymous", "POST", "/api/auth/sign-in/email", {
    email: "council-package@example.test",
    password,
  });
  assert.equal(signin.status, 200);
  cookie = signin.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const userId = signin.body.user.id;
  evidence.configuration.humanUserId = userId;

  const intruderPassword = randomBytes(24).toString("hex");
  assert.equal((await request("anonymous", "POST", "/api/auth/sign-up/email", {
    email: "council-package-intruder@example.test",
    password: intruderPassword,
    name: "Council Package Intruder",
  })).status, 200);
  const intruderSignin = await request("anonymous", "POST", "/api/auth/sign-in/email", {
    email: "council-package-intruder@example.test",
    password: intruderPassword,
  });
  assert.equal(intruderSignin.status, 200);
  intruderCookie = intruderSignin.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const intruderUserId = intruderSignin.body.user.id;
  evidence.configuration.intruderUserId = intruderUserId;

  await db.insert(tables.companies).values({ id: companyId, name: "Isolated council package qualification", issuePrefix: "CPQ", defaultResponsibleUserId: userId });
  await db.insert(tables.companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(tables.companyMemberships).values({ companyId, principalType: "user", principalId: intruderUserId, membershipRole: "admin", status: "active" });
  await db.insert(tables.instanceUserRoles).values({ userId, role: "instance_admin" });
  await db.insert(tables.companies).values({ id: foreignCompanyId, name: "Foreign Council fixture", issuePrefix: "FCQ", defaultResponsibleUserId: userId });
  await db.insert(tables.companyMemberships).values({ companyId: foreignCompanyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(tables.projects).values({ id: projectId, companyId, name: "Council package fixture" });
  for (const [actor, id] of [["executor", executorId], ["council", councilId]] as const) {
    await db.insert(tables.agents).values({
      id,
      companyId,
      name: actor,
      role: actor === "council" ? "reviewer" : "engineer",
      adapterType: "process",
      adapterConfig: { command: "/usr/bin/false" },
      status: "idle",
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    const createdKey = await request("human", "POST", `/api/agents/${id}/keys`, {
      name: actor === "council" ? "paperclip-council" : "council-fixture-executor",
      scope: { kind: "standard" },
    });
    assert.equal(createdKey.status, 201);
    assert.equal(createdKey.body.scope.kind, "standard");
    agentTokens.set(actor, { token: createdKey.body.token, keyId: createdKey.body.id, runId: "", agentId: id });
  }
  evidence.configuration.companyId = companyId;
  evidence.configuration.executorAgentId = executorId;
  evidence.configuration.councilAgentId = councilId;
  evidence.configuration.councilKeyId = agentTokens.get("council")!.keyId;
  evidence.configuration.councilKeyScope = { kind: "standard" };

  const secret = await request("human", "POST", `/api/companies/${companyId}/secrets`, {
    name: "Council agent API key",
    key: "COUNCIL_AGENT_API_KEY",
    provider: "local_encrypted",
    value: agentTokens.get("council")!.token,
    description: "Ephemeral isolated package qualification credential",
  });
  assert.equal(secret.status, 201);
  evidence.configuration.secretId = secret.body.id;

  const install = await request("human", "POST", "/api/plugins/install", {
    packageName: preparedCandidate.packageRoot,
    isLocalPath: true,
  });
  assert.equal(install.status, 200);
  const pluginId = install.body.id;
  evidence.configuration.pluginId = pluginId;
  const configured = await request("human", "POST", `/api/plugins/${pluginId}/config`, {
    companyId,
    configJson: {
      apiBaseUrl: baseUrl,
      councilAgentId: councilId,
      councilApiKey: { type: "secret_ref", secretId: secret.body.id },
    },
  });
  assert.equal(configured.status, 200);

  await closeApp();
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts("vite-dev"));
  server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(address.port, "127.0.0.1", resolveListen);
  });
  await app.locals.bundledPluginsStartup;
  assert(workerManager.isRunning(pluginId), "installed package worker must load after restart");
  evidence.results.installation = "PASS";

  const rosterBase = `/api/plugins/${pluginId}/api/companies/${companyId}/rosters`;
  const teamDraft = {
    kind: "team",
    name: "Delivery team",
    projectId,
    members: [{ agentId: executorId, responsibilities: ["integration_lead"] }],
    integrationLeadAgentId: executorId,
    finalReviewerAgentId: null,
    requiredPerspectives: [],
  };
  const councilDraft = {
    kind: "council",
    name: "Release council",
    projectId,
    members: [{ agentId: councilId, responsibilities: ["final_reviewer"] }],
    integrationLeadAgentId: null,
    finalReviewerAgentId: councilId,
    requiredPerspectives: [],
  };

  const unauthorizedBefore = await request("human", "GET", `${rosterBase}?companyId=${companyId}`);
  assert.equal(unauthorizedBefore.status, 200);
  assert.deepEqual(unauthorizedBefore.body.rosters, []);
  const unauthorizedCreate = await request("intruder", "POST", rosterBase, {
    companyId,
    ownerUserId: userId,
    command: "create",
    roster: teamDraft,
  });
  assert.equal(unauthorizedCreate.status, 403);
  assert.equal(unauthorizedCreate.body.code, "owner_required");
  const afterUnauthorized = await request("human", "GET", `${rosterBase}?companyId=${companyId}`);
  assert.deepEqual(afterUnauthorized.body.rosters, []);
  evidence.results.ownerAuthorityNoMutation = "PASS";

  const teamCreate = await request("human", "POST", rosterBase, { companyId, command: "create", roster: teamDraft });
  const councilCreate = await request("human", "POST", rosterBase, { companyId, command: "create", roster: councilDraft });
  assert.equal(teamCreate.status, 201);
  assert.equal(councilCreate.status, 201);
  const teamRosterId = teamCreate.body.head.rosterId;
  const councilRosterId = councilCreate.body.head.rosterId;
  assert.equal(teamCreate.body.head.publishedRevision, teamCreate.body.revision.revision);
  assert.equal(councilCreate.body.head.publishedRevision, councilCreate.body.revision.revision);

  const validation = await request("human", "POST", rosterBase, {
    companyId,
    command: "validate-pair",
    teamRosterId,
    councilRosterId,
  });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.eligible, true);
  assert(validation.body.prerequisites.some((item: any) => item.code === "decision_reconciliation" && item.status === "unsupported"));
  const activation = await request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId,
    teamExpectedVersion: 1,
    councilRosterId,
    councilExpectedVersion: 1,
  });
  assert.equal(activation.status, 200);
  assert.equal(activation.body.team.head.lifecycle, "active");
  assert.equal(activation.body.council.head.lifecycle, "active");
  assert.equal(activation.body.missionActivation, "unavailable");
  evidence.results.createValidateActivate = "PASS";

  const competingRevisions = await Promise.all([
    request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
      companyId, command: "revise", expectedVersion: 2,
      roster: { ...teamDraft, name: "Delivery team revision A" },
    }),
    request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
      companyId, command: "revise", expectedVersion: 2,
      roster: { ...teamDraft, name: "Delivery team revision B" },
    }),
  ]);
  assert.deepEqual(competingRevisions.map((result) => result.status).sort(), [200, 409]);
  const winningRevision = competingRevisions.find((result) => result.status === 200)!.body.roster;
  const conflictingRevision = competingRevisions.find((result) => result.status === 409)!.body.details;
  assert.equal(conflictingRevision.outcome, "conflict");
  assert.notEqual(conflictingRevision.orphanedRevision, winningRevision.head.publishedRevision);
  const teamRead = await request("human", "GET", `${rosterBase}/${teamRosterId}?companyId=${companyId}`);
  assert.equal(teamRead.status, 200);
  assert.equal(teamRead.body.history.length, 3);
  const originalRevision = teamRead.body.history.find((item: any) => item.revision === teamCreate.body.revision.revision);
  assert.equal(originalRevision.name, "Delivery team");
  assert.deepEqual(originalRevision.content, teamDraft.members ? {
    members: teamDraft.members,
    integrationLeadAgentId: executorId,
    finalReviewerAgentId: null,
    requiredPerspectives: [],
  } : null);
  evidence.results.concurrentPublicationAndImmutability = "PASS";

  const reactivate = await request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId,
    teamExpectedVersion: winningRevision.head.version,
    councilRosterId,
    councilExpectedVersion: activation.body.council.head.version,
  });
  assert.equal(reactivate.status, 200);
  const suspend = await request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
    companyId, command: "suspend", expectedVersion: reactivate.body.team.head.version,
  });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.head.lifecycle, "suspended");
  const staleSuspend = await request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
    companyId, command: "suspend", expectedVersion: reactivate.body.team.head.version,
  });
  assert.equal(staleSuspend.status, 409);
  const afterStale = await request("human", "GET", `${rosterBase}/${teamRosterId}?companyId=${companyId}`);
  assert.equal(afterStale.body.roster.head.lifecycle, "suspended");
  assert.equal(afterStale.body.roster.head.version, suspend.body.head.version);
  const retired = await request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
    companyId, command: "retire", expectedVersion: suspend.body.head.version,
  });
  assert.equal(retired.status, 200);
  assert.equal(retired.body.head.lifecycle, "retired");
  assert.equal((await request("human", "GET", `${rosterBase}/${teamRosterId}?companyId=${companyId}`)).body.history.length, 3);
  evidence.results.reviseSuspendRetireAndStaleNoMutation = "PASS";

  const foreignBase = `/api/plugins/${pluginId}/api/companies/${foreignCompanyId}/rosters`;
  const foreignList = await request("human", "GET", `${foreignBase}?companyId=${foreignCompanyId}`);
  assert.equal(foreignList.status, 200);
  assert.deepEqual(foreignList.body.rosters, []);
  const foreignWrite = await request("human", "POST", `${foreignBase}/${teamRosterId}/commands`, {
    companyId: foreignCompanyId,
    command: "revise",
    expectedVersion: retired.body.head.version,
    roster: { ...teamDraft, projectId: null, name: "Cross-company overwrite" },
  });
  assert.equal(foreignWrite.status, 404);
  const ownReadAfterForeign = await request("human", "GET", `${rosterBase}/${teamRosterId}?companyId=${companyId}`);
  assert.equal(ownReadAfterForeign.body.roster.revision.name, winningRevision.revision.name);
  evidence.results.interCompanyIsolation = "PASS";

  const bridgeData = await request("human", "POST", `/api/plugins/${pluginId}/bridge/data`, {
    key: "council-rosters",
    companyId,
    params: { rosterId: teamRosterId },
  });
  assert.equal(bridgeData.status, 200);
  assert.equal(bridgeData.body.data.selected.head.rosterId, teamRosterId);
  assert.equal(bridgeData.body.data.ownerUserId, userId);
  const uiBundle = await request("human", "GET", `/_plugins/${pluginId}/ui/index.js?companyId=${companyId}`);
  assert.equal(uiBundle.status, 200);
  assert.match(uiBundle.body, /CouncilRostersPage|Council rosters/);
  evidence.results.installedUiBundleAndAuthenticatedBridge = "PASS";

  const { chromium } = requireServer("@playwright/test");
  const playwrightExecutablePath = process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    headless: true,
    ...(playwrightExecutablePath ? { executablePath: playwrightExecutablePath } : {}),
  });
  evidence.configuration.playwrightExecutable = playwrightExecutablePath ?? "Playwright-managed default";
  try {
    const addSessionCookies = async (browserContext: any, rawCookie: string) => {
      await browserContext.addCookies(rawCookie.split("; ").map((part) => {
        const separator = part.indexOf("=");
        return { name: part.slice(0, separator), value: part.slice(separator + 1), url: baseUrl };
      }));
    };
    const ownerContext = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    await addSessionCookies(ownerContext, cookie);
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`${baseUrl}/CPQ/council-rosters`, { waitUntil: "networkidle" });
    await ownerPage.getByRole("heading", { name: "Council rosters" }).waitFor();
    await ownerPage.getByRole("button", { name: "New roster" }).focus();
    await ownerPage.keyboard.press("Enter");
    await ownerPage.getByLabel("Name").fill("Browser-created team");
    await ownerPage.getByLabel("Integration lead").selectOption(executorId);
    await ownerPage.getByRole("button", { name: "Create draft" }).click();
    await ownerPage.getByText("Draft roster created.").waitFor();
    await ownerPage.getByText("Browser-created team").first().waitFor();
    const screenshotPath = process.env.COUNCIL_UI_SCREENSHOT_PATH ?? resolve(packageRoot, "artifacts", "ui-page.png");
    await mkdir(dirname(screenshotPath), { recursive: true });
    await ownerPage.screenshot({ path: screenshotPath, fullPage: true });
    evidence.configuration.uiScreenshot = screenshotPath;

    const browserCreatedList = await request("human", "GET", `${rosterBase}?companyId=${companyId}`);
    const browserCreated = browserCreatedList.body.rosters.find((entry: any) => entry.revision.name === "Browser-created team");
    assert(browserCreated);
    const concurrentBrowserRevision = await request("human", "POST", `${rosterBase}/${browserCreated.head.rosterId}/commands`, {
      companyId,
      command: "revise",
      expectedVersion: browserCreated.head.version,
      roster: { ...teamDraft, name: "Concurrent browser revision" },
    });
    assert.equal(concurrentBrowserRevision.status, 200);
    await ownerPage.getByLabel("Name").fill("Stale browser revision");
    await ownerPage.getByRole("button", { name: "Publish revision" }).click();
    await ownerPage.getByRole("alert").filter({ hasText: "stale" }).waitFor();
    await ownerContext.close();

    const loadingContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(loadingContext, cookie);
    const loadingPage = await loadingContext.newPage();
    await loadingPage.route("**/api/plugins/*/bridge/data", async (route) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      await route.continue();
    });
    const loadingNavigation = loadingPage.goto(`${baseUrl}/FCQ/council-rosters`, { waitUntil: "domcontentloaded" });
    await loadingPage.getByText("Loading Council roster configuration…").waitFor();
    await loadingNavigation;
    await loadingPage.getByText("No rosters yet. Create the first team or council below.").waitFor();
    await loadingContext.close();

    const errorContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(errorContext, cookie);
    const errorPage = await errorContext.newPage();
    await errorPage.route("**/api/plugins/*/bridge/data", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Injected UI load failure" }),
    }));
    await errorPage.goto(`${baseUrl}/CPQ/council-rosters`, { waitUntil: "domcontentloaded" });
    await errorPage.getByRole("alert").filter({ hasText: "Council configuration could not load" }).waitFor();
    await errorContext.close();

    const intruderContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(intruderContext, intruderCookie);
    const intruderPage = await intruderContext.newPage();
    await intruderPage.goto(`${baseUrl}/CPQ/council-rosters`, { waitUntil: "networkidle" });
    await intruderPage.getByText("Status: read only").waitFor();
    assert.equal(await intruderPage.getByRole("button", { name: "Create draft" }).isDisabled(), true);
    await intruderContext.close();
    evidence.results.installedBrowserPageAndAuthenticatedAction = "PASS";
    evidence.results.installedBrowserStates = "PASS";
  } finally {
    await browser.close();
  }

  const policy = {
    mode: "normal",
    commentRequired: true,
    stages: [{
      id: randomUUID(),
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId: councilId }],
    }],
  };
  const created = await request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "Council package V1 to V2 qualification",
    description: "Synthetic fixture only; no external delivery.",
    projectId,
    status: "in_progress",
    assigneeAgentId: executorId,
    executionPolicy: policy,
  });
  assert.equal(created.status, 201);
  issueId = created.body.id;

  const foundationPath = `/api/plugins/${pluginId}/api/issues/${issueId}/foundation-probe`;
  const competingCas = await Promise.all([
    request("human", "POST", foundationPath, {
      action: "cas", probeId: "l0-cas", expectedVersion: 0, payload: { contender: "a" },
    }),
    request("human", "POST", foundationPath, {
      action: "cas", probeId: "l0-cas", expectedVersion: 0, payload: { contender: "b" },
    }),
  ]);
  assert.deepEqual(competingCas.map((result) => result.status).sort(), [200, 409]);
  const casWinner = competingCas.find((result) => result.status === 200)!.body.probe;
  const casConflict = competingCas.find((result) => result.status === 409)!.body.probe;
  assert.equal(casWinner.version, 1);
  assert.deepEqual(casConflict, casWinner);
  evidence.results.migrationAndCompetingCas = "PASS";

  await freshRun("council");
  const ownerRequest = await request("council", "POST", foundationPath, {
    action: "owner-request",
    ownerUserId: userId,
    idempotencyKey: `l0-owner-${qualificationId}`,
    prompt: "Continue the bounded L0 owner-response probe?",
  });
  assert.equal(ownerRequest.status, 201);
  assert.equal(ownerRequest.body.status, "pending");
  assert.equal(ownerRequest.body.addresseeUserId, userId);
  assert.equal(ownerRequest.body.effectiveResolverPolicy, "human_only");
  const pendingOwner = await request("council", "POST", foundationPath, {
    action: "owner-inspect", interactionId: ownerRequest.body.id,
  });
  assert.equal(pendingOwner.status, 200);
  assert.equal(pendingOwner.body.status, "pending");
  assert.equal(pendingOwner.body.resolvedByUserId, null);
  const ownerResponse = await request("human", "POST", foundationPath, {
    action: "owner-respond", interactionId: ownerRequest.body.id, decision: "accept",
  });
  assert.equal(ownerResponse.status, 200);
  assert.equal(ownerResponse.body.applied, true);
  assert.equal(ownerResponse.body.interaction.status, "accepted");
  assert.equal(ownerResponse.body.interaction.resolvedByUserId, userId);
  const resolvedOwner = await request("council", "POST", foundationPath, {
    action: "owner-inspect", interactionId: ownerRequest.body.id,
  });
  assert.equal(resolvedOwner.body.resolvedByUserId, userId);
  evidence.results.ownerWaitAndAttributedResponse = "PASS";

  await checkoutExecutor("in_progress");
  const v1 = await request("executor", "PATCH", `/api/issues/${issueId}`, {
    status: "done",
    comment: "Submission V1: fixture-result-v1",
  });
  assert.equal(v1.status, 200);
  assert.equal(v1.body.status, "in_review");
  assert.equal(v1.body.assigneeAgentId, councilId);
  evidence.results.v1Submission = "PASS";

  await freshRun("council");
  const correction = await request("council", "POST", `/api/plugins/${pluginId}/api/issues/${issueId}/decision`, {
    verdict: "changes_requested",
    justification: "Fixture V1 is missing the corrected V2 marker.",
    resultReference: "fixture://result/v1",
  });
  assert.equal(correction.status, 200);
  assert.equal(correction.body.verdict, "changes_requested");
  assert.equal(correction.body.nativeResponse.status, "in_progress");
  assert.equal(correction.body.nativeResponse.assigneeAgentId, executorId);
  evidence.results.v1Correction = "PASS";

  await checkoutExecutor("in_progress");
  const v2 = await request("executor", "PATCH", `/api/issues/${issueId}`, {
    status: "done",
    comment: "Submission V2 corrected: fixture-result-v2",
  });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.status, "in_review");
  assert.equal(v2.body.assigneeAgentId, councilId);
  evidence.results.v2Submission = "PASS";

  await freshRun("council");
  const approvedCommit = "cfc316625ef4b097126c86d7123a13d00df905b9";
  const baseCommit = "307101af5f3f28e57db52d6ec4a8725e1a7b9544";
  const decisionPath = `/api/plugins/${pluginId}/api/issues/${issueId}/decision`;
  const approvalBody = {
    verdict: "approved",
    approvedCommit,
    justification: "Fixture V2 contains the required corrected marker.",
    resultReference: "fixture://result/v2",
  };
  const refused = await request("council", "POST", decisionPath, approvalBody);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /delivery-manifest/);
  const beforeManifest = await safeSnapshot();
  assert.equal(beforeManifest.issue.status, "in_review");
  assert.deepEqual(beforeManifest.decisions.map((decision: any) => decision.outcome), ["changes_requested"]);
  evidence.results.missingManifestRefusal = "PASS";

  const bundlePath = resolve(runtime, "candidate.bundle");
  const candidateRepository = resolve(runtime, "candidate.git");
  const candidateRef = "refs/heads/candidate";
  const baseRef = "refs/heads/base";
  execFileSync("git", ["clone", "--bare", "--shared", packageRoot, candidateRepository]);
  execFileSync("git", ["update-ref", candidateRef, approvedCommit], { cwd: candidateRepository });
  execFileSync("git", ["update-ref", baseRef, baseCommit], { cwd: candidateRepository });
  assert.equal(execFileSync("git", ["rev-parse", candidateRef], { cwd: candidateRepository, encoding: "utf8" }).trim(), approvedCommit);
  execFileSync("git", ["bundle", "create", bundlePath, candidateRef, baseRef], { cwd: candidateRepository });
  execFileSync("git", ["bundle", "verify", bundlePath], { cwd: candidateRepository });
  const bundleBytes = await readFile(bundlePath);
  const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  const form = new FormData();
  form.append("file", new Blob([bundleBytes], { type: "application/octet-stream" }), "candidate.bundle");
  const uploadResponse = await fetch(`${baseUrl}/api/companies/${companyId}/issues/${issueId}/attachments`, {
    method: "POST", headers: { cookie, origin: baseUrl }, body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, `bundle upload: ${JSON.stringify(uploaded)}`);
  assert.equal(uploaded.sha256, bundleSha256);
  evidence.configuration.fixtureBundle = { attachmentId: uploaded.id, sha256: bundleSha256, source: "git bundle of approved extraction commit" };

  const candidateVerification = await request("human", "POST", foundationPath, {
    action: "candidate",
    attachmentId: uploaded.id,
    expectedSha256: bundleSha256,
    baseCommit,
    candidateCommit: approvedCommit,
  });
  assert.equal(candidateVerification.status, 200);
  assert.equal(candidateVerification.body.sha256, bundleSha256);
  assert.equal(candidateVerification.body.relationship, "base-is-ancestor");
  assert.equal(candidateVerification.body.isolatedInspection, true);
  evidence.results.attachmentBytesAndGitCandidate = "PASS";

  const candidateProduct = await request("human", "POST", `/api/issues/${issueId}/work-products`, {
    type: "commit", provider: "github", title: "Approved extraction candidate",
    status: "ready_for_review",
    metadata: { repo: "ty000/paperclip-council", branch: "codex/extract-council-plugin", sha: approvedCommit, baseCommit },
  });
  assert.equal(candidateProduct.status, 201);
  const deliveryManifest = {
    repository: "https://github.com/ty000/paperclip-council.git",
    branch: "codex/extract-council-plugin", baseCommit, approvedCommit,
    bundleAttachmentId: uploaded.id, bundleSha256,
    deliveryWorkspacePath: "/home/davy-lp/workspace/paperclip-council-delivery",
    assigneeAgentId: executorId,
  };
  const document = await request("human", "PUT", `/api/issues/${issueId}/documents/delivery-manifest`, {
    title: "Delivery manifest", format: "markdown", body: JSON.stringify(deliveryManifest),
    changeSummary: "Prepare exact approved candidate for Council review",
  });
  assert.equal(document.status, 201);
  evidence.results.candidatePreparation = "PASS";

  const acceptance = await request("council", "POST", `/api/plugins/${pluginId}/api/issues/${issueId}/decision`, {
    ...approvalBody,
  });
  assert.equal(acceptance.status, 200);
  assert.equal(acceptance.body.verdict, "approved");
  assert.equal(acceptance.body.nativeResponse.status, "done");
  evidence.results.v2Acceptance = "PASS";

  const issueReadback = await request("human", "GET", `/api/issues/${issueId}`);
  const commentsReadback = await request("human", "GET", `/api/issues/${issueId}/comments`);
  const activityReadback = await request("human", "GET", `/api/issues/${issueId}/activity`);
  assert.equal(issueReadback.status, 200);
  assert.equal(issueReadback.body.status, "done");
  assert.equal(issueReadback.body.executionState.lastDecisionOutcome, "approved");
  assert.equal(commentsReadback.status, 200);
  const comments = commentsReadback.body.map((item: any) => item.body);
  for (const marker of ["Submission V1", "Fixture V1", "Submission V2 corrected", "Fixture V2", `Approved commit: ${approvedCommit}`]) {
    assert(comments.some((body: string) => body.includes(marker)), `missing persisted marker: ${marker}`);
  }
  const snapshot = await safeSnapshot();
  assert.deepEqual(snapshot.decisions.map((decision: any) => decision.outcome), ["changes_requested", "approved"]);
  assert(snapshot.decisions.every((decision: any) => decision.actorAgentId === councilId));
  assert(snapshot.decisions.every((decision: any) => typeof decision.createdByRunId === "string"));
  assert.equal(activityReadback.status, 200);
  evidence.results.nativeReadback = "PASS";
  evidence.readback = {
    issue: issueReadback.body,
    comments: commentsReadback.body,
    activity: activityReadback.body,
    decisions: snapshot.decisions,
  };
  evidence.lifecycle = {
    replacementAndRevocation: "documented-only",
    reason: "the required package journey used native ephemeral keys; durable key mutation was not requested",
  };
  evidence.outcome = "SPRINT 1 CONFIGURATION INCREMENT VALIDATED";
} catch (error) {
  evidence.outcome = "NON-CONCLUSIVE OR BLOCKED";
  evidence.error = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : String(error);
  process.exitCode = 1;
} finally {
  try {
    await closeApp();
    evidence.appCleanup = "stopped only the plugin worker, listener, and application created by this run";
  } catch (error) {
    evidence.cleanupError = String(error);
    process.exitCode = 1;
  }
  try {
    await database?.cleanup();
    await rm(runtime, { recursive: true, force: true });
    evidence.databaseCleanup = "fresh isolated PostgreSQL cluster and temporary instance removed";
  } catch (error) {
    evidence.databaseCleanupError = String(error);
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  const serializedEvidence = JSON.stringify(evidence);
  for (const credential of agentTokens.values()) {
    assert(!serializedEvidence.includes(credential.token), "evidence must not contain an agent token");
  }
  await save();
  console.log(JSON.stringify({
    outcome: evidence.outcome,
    evidence: evidencePath,
    results: evidence.results,
    error: evidence.error?.message,
  }));
}
