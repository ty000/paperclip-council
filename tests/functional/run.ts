import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareCandidatePackage } from "./candidate-package.js";
import { nativeRunEvidence, runLiveN1 } from "./n1-live.js";
import { runLiveN2 } from "./n2-live.js";
import { prepareN2Prerequisite } from "./n2-prerequisite.js";
import { runN2NativeLifecycle } from "./n2-native-lifecycle.js";
import { runOrdinaryCampaignPreparation } from "./ordinary-campaign.js";
import { prepareOrdinaryWorkspace } from "./ordinary-campaign-workspace.js";
// @ts-expect-error Qualification contracts are plain ESM.
import { ordinaryCampaignProfile as validateOrdinaryCampaignProfile } from "../../scripts/qualification/ordinary-campaign-contract.mjs";
import { runN45Preparation } from "./n45-campaign.js";
// @ts-expect-error Qualification contracts are plain ESM.
import { n45Profile as validateN45Profile } from "../../scripts/qualification/n45-contract.mjs";
import { runSyntheticN2 } from "./n2-synthetic.js";
import { createFunctionalRuntimeCleanup } from "./runtime-cleanup.js";
import { runDeliveryCoordinationBrowser } from "./delivery-coordination-browser.js";
// @ts-expect-error The qualification evidence contract is intentionally plain ESM.
import { writeClaimedArtifact } from "../../scripts/qualification/evidence-contract.mjs";

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
const ordinaryCampaignProfile = process.env.COUNCIL_ORDINARY_CAMPAIGN_PROFILE ? validateOrdinaryCampaignProfile(JSON.parse(process.env.COUNCIL_ORDINARY_CAMPAIGN_PROFILE), JSON.parse(process.env.COUNCIL_ORDINARY_CAMPAIGN_PROFILE).mode, candidateCommit) : null;
const n45Profile = process.env.COUNCIL_N45_PROFILE ? validateN45Profile(JSON.parse(process.env.COUNCIL_N45_PROFILE), "prepare", candidateCommit) : null;
const liveN1Authorized = process.env.COUNCIL_N1_LIVE_AUTHORIZED === "1";
const liveN2Authorized = process.env.COUNCIL_N2_LIVE_AUTHORIZED === "1";
const isolatedLiveN2Authorized = process.env.COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED === "1";
const n2NativeLifecycleMode = process.env.COUNCIL_N2_NATIVE_LIFECYCLE === "1";
const n2PrerequisiteMode = process.env.COUNCIL_N2_PREREQUISITE === "1";
assert([liveN1Authorized, liveN2Authorized, isolatedLiveN2Authorized].filter(Boolean).length <= 1,
  "Only one native campaign can be authorized at a time");
assert(!(n2PrerequisiteMode && (liveN1Authorized || liveN2Authorized || isolatedLiveN2Authorized)),
  "The provider-free N2 prerequisite cannot run inside a LIVE campaign");
assert(!(n2NativeLifecycleMode && (n2PrerequisiteMode || liveN1Authorized || liveN2Authorized || isolatedLiveN2Authorized)), "Native deterministic qualification excludes every LIVE mode");
assert(!(n45Profile && (n2NativeLifecycleMode || n2PrerequisiteMode || liveN1Authorized || liveN2Authorized || isolatedLiveN2Authorized)), "N45 preparation excludes every execution mode");
assert(!(ordinaryCampaignProfile && (n45Profile || n2NativeLifecycleMode || n2PrerequisiteMode || liveN1Authorized || liveN2Authorized || isolatedLiveN2Authorized)), "Ordinary preparation excludes execution modes");
const liveNativeAuthorized = liveN1Authorized || liveN2Authorized || isolatedLiveN2Authorized;
const liveN2Campaign = liveN2Authorized || isolatedLiveN2Authorized;
const liveEnvironmentPrefix = isolatedLiveN2Authorized
  ? "COUNCIL_N2_ISOLATED_LIVE"
  : liveN2Authorized ? "COUNCIL_N2_LIVE" : "COUNCIL_N1_LIVE";
type ArtifactIdentity = { dev: string; ino: string };
function claimedArtifactIdentity(name: string): ArtifactIdentity {
  const serialized = process.env[name];
  if (!serialized) throw new Error(`${name} is required for the explicitly authorized native live run`);
  try {
    return JSON.parse(serialized) as ArtifactIdentity;
  } catch {
    throw new Error(`${name} must contain the serialized create-only claim identity`);
  }
}
const liveEvidenceIdentity = liveNativeAuthorized
  ? claimedArtifactIdentity(`${liveEnvironmentPrefix}_EVIDENCE_IDENTITY`) : undefined;
const liveScreenshotIdentity = liveNativeAuthorized
  ? claimedArtifactIdentity(`${liveEnvironmentPrefix}_SCREENSHOT_IDENTITY`) : undefined;
const hostRootInput = process.env.PAPERCLIP_TEST_HOST_ROOT;
if (!hostRootInput) {
  throw new Error("PAPERCLIP_TEST_HOST_ROOT must point to the Paperclip checkout under test");
}
const root = resolve(hostRootInput);
const expectedHostCommit = n2NativeLifecycleMode
  ? process.env.COUNCIL_N2_NATIVE_HOST_COMMIT
  : "61b3fd57a695614dc4a37e2303f426a34a9795cf";
assert(expectedHostCommit && /^[a-f0-9]{40}$/.test(expectedHostCommit), "Explicit exact native lifecycle host SHA is required");
const hostCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(hostCommit, expectedHostCommit, `functional host must be Paperclip ${expectedHostCommit}`);
const hostStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
  cwd: root,
  encoding: "utf8",
}).trim();
assert.equal(hostStatus, "", "functional host tracked files must match the exact host commit");
const hostImport = (path: string) => import(pathToFileURL(resolve(root, path)).href);
const qualificationId = randomUUID();
const suppliedRuntime = process.env.PAPERCLIP_QUALIFICATION_RUNTIME;
const runtime = suppliedRuntime
  ? resolve(suppliedRuntime)
  : await mkdtemp(resolve(tmpdir(), "paperclip-council-package-"));
assert.equal(dirname(runtime), resolve(tmpdir()), "qualification runtime must be directly under the system temp root");
assert(basename(runtime).startsWith("paperclip-council-package-"), "qualification runtime must use the owned prefix");
const runtimeCleanup = createFunctionalRuntimeCleanup({ runtime, parentOwned: Boolean(suppliedRuntime) });
let runtimeCleanupHandled = false;
let ordinaryPreparationSucceeded = false;
try {
const preparedCandidate = await prepareCandidatePackage(packageRoot, candidateCommit, runtime);
const ordinaryWorkspaceProof = ordinaryCampaignProfile ? await prepareOrdinaryWorkspace(preparedCandidate.packageRoot, packageRoot, ordinaryCampaignProfile) : undefined;
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
const { eq, inArray, sql } = requireServer("drizzle-orm");
const evidence: Record<string, any> = {
  schemaVersion: 1,
  proofId: ordinaryCampaignProfile ? "paperclip-council-ordinary-campaign-preparation-v1" : n45Profile ? "paperclip-council-n45-provider-free-preparation-v1" : n2NativeLifecycleMode ? `paperclip-council-${process.env.COUNCIL_N5_CONTINUATION === "1" ? "n5-continuation" : process.env.COUNCIL_N5_NATIVE_LIFECYCLE === "1" ? "n5" : process.env.COUNCIL_N3_NATIVE_LIFECYCLE === "1" ? "n3" : "n2"}-native-deterministic-lifecycle-v1` : n2PrerequisiteMode
    ? "paperclip-council-n2-native-stage-prerequisite-v1"
    : isolatedLiveN2Authorized
    ? "paperclip-council-n2-isolated-observable-native-qualification-v1"
    : liveN2Authorized
    ? "paperclip-council-n2-observable-native-qualification-v1"
    : liveN1Authorized
    ? "paperclip-council-n1-observable-native-qualification-v1"
    : "paperclip-council-n2-synthetic-integration-v1",
  startedAt: new Date().toISOString(),
  head: hostCommit,
  hostTrackedFilesClean: hostStatus === "",
  branch: execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version,
  command: ordinaryCampaignProfile ? "node scripts/qualification/run-ordinary-campaign.mjs prepare|session <exact-profile.json>" : n45Profile ? "node scripts/qualification/run-n45-campaign.mjs prepare <exact-profile.json>" : n2NativeLifecycleMode
    ? `${process.env.COUNCIL_N5_CONTINUATION === "1" ? "COUNCIL_N5_CONTINUATION=1 COUNCIL_N5_NATIVE_LIFECYCLE=1 " : process.env.COUNCIL_N5_NATIVE_LIFECYCLE === "1" ? "COUNCIL_N5_NATIVE_LIFECYCLE=1 " : ""}${process.env.COUNCIL_N3_NATIVE_LIFECYCLE === "1" ? "COUNCIL_N3_NATIVE_LIFECYCLE=1 " : ""}PAPERCLIP_TEST_HOST_ROOT=<clean-host> COUNCIL_N2_NATIVE_HOST_COMMIT=<exact-host-sha> pnpm qualification:native:n2`
    : liveN2Authorized
    ? "COUNCIL_N2_LIVE_AUTHORIZED=1 COUNCIL_N2_LIVE_MODEL=gpt-5.6-sol COUNCIL_N2_LIVE_EFFORT=high COUNCIL_N2_LIVE_RUN_UNITS=<positive> COUNCIL_N2_LIVE_PERIOD_UNITS=<exactly-6x-run> pnpm qualification:live:n2"
    : isolatedLiveN2Authorized
    ? "COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED=1 COUNCIL_N2_ISOLATED_LIVE_CANDIDATE_SHA=<exact-head> COUNCIL_N2_ISOLATED_LIVE_MODEL=gpt-5.6-sol COUNCIL_N2_ISOLATED_LIVE_EFFORT=high COUNCIL_N2_ISOLATED_LIVE_RUN_UNITS=<positive> COUNCIL_N2_ISOLATED_LIVE_PERIOD_UNITS=<exactly-3x-run> pnpm qualification:live:n2:isolated"
    : liveN1Authorized
    ? "COUNCIL_N1_LIVE_AUTHORIZED=1 COUNCIL_N1_LIVE_MODEL=gpt-5.6-sol COUNCIL_N1_LIVE_EFFORT=high COUNCIL_N1_LIVE_RUN_UNITS=<positive> COUNCIL_N1_LIVE_PERIOD_UNITS=<at-least-3x-run> pnpm qualification:live:n1"
    : n2PrerequisiteMode
    ? "pnpm qualification:preflight:n2"
    : "COUNCIL_PACKAGE_EXPECTED_COMMIT=<candidate-sha> PAPERCLIP_TEST_HOST_ROOT=<checkout> PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH=<chromium> pnpm test:functional",
  candidate: {
    commit: candidateCommit,
    branch: candidateBranch,
    clean: candidateStatus === "",
    source: "git archive of the exact candidate commit, built in an isolated temporary directory",
    sourceArchiveSha256: preparedCandidate.sourceArchiveSha256,
    distSha256: preparedCandidate.distSha256,
  },
  configuration: {
    environmentClass: "local-sandbox",
    database: "fresh embedded PostgreSQL test cluster",
    runtimeMode: "ephemeral authenticated/private qualification instance",
    models: "none",
    fixtureBoundary: "agents, issues, policies, and heartbeat runs are synthetic test preparation",
    credentials: "agent keys created by native board API; council token transferred directly to local_encrypted secret",
  },
  steps: [],
  results: {},
  outcome: "RUNNING",
};
const save = async () => {
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (liveEvidenceIdentity) {
    writeClaimedArtifact(evidencePath, liveEvidenceIdentity, serialized, "evidence");
    return;
  }
  await writeFile(evidencePath, serialized);
};
await save();

let database: any;
let db: any;
let app: any;
let server: Server | undefined;
let workerManager: any;
let publishPluginDomainEvent: ((event: Record<string, unknown>) => void) | undefined;
let baseUrl = "";
let cookie = "";
let intruderCookie = "";
let tables: any;
let issueId: string | undefined;
let missionRootIssueId: string | undefined;
const companyId = randomUUID();
const projectId = randomUUID();
const executorId = randomUUID();
const contributorAId = randomUUID();
const contributorBId = randomUUID();
const councilId = randomUUID();
const foreignCompanyId = randomUUID();
const agentTokens = new Map<string, {
  token: string;
  keyId: string;
  runId: string;
  agentId: string;
  companyId?: string;
}>();

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

async function freshRun(actor: string, contextIssueId: string | undefined = issueId) {
  const current = agentTokens.get(actor)!;
  const runId = randomUUID();
  await db.insert(tables.heartbeatRuns).values({
    id: runId,
    companyId,
    agentId: current.agentId,
    status: "running",
    responsibleUserId: evidence.configuration.humanUserId,
    contextSnapshot: { issueId: contextIssueId, fixture: "deterministic council package qualification" },
  });
  agentTokens.set(actor, { ...current, runId });
  return runId;
}

async function createN2PrerequisiteFixtureRun(
  actor: string,
  contextIssueId: string,
  fixtureSource: "fixture:n2-prerequisite:deterministic-heartbeat" | "fixture:n2-handoff-guard:deterministic-reviewer"
    = "fixture:n2-prerequisite:deterministic-heartbeat",
) {
  const current = agentTokens.get(actor);
  assert(current, `unknown N2 prerequisite actor ${actor}`);
  assert(current.companyId, `N2 prerequisite actor ${actor} has no company identity`);
  const runId = randomUUID();
  await db.insert(tables.heartbeatRuns).values({
    id: runId,
    companyId: current.companyId,
    agentId: current.agentId,
    invocationSource: "on_demand",
    triggerDetail: fixtureSource,
    status: "running",
    responsibleUserId: evidence.configuration.humanUserId,
    contextSnapshot: {
      issueId: contextIssueId,
      fixture: fixtureSource,
      providerInvocation: "none",
    },
    startedAt: new Date(),
  });
  agentTokens.set(actor, { ...current, runId });
  return runId;
}

async function finishN2PrerequisiteFixtureRuns(runs: ReadonlyArray<{
  actor: string;
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
}>) {
  assert(runs.length > 0, "N2 prerequisite fixture cleanup requires at least one owned run");
  const completedAt = new Date();
  for (const fixture of runs) {
    const [beforeRun] = await db.select({
      status: tables.heartbeatRuns.status,
      wakeupRequestId: tables.heartbeatRuns.wakeupRequestId,
      processStartedAt: tables.heartbeatRuns.processStartedAt,
    }).from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, fixture.runId));
    assert.deepEqual(beforeRun, {
      status: "running",
      wakeupRequestId: null,
      processStartedAt: null,
    }, `fixture ${fixture.runId} must remain unexecuted until its last use`);
    const [beforeIssue] = await db.select({
      checkoutRunId: tables.issues.checkoutRunId,
      executionRunId: tables.issues.executionRunId,
    }).from(tables.issues).where(eq(tables.issues.id, fixture.issueId));
    assert(beforeIssue, `fixture issue ${fixture.issueId} must exist`);
    assert(beforeIssue.checkoutRunId === null || beforeIssue.checkoutRunId === fixture.runId,
      `fixture issue ${fixture.issueId} checkout belongs to another run`);
    assert(beforeIssue.executionRunId === null || beforeIssue.executionRunId === fixture.runId,
      `fixture issue ${fixture.issueId} execution belongs to another run`);

    await db.update(tables.heartbeatRuns).set({
      status: "succeeded",
      finishedAt: completedAt,
      error: null,
      exitCode: 0,
      usageJson: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    }).where(eq(tables.heartbeatRuns.id, fixture.runId));
    await db.update(tables.issues).set({
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: completedAt,
    }).where(eq(tables.issues.id, fixture.issueId));
    const current = agentTokens.get(fixture.actor);
    if (current?.runId === fixture.runId) agentTokens.set(fixture.actor, { ...current, runId: "" });
  }

  const runIds = runs.map((fixture) => fixture.runId);
  const issueIds = runs.map((fixture) => fixture.issueId);
  const terminalRuns = await db.select({
    id: tables.heartbeatRuns.id,
    companyId: tables.heartbeatRuns.companyId,
    agentId: tables.heartbeatRuns.agentId,
    status: tables.heartbeatRuns.status,
    finishedAt: tables.heartbeatRuns.finishedAt,
    wakeupRequestId: tables.heartbeatRuns.wakeupRequestId,
    processStartedAt: tables.heartbeatRuns.processStartedAt,
  }).from(tables.heartbeatRuns).where(inArray(tables.heartbeatRuns.id, runIds));
  const issueLocks = await db.select({
    id: tables.issues.id,
    status: tables.issues.status,
    assigneeAgentId: tables.issues.assigneeAgentId,
    checkoutRunId: tables.issues.checkoutRunId,
    executionRunId: tables.issues.executionRunId,
  }).from(tables.issues).where(inArray(tables.issues.id, issueIds));
  const activeRunCount = terminalRuns.filter((run: any) => ["running", "queued", "scheduled_retry"].includes(run.status)).length;
  const openCheckoutCount = issueLocks.filter((issue: any) => issue.checkoutRunId !== null).length;
  const openExecutionCount = issueLocks.filter((issue: any) => issue.executionRunId !== null).length;
  assert.equal(terminalRuns.length, runs.length);
  assert(terminalRuns.every((run: any) => run.status === "succeeded" && run.finishedAt
    && run.wakeupRequestId === null && run.processStartedAt === null));
  return { terminalRuns, issueLocks, activeRunCount, openCheckoutCount, openExecutionCount };
}

async function completeSyntheticRun(runId: string, targetIssueId: string, agentId: string, usageUnits: number) {
  const completedAt = new Date();
  await db.update(tables.heartbeatRuns).set({
    status: "succeeded",
    startedAt: completedAt,
    finishedAt: completedAt,
    error: null,
    exitCode: 0,
    usageJson: { inputTokens: usageUnits, cachedInputTokens: 0, outputTokens: 0 },
  }).where(eq(tables.heartbeatRuns.id, runId));
  const [completed] = await db.select({
    id: tables.heartbeatRuns.id,
    status: tables.heartbeatRuns.status,
    finishedAt: tables.heartbeatRuns.finishedAt,
  }).from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId));
  assert.equal(completed?.status, "succeeded", `deterministic run ${runId} must be terminal`);
  assert(completed?.finishedAt, `deterministic run ${runId} needs a terminal timestamp`);
  if (usageUnits > 0) {
    await db.insert(tables.costEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      issueId: targetIssueId,
      projectId,
      heartbeatRunId: runId,
      provider: "synthetic-provider-free",
      biller: "test-fixture",
      billingType: "test",
      costStatus: "reported",
      model: "deterministic-executor",
      inputTokens: usageUnits,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      occurredAt: completedAt,
    });
  }
  assert(publishPluginDomainEvent, "synthetic SDK event seam is unavailable");
  publishPluginDomainEvent({
    eventId: randomUUID(),
    eventType: "agent.run.finished",
    occurredAt: completedAt.toISOString(),
    actorId: agentId,
    actorType: "agent",
    entityId: runId,
    entityType: "heartbeat_run",
    companyId,
    payload: {
      runId,
      agentId,
      issueId: targetIssueId,
      status: "succeeded",
      invocationSource: "synthetic_provider_free_fixture",
      triggerDetail: "fixture:n2-finished-event",
      error: null,
      errorCode: null,
      startedAt: completedAt.toISOString(),
      finishedAt: completedAt.toISOString(),
    },
  });
}

async function seedSyntheticMission(syntheticMissionId: string, aggregate: Record<string, unknown>) {
  await db.execute(sql`
    UPDATE ${sql.raw("plugin_private_paperclip_council_270061461e.missions")}
    SET aggregate = ${JSON.stringify(aggregate)}::jsonb, updated_at = now()
    WHERE company_id = ${companyId}::uuid AND mission_id = ${syntheticMissionId}::uuid
  `);
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

async function checkoutAgent(actor: string, targetIssueId: string, expectedStatus: string) {
  await freshRun(actor, targetIssueId);
  const principal = agentTokens.get(actor)!;
  const result = await request(actor, "POST", `/api/issues/${targetIssueId}/checkout`, {
    agentId: principal.agentId,
    expectedStatuses: [expectedStatus],
  });
  assert.equal(result.status, 200, `${actor} checkout must succeed`);
  return principal;
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
  ({ publishPluginDomainEvent } = await hostImport("server/src/services/activity-log.ts"));
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
  process.env.PAPERCLIP_API_URL = baseUrl;
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
    ...(n45Profile || ordinaryCampaignProfile ? {} : { decisionServiceOptions: { wakeOriginAgent: async () => undefined } }),
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
  for (const [actor, id, role] of [
    ["executor", executorId, "engineer"],
    ["contributor-a", contributorAId, "engineer"],
    ["contributor-b", contributorBId, "engineer"],
    ["council", councilId, "reviewer"],
  ] as const) {
    await db.insert(tables.agents).values({
      id,
      companyId,
      name: actor,
      role,
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
  evidence.configuration.contributorAgentIds = [contributorAId, contributorBId];
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
  if (!ordinaryCampaignProfile) {
  const configured = await request("human", "POST", `/api/plugins/${pluginId}/config`, {
    companyId,
    configJson: {
      apiBaseUrl: baseUrl,
      councilAgentId: councilId,
      councilApiKey: { type: "secret_ref", secretId: secret.body.id },
      n1FixtureMode: "ephemeral-local-sandbox",
    },
  });
  assert.equal(configured.status, 200);
  }

  await closeApp();
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts("vite-dev"));
  server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(address.port, "127.0.0.1", resolveListen);
  });
  await app.locals.bundledPluginsStartup;
  if (!ordinaryCampaignProfile) assert(workerManager.isRunning(pluginId), "installed package worker must load after restart");
  evidence.results.installation = "PASS";

  if (ordinaryCampaignProfile) {
    await runOrdinaryCampaignPreparation({ request, pluginId, baseUrl, cookie, runtime, ownerUserId: userId, ownerPassword: password, packageRoot, missionWorkspace: preparedCandidate.packageRoot, workspaceProof: ordinaryWorkspaceProof, hostImport, evidence, save, db, tables, eq }, ordinaryCampaignProfile);
  } else if (n45Profile) {
    await runN45Preparation({ request, pluginId, baseUrl, cookie, runtime, ownerUserId: userId, packageRoot, hostImport, evidence, save, db, tables, eq }, n45Profile);
  } else if (n2NativeLifecycleMode) {
    await runN2NativeLifecycle({ request, pluginId, baseUrl, cookie, runtime, ownerUserId: userId,
      hostImport, evidence, save, agentTokens, db, tables, eq,
      createFixtureRun: createN2PrerequisiteFixtureRun, finishFixtureRuns: finishN2PrerequisiteFixtureRuns });
  } else if (n2PrerequisiteMode) {
    const prerequisite = await prepareN2Prerequisite({
      request,
      pluginId,
      baseUrl,
      cookie,
      runtime,
      ownerUserId: userId,
      registerActor: (actor, identity) => {
        agentTokens.set(actor, { ...identity, runId: "", agentId: identity.id });
      },
      createFixtureRun: createN2PrerequisiteFixtureRun,
      finishFixtureRuns: finishN2PrerequisiteFixtureRuns,
      liveN2Profile: {
        model: "gpt-5.6-sol",
        effort: "high",
        runReservationUnits: 2_000_000,
        periodAllowanceUnits: 6_000_000,
      },
      exerciseProviderFreeHandoff: true,
    });
    assert(prerequisite.handoffGuard, "provider-free N2 handoff guard must stop after the public boundary");
    evidence.configuration.fixtureBoundary = "The prerequisite seam terminalizes three N1 heartbeat fixtures before the same mission and candidate enter a distinct native N2 period; one separately labelled reviewer fixture then exercises inspect and confirm-review-handoff without provider, wakeup, or process execution";
    evidence.configuration.models = "gpt-5.6-sol/high configured on disabled agents; no provider invocation";
    evidence.n2Prerequisite = {
      proofClass: "N2 native-stage prerequisite validated",
      ...prerequisite,
      providerBoundary: {
        providerInvocationCount: 0,
        nativeAgentExecutionCount: 0,
        prerequisiteFixtureHeartbeatRowCount: prerequisite.fixtureHeartbeatRuns.length,
        wakeupCount: 0,
        reviewerRunCount: prerequisite.runReadbacks.find(
          (entry: { agentId: string }) => entry.agentId === prerequisite.agents.reviewer.id,
        )?.runCount ?? -1,
        evidence: "the pre-handoff readback attributes one terminal, unexecuted fixture row to lead, Alpha, and Beta while reviewer history is empty; the handoff guard reports its later reviewer fixture separately",
      },
      databaseBoundary: "the seam terminalizes exactly three N1 heartbeat fixtures and one separately labelled reviewer handoff fixture; public plugin and agent commands retain one native reservation without claiming provider usage or settlement",
    };
    Object.assign(evidence.results, {
      n2PrerequisitePublicMission: "PASS",
      n2PrerequisiteDistinctContributions: "PASS",
      n2PrerequisiteVerifiedCandidate: "PASS",
      n2PrerequisiteN1ReservationsSettled: "PASS",
      n2PrerequisiteFixtureZeroExposure: "PASS",
      n2PrerequisiteZeroProviderOrNativeRuns: "PASS",
      n2PrerequisiteStopsBeforeReviewer: "PASS",
      n2PrerequisiteFixtureLifecycleFinished: "PASS",
      n2PrerequisiteHandoffCommandsConsumable: "PASS",
    });
    evidence.outcome = "N2 native-stage prerequisite validated";
  } else {

  const migrationNames = [
    "001_foundation_probe.sql", "002_revisioned_rosters.sql", "003_missions.sql",
    "004_decision_receipts.sql", "005_admission.sql",
  ];
  const installedMigrations = await db.select({
    migrationKey: tables.pluginMigrations.migrationKey,
    checksum: tables.pluginMigrations.checksum,
    status: tables.pluginMigrations.status,
    pluginVersion: tables.pluginMigrations.pluginVersion,
  }).from(tables.pluginMigrations).where(eq(tables.pluginMigrations.pluginId, pluginId));
  assert.deepEqual(installedMigrations.map((item: any) => item.migrationKey).sort(), migrationNames);
  for (const migration of installedMigrations) {
    const source = await readFile(resolve(packageRoot, "migrations", migration.migrationKey), "utf8");
    assert.equal(migration.checksum, createHash("sha256").update(source).digest("hex"));
    assert.equal(migration.status, "applied");
    assert.equal(migration.pluginVersion, JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")).version);
  }
  evidence.migrations = installedMigrations.map((item: any) => ({
    key: item.migrationKey, checksum: item.checksum, status: item.status, pluginVersion: item.pluginVersion,
  })).sort((left: any, right: any) => left.key.localeCompare(right.key));
  evidence.results.migrationRegistryAndChecksums = "PASS";

  const rosterBase = `/api/plugins/${pluginId}/api/companies/${companyId}/rosters`;
  const teamDraft = {
    kind: "team",
    name: "Delivery team",
    projectId,
    members: [
      { agentId: executorId, responsibilities: ["integration_lead"] },
      { agentId: contributorAId, responsibilities: ["contributor"] },
      { agentId: contributorBId, responsibilities: ["contributor"] },
    ],
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
  const asymmetricStaleActivation = await request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId,
    teamExpectedVersion: 1,
    councilRosterId,
    councilExpectedVersion: 999,
  });
  assert.equal(asymmetricStaleActivation.status, 409);
  const teamAfterStaleActivation = await request("human", "GET", `${rosterBase}/${teamRosterId}?companyId=${companyId}`);
  const councilAfterStaleActivation = await request("human", "GET", `${rosterBase}/${councilRosterId}?companyId=${companyId}`);
  assert.deepEqual(
    [teamAfterStaleActivation.body.roster.head.lifecycle, teamAfterStaleActivation.body.roster.head.version],
    ["draft", 1],
  );
  assert.deepEqual(
    [councilAfterStaleActivation.body.roster.head.lifecycle, councilAfterStaleActivation.body.roster.head.version],
    ["draft", 1],
  );
  evidence.results.atomicPairActivationNoPartialMutation = "PASS";
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

  const missionRoot = await request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "Council L2 mission persistence fixture",
    description: "Synthetic persisted mission only; dispatch is intentionally disabled while G4 remains open.",
    projectId,
    status: "backlog",
    assigneeAgentId: executorId,
  });
  assert.equal(missionRoot.status, 201);
  missionRootIssueId = missionRoot.body.id;
  const missionId = randomUUID();
  const createCommandId = randomUUID();
  const missionBase = `/api/plugins/${pluginId}/api/companies/${companyId}/missions`;
  const initialMandate = {
    objective: "Persist exact roster revisions without dispatch",
    acceptanceCriteria: ["Pinned revisions survive roster changes and plugin restart"],
    commitments: ["Do not dispatch while G4 remains open"],
    limits: {
      taskPolicy: "No provider calls in this bounded fixture",
      periodPolicy: "No provider calls in this bounded fixture period",
      correctionLimit: 2,
      elapsedMinutes: 60,
    },
  };
  const missionCreateBody = {
    companyId,
    command: "create",
    commandId: createCommandId,
    missionId,
    rootIssueId: missionRootIssueId,
    projectId,
    teamRosterId,
    teamRevision: activation.body.team.revision.revision,
    councilRosterId,
    councilRevision: activation.body.council.revision.revision,
    mandate: initialMandate,
  };
  const unauthorizedMission = await request("intruder", "POST", missionBase, missionCreateBody);
  assert.equal(unauthorizedMission.status, 403);
  assert.equal(unauthorizedMission.body.code, "owner_required");
  for (const missingRosterField of ["teamRosterId", "councilRosterId"]) {
    const missingRosterMissionId = randomUUID();
    const missingRoster = await request("human", "POST", missionBase, {
      ...missionCreateBody,
      missionId: missingRosterMissionId,
      [missingRosterField]: randomUUID(),
    });
    assert.equal(missingRoster.status, 404);
    assert.equal(missingRoster.body.code, "roster_not_found");
    const absentMission = await request("human", "GET", `${missionBase}/${missingRosterMissionId}?companyId=${companyId}`);
    assert.equal(absentMission.status, 404);
    assert.equal(absentMission.body.code, "mission_not_found");
  }
  evidence.results.missingRosterStructuredRefusal = "PASS";
  const missionCreate = await request("human", "POST", missionBase, missionCreateBody);
  assert.equal(missionCreate.status, 201);
  assert.equal(missionCreate.body.outcome, "applied");
  assert.equal(missionCreate.body.mission.version, 1);
  assert.equal(missionCreate.body.inspection.state.recorded, true);
  assert.equal(missionCreate.body.inspection.state.compositionsPinned, true);
  assert.equal(missionCreate.body.inspection.state.executable, false);
  assert(missionCreate.body.inspection.prerequisites.some(
    (item: any) => item.code === "runtime_budget_exposure" && item.status === "unsupported",
  ));
  const unauthorizedMissionList = await request("intruder", "GET", `${missionBase}?companyId=${companyId}`);
  assert.equal(unauthorizedMissionList.status, 403);
  assert.equal(unauthorizedMissionList.body.code, "owner_required");
  const unauthorizedMissionRead = await request("intruder", "GET", `${missionBase}/${missionId}?companyId=${companyId}`);
  assert.equal(unauthorizedMissionRead.status, 403);
  assert.equal(unauthorizedMissionRead.body.code, "owner_required");
  const ownerMissionList = await request("human", "GET", `${missionBase}?companyId=${companyId}`);
  assert.equal(ownerMissionList.status, 200);
  assert.equal(ownerMissionList.body.missions.length, 1);
  const missionReplay = await request("human", "POST", missionBase, missionCreateBody);
  assert.equal(missionReplay.status, 200);
  assert.equal(missionReplay.body.outcome, "replayed");
  assert.equal(missionReplay.body.mission.version, 1);
  const identityConflict = await request("human", "POST", missionBase, {
    ...missionCreateBody,
    mandate: { ...initialMandate, objective: "Conflicting retry payload" },
  });
  assert.equal(identityConflict.status, 409);
  assert.equal(identityConflict.body.code, "command_identity_conflict");
  evidence.results.missionOwnerIdentityReadScopeAndIdempotentCreate = "PASS";

  const missionCommandPath = `${missionBase}/${missionId}/commands`;
  const competingMandates = await Promise.all([
    request("human", "POST", missionCommandPath, {
      companyId,
      command: "update-mandate",
      commandId: randomUUID(),
      expectedVersion: 1,
      mandate: { ...initialMandate, objective: "Concurrent mandate A" },
    }),
    request("human", "POST", missionCommandPath, {
      companyId,
      command: "update-mandate",
      commandId: randomUUID(),
      expectedVersion: 1,
      mandate: { ...initialMandate, objective: "Concurrent mandate B" },
    }),
  ]);
  assert.deepEqual(competingMandates.map((result) => result.status).sort(), [200, 409]);
  const winningMandate = competingMandates.find((result) => result.status === 200)!.body;
  assert.equal(winningMandate.outcome, "applied");
  assert.equal(winningMandate.mission.version, 2);
  evidence.results.missionCommandCasNoLostUpdate = "PASS";

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
  const replayAfterRevision = await request("human", "POST", missionBase, missionCreateBody);
  assert.equal(replayAfterRevision.status, 200);
  assert.equal(replayAfterRevision.body.outcome, "replayed");
  assert.deepEqual(replayAfterRevision.body.receipt, missionCreate.body.receipt);
  assert.deepEqual(replayAfterRevision.body.mission, winningMandate.mission);
  evidence.results.missionCreateReplayAfterRosterRevision = "PASS";

  const reactivate = await request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId,
    teamExpectedVersion: winningRevision.head.version,
    councilRosterId,
    councilExpectedVersion: activation.body.council.head.version,
  });
  assert.equal(reactivate.status, 200);
  let currentPair = reactivate.body;
  const missionLifecycleRaceOutcomes: number[] = [];
  for (let raceIndex = 0; raceIndex < 3; raceIndex += 1) {
    const raceRoot = await request("human", "POST", `/api/companies/${companyId}/issues`, {
      title: `Mission lifecycle race fixture ${raceIndex + 1}`,
      description: "Synthetic create-versus-suspend race; no dispatch.",
      projectId,
      status: "backlog",
      assigneeAgentId: executorId,
    });
    assert.equal(raceRoot.status, 201);
    const [raceCreate, raceSuspend] = await Promise.all([
      request("human", "POST", missionBase, {
        ...missionCreateBody,
        commandId: randomUUID(),
        missionId: randomUUID(),
        rootIssueId: raceRoot.body.id,
        teamRevision: winningRevision.revision.revision,
      }),
      request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
        companyId,
        command: "suspend",
        expectedVersion: currentPair.team.head.version,
      }),
    ]);
    assert.equal(raceSuspend.status, 200);
    assert([201, 409, 422].includes(raceCreate.status), `unexpected race create status ${raceCreate.status}`);
    if (raceCreate.status === 201) {
      assert.equal(raceCreate.body.mission.teamRevision, winningRevision.revision.revision);
    } else {
      assert([
        "roster_selection_changed",
        "roster_pair_ineligible",
        "active_rosters_required",
      ].includes(raceCreate.body.code));
    }
    missionLifecycleRaceOutcomes.push(raceCreate.status);
    const raceReactivate = await request("human", "POST", rosterBase, {
      companyId,
      command: "activate-pair",
      teamRosterId,
      teamExpectedVersion: raceSuspend.body.head.version,
      councilRosterId,
      councilExpectedVersion: currentPair.council.head.version,
    });
    assert.equal(raceReactivate.status, 200);
    currentPair = raceReactivate.body;
  }
  evidence.results.missionCreationVsLifecycleRace = "PASS";
  evidence.missionLifecycleRace = {
    attempts: missionLifecycleRaceOutcomes.length,
    createStatuses: missionLifecycleRaceOutcomes,
    invariant: "create serialized before suspension or refused after selection changed",
  };
  const orderedRoot = await request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "Mission create-before-suspend fixture",
    description: "Deterministic public API ordering; no dispatch.",
    projectId,
    status: "backlog",
    assigneeAgentId: executorId,
  });
  assert.equal(orderedRoot.status, 201);
  const orderedCreateBody = {
    ...missionCreateBody,
    commandId: randomUUID(),
    missionId: randomUUID(),
    rootIssueId: orderedRoot.body.id,
    teamRevision: winningRevision.revision.revision,
  };
  const orderedCreate = await request("human", "POST", missionBase, orderedCreateBody);
  assert.equal(orderedCreate.status, 201);
  assert.equal(orderedCreate.body.outcome, "applied");
  const suspend = await request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
    companyId, command: "suspend", expectedVersion: currentPair.team.head.version,
  });
  assert.equal(suspend.status, 200);
  assert.equal(suspend.body.head.lifecycle, "suspended");
  const orderedRead = await request("human", "GET", `${missionBase}/${orderedCreateBody.missionId}?companyId=${companyId}`);
  assert.equal(orderedRead.status, 200);
  assert.deepEqual(orderedRead.body.mission, orderedCreate.body.mission);
  const orderedReplay = await request("human", "POST", missionBase, orderedCreateBody);
  assert.equal(orderedReplay.status, 200);
  assert.equal(orderedReplay.body.outcome, "replayed");
  assert.deepEqual(orderedReplay.body.receipt, orderedCreate.body.receipt);
  assert.deepEqual(orderedReplay.body.mission, orderedCreate.body.mission);
  evidence.results.missionCreateBeforeSuspensionPersistsAndReplays = "PASS";

  const suspendedRoot = await request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "Mission suspend-before-create fixture",
    description: "Deterministic public API ordering; no dispatch.",
    projectId,
    status: "backlog",
    assigneeAgentId: executorId,
  });
  assert.equal(suspendedRoot.status, 201);
  const suspendedMissionId = randomUUID();
  const suspendedCreate = await request("human", "POST", missionBase, {
    ...orderedCreateBody,
    commandId: randomUUID(),
    missionId: suspendedMissionId,
    rootIssueId: suspendedRoot.body.id,
  });
  assert.equal(suspendedCreate.status, 409);
  assert.equal(suspendedCreate.body.code, "active_rosters_required");
  const suspendedRead = await request("human", "GET", `${missionBase}/${suspendedMissionId}?companyId=${companyId}`);
  assert.equal(suspendedRead.status, 404);
  assert.equal(suspendedRead.body.code, "mission_not_found");
  evidence.results.missionSuspensionBeforeCreateRefusesPersistence = "PASS";
  const staleSuspend = await request("human", "POST", `${rosterBase}/${teamRosterId}/commands`, {
    companyId, command: "suspend", expectedVersion: currentPair.team.head.version,
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

  const pinnedMission = await request("human", "GET", `${missionBase}/${missionId}?companyId=${companyId}`);
  assert.equal(pinnedMission.status, 200);
  assert.equal(pinnedMission.body.mission.version, 2);
  assert.equal(pinnedMission.body.mission.teamRevision, teamCreate.body.revision.revision);
  assert.equal(pinnedMission.body.mission.councilRevision, councilCreate.body.revision.revision);
  assert.equal(pinnedMission.body.mission.aggregate.compositions.team.name, "Delivery team");
  assert.equal(pinnedMission.body.mission.aggregate.compositions.team.revision, teamCreate.body.revision.revision);
  assert.equal(pinnedMission.body.state.executable, false);
  evidence.results.missionPinsSurviveRosterRevisionSuspensionRetirement = "PASS";
  const replayAfterRetirement = await request("human", "POST", missionBase, missionCreateBody);
  assert.equal(replayAfterRetirement.status, 200);
  assert.equal(replayAfterRetirement.body.outcome, "replayed");
  assert.deepEqual(replayAfterRetirement.body.receipt, missionCreate.body.receipt);
  assert.deepEqual(replayAfterRetirement.body.mission, pinnedMission.body.mission);
  assert.equal(replayAfterRetirement.body.mission.aggregate.commandReceipts.length, 2);
  evidence.results.missionCreateReplayAfterRosterRetirement = "PASS";

  const unavailableRoot = await request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "Retired roster selection refusal fixture",
    description: "Synthetic fixture only.",
    projectId,
    status: "backlog",
    assigneeAgentId: executorId,
  });
  assert.equal(unavailableRoot.status, 201);
  const unavailableSelection = await request("human", "POST", missionBase, {
    ...missionCreateBody,
    commandId: randomUUID(),
    missionId: randomUUID(),
    rootIssueId: unavailableRoot.body.id,
    teamRevision: winningRevision.revision.revision,
  });
  assert.equal(unavailableSelection.status, 422);
  assert.equal(unavailableSelection.body.code, "roster_pair_ineligible");
  evidence.results.retiredRosterRejectedForNewMission = "PASS";

  await closeApp();
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts("vite-dev"));
  server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(address.port, "127.0.0.1", resolveListen);
  });
  await app.locals.bundledPluginsStartup;
  assert(workerManager.isRunning(pluginId), "installed package worker must reload after mission persistence restart");
  const missionAfterRestart = await request("human", "GET", `${missionBase}/${missionId}?companyId=${companyId}`);
  assert.equal(missionAfterRestart.status, 200);
  assert.deepEqual(missionAfterRestart.body, pinnedMission.body);
  const replayAfterRestart = await request("human", "POST", missionBase, missionCreateBody);
  assert.equal(replayAfterRestart.status, 200);
  assert.equal(replayAfterRestart.body.outcome, "replayed");
  assert.deepEqual(replayAfterRestart.body.receipt, missionCreate.body.receipt);
  assert.deepEqual(replayAfterRestart.body.mission, pinnedMission.body.mission);
  evidence.results.missionPersistenceAfterRestart = "PASS";

  // N1 qualification uses only declared local fixtures. No wakeup, model, or provider path is invoked.
  const n1Team = await request("human", "POST", rosterBase, {
    companyId,
    command: "create",
    roster: { ...teamDraft, name: "N1 two-contributor fixture team" },
  });
  const n1Council = await request("human", "POST", rosterBase, {
    companyId,
    command: "create",
    roster: { ...councilDraft, name: "N1 fixture council" },
  });
  assert.equal(n1Team.status, 201);
  assert.equal(n1Council.status, 201);
  const n1Pair = await request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId: n1Team.body.head.rosterId,
    teamExpectedVersion: n1Team.body.head.version,
    councilRosterId: n1Council.body.head.rosterId,
    councilExpectedVersion: n1Council.body.head.version,
  });
  assert.equal(n1Pair.status, 200);

  const n1PeriodKey = `fixture-n1-${qualificationId}`;
  const admissionPath = `/api/plugins/${pluginId}/api/companies/${companyId}/admission`;
  const now = Date.now();
  const admissionConfiguration = {
    commandId: randomUUID(),
    companyId,
    periodKey: n1PeriodKey,
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 3_600_000).toISOString(),
    measurement: { status: "known", source: "fixture:local-sandbox", unit: "fixture-unit" },
    allowance: {
      status: "known", source: "fixture:local-sandbox",
      periodUnits: 100, taskUnits: 20, knownUsageUnits: 0,
    },
    exposure: { status: "known", source: "fixture:local-sandbox", units: 0 },
    limits: { maxConcurrent: 1, maxRetries: 0, maxCorrections: 0 },
  };
  const unauthorizedAdmission = await request("intruder", "POST", admissionPath, {
    companyId, command: "configure", configuration: admissionConfiguration,
  });
  assert.equal(unauthorizedAdmission.status, 403);
  assert.equal(unauthorizedAdmission.body.code, "owner_required");
  const admissionConfigured = await request("human", "POST", admissionPath, {
    companyId, command: "configure", configuration: admissionConfiguration,
  });
  assert.equal(admissionConfigured.status, 200);
  assert.equal(admissionConfigured.body.outcome, "configured");
  assert.equal(admissionConfigured.body.envelope.status, "admissible");

  const n1MissionFixtures = await Promise.all(["A", "B"].map(async (suffix) => {
    const rootIssue = await request("human", "POST", `/api/companies/${companyId}/issues`, {
      title: `N1 activation concurrency fixture ${suffix}`,
      description: "Synthetic local-sandbox mission; no child dispatch or model/provider call.",
      projectId,
      status: "backlog",
      assigneeAgentId: executorId,
    });
    assert.equal(rootIssue.status, 201);
    const fixtureMissionId = randomUUID();
    const createdMission = await request("human", "POST", missionBase, {
      companyId,
      command: "create",
      commandId: randomUUID(),
      missionId: fixtureMissionId,
      rootIssueId: rootIssue.body.id,
      projectId,
      teamRosterId: n1Team.body.head.rosterId,
      teamRevision: n1Pair.body.team.revision.revision,
      councilRosterId: n1Council.body.head.rosterId,
      councilRevision: n1Pair.body.council.revision.revision,
      mandate: {
        objective: `N1 fixture mission ${suffix}`,
        acceptanceCriteria: ["Create two native child issues without waking providers"],
        commitments: ["Fixture transitions only; dispatch remains prohibited"],
        limits: {
          taskPolicy: "fixture allowance only",
          periodPolicy: "fixture period only",
          correctionLimit: 1,
          elapsedMinutes: 30,
        },
      },
    });
    assert.equal(createdMission.status, 201);
    return {
      missionId: fixtureMissionId,
      rootIssueId: rootIssue.body.id,
      reservationId: randomUUID(),
      activationCommandId: randomUUID(),
    };
  }));
  const activationRace = await Promise.all(n1MissionFixtures.map((fixture) => request(
    "human",
    "POST",
    `${missionBase}/${fixture.missionId}/commands`,
    {
      companyId,
      command: "activate",
      commandId: fixture.activationCommandId,
      expectedVersion: 1,
      periodKey: n1PeriodKey,
      reservationId: fixture.reservationId,
      requestedUnits: 10,
    },
  )));
  assert.equal(activationRace.filter((result) => result.status === 200).length, 1);
  assert.equal(activationRace.filter((result) => [409, 422].includes(result.status)).length, 1);
  const winnerIndex = activationRace.findIndex((result) => result.status === 200);
  const activeFixture = n1MissionFixtures[winnerIndex];
  const waitingFixture = n1MissionFixtures[winnerIndex === 0 ? 1 : 0];
  let activeMission = activationRace[winnerIndex].body.mission;
  const admissionConflict = activationRace.find((result) => result.status !== 200)!;
  assert(["version_conflict", "admission_blocked"].includes(admissionConflict.body.code));
  const admissionAfterRace = await request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(n1PeriodKey)}`);
  assert.equal(admissionAfterRace.status, 200);
  assert.equal(admissionAfterRace.body.envelope.reservations.length, 1);
  assert.equal(admissionAfterRace.body.envelope.reservations[0].reservationId, activeFixture.reservationId);
  evidence.results.n1AdmissionOwnerAuthAndAtomicActivationRace = "PASS";

  const revisedAfterActivation = await request("human", "POST", `${rosterBase}/${n1Team.body.head.rosterId}/commands`, {
    companyId,
    command: "revise",
    expectedVersion: n1Pair.body.team.head.version,
    roster: { ...teamDraft, name: "N1 team revised after mission activation" },
  });
  assert.equal(revisedAfterActivation.status, 200);
  const pinnedActiveMission = await request("human", "GET", `${missionBase}/${activeFixture.missionId}?companyId=${companyId}`);
  assert.equal(pinnedActiveMission.status, 200);
  assert.equal(pinnedActiveMission.body.mission.aggregate.control.status, "active");
  assert.equal(pinnedActiveMission.body.mission.teamRevision, n1Pair.body.team.revision.revision);
  assert.equal(pinnedActiveMission.body.mission.aggregate.compositions.team.name, "N1 two-contributor fixture team");
  evidence.results.n1ActiveMissionPinsRosterRevision = "PASS";

  const unsettled = await request("human", "POST", admissionPath, {
    companyId,
    command: "settle",
    settlement: {
      commandId: randomUUID(),
      companyId,
      periodKey: n1PeriodKey,
      reservationId: activeFixture.reservationId,
      usage: { status: "unknown", reason: "fixture does not invoke a provider usage source" },
      remainingExposure: { status: "unknown", reason: "fixture provider exposure is intentionally unavailable" },
      expectedVersion: admissionAfterRace.body.envelope.version,
    },
  });
  assert.equal(unsettled.status, 200);
  assert.equal(unsettled.body.envelope.status, "blocked");
  assert.equal(unsettled.body.reservation.status, "unsettled");

  await closeApp();
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts("vite-dev"));
  server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(address.port, "127.0.0.1", resolveListen);
  });
  await app.locals.bundledPluginsStartup;
  assert(workerManager.isRunning(pluginId), "installed package worker must reload after N1 admission restart");
  const admissionAfterN1Restart = await request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(n1PeriodKey)}`);
  assert.equal(admissionAfterN1Restart.status, 200);
  assert.equal(admissionAfterN1Restart.body.envelope.status, "blocked");
  assert.equal(admissionAfterN1Restart.body.envelope.reservations[0].status, "unsettled");
  assert(admissionAfterN1Restart.body.envelope.blockers.some((item: any) => item.code === "unsettled_usage_unknown"));
  evidence.results.n1AdmissionUnsettledPersistenceAfterRestart = "PASS";

  const finalSettlementCommandId = randomUUID();
  const finalSettlement = {
    commandId: finalSettlementCommandId,
    companyId,
    periodKey: n1PeriodKey,
    reservationId: activeFixture.reservationId,
    usage: { status: "known", source: "fixture:local-sandbox", units: 4 },
    remainingExposure: { status: "known", source: "fixture:local-sandbox", units: 0 },
    expectedVersion: admissionAfterN1Restart.body.envelope.version,
  };
  const reconciledAdmission = await request("human", "POST", admissionPath, {
    companyId, command: "settle", settlement: finalSettlement,
  });
  assert.equal(reconciledAdmission.status, 200);
  assert.equal(reconciledAdmission.body.reservation.status, "settled");
  assert.equal(reconciledAdmission.body.envelope.status, "admissible");
  assert.equal(reconciledAdmission.body.envelope.availablePeriodUnits, 96);
  const waitingActivationBody = {
    companyId,
    command: "activate",
    commandId: randomUUID(),
    expectedVersion: 1,
    periodKey: n1PeriodKey,
    reservationId: randomUUID(),
    requestedUnits: 10,
  };
  const waitingActivationAttempts = await Promise.all([0, 1].map(() => request(
    "human", "POST", `${missionBase}/${waitingFixture.missionId}/commands`, waitingActivationBody,
  )));
  assert(waitingActivationAttempts.some((result) => result.status === 200));
  assert(waitingActivationAttempts.every((result) => [200, 409].includes(result.status)));
  const waitingActivation = waitingActivationAttempts.find((result) => result.status === 200)!;
  assert.equal(waitingActivation.body.mission.aggregate.control.status, "active");
  const admissionAfterCapacityReuse = await request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(n1PeriodKey)}`);
  assert.equal(admissionAfterCapacityReuse.status, 200);
  assert.equal(admissionAfterCapacityReuse.body.envelope.reservations.length, 2);
  assert.equal(admissionAfterCapacityReuse.body.envelope.reservations[0].status, "settled");
  assert.equal(admissionAfterCapacityReuse.body.envelope.reservations[1].status, "reserved");
  assert.equal(admissionAfterCapacityReuse.body.envelope.reservations[1].reservationId, waitingActivationBody.reservationId);
  assert.equal(admissionAfterCapacityReuse.body.envelope.availablePeriodUnits, 86);
  evidence.results.n1AdmissionKnownSettlementRestoresCapacity = "PASS";
  evidence.results.n1SharedReservationRetainedOnActivationReplay = "PASS";

  const rootStarted = await request("human", "PATCH", `/api/issues/${activeFixture.rootIssueId}`, { status: "in_progress" });
  assert.equal(rootStarted.status, 200);
  const syntheticLead = await checkoutAgent("executor", activeFixture.rootIssueId, "in_progress");
  const agentCommandPath = `/api/plugins/${pluginId}/api/issues/${activeFixture.rootIssueId}/council/commands`;
  const contributionIds = [randomUUID(), randomUUID()];
  const prematurePlan = await request("executor", "POST", agentCommandPath, {
    missionId: activeFixture.missionId,
    command: "plan", commandId: randomUUID(), expectedVersion: activeMission.version,
    contributions: [
      { contributionId: contributionIds[0], assigneeAgentId: contributorAId, title: "Fixture contribution A", ownedPaths: ["fixture/a.txt"] },
      { contributionId: contributionIds[1], assigneeAgentId: contributorBId, title: "Fixture contribution B", ownedPaths: ["fixture/b.txt"] },
    ],
  });
  assert.equal(prematurePlan.status, 409);
  assert.equal(prematurePlan.body.code, "root_dispatch_run_mismatch");
  const boundLead = await request("human", "POST", `${missionBase}/${activeFixture.missionId}/commands`, {
    companyId, command: "fixture-bind-lead-run", fixtureSource: "fixture:local-sandbox",
    commandId: randomUUID(), expectedVersion: activeMission.version, runId: syntheticLead.runId,
  });
  assert.equal(boundLead.status, 200);
  assert.equal(boundLead.body.mission.aggregate.n1.rootDispatchMode, "fixture");
  activeMission = boundLead.body.mission;
  evidence.results.n1ManualLeadRunRefusedUntilExplicitFixtureBinding = "PASS";
  const plan = await request("executor", "POST", agentCommandPath, {
    missionId: activeFixture.missionId,
    command: "plan",
    commandId: randomUUID(),
    expectedVersion: activeMission.version,
    contributions: [
      { contributionId: contributionIds[0], assigneeAgentId: contributorAId, title: "Fixture contribution A", ownedPaths: ["fixture/a.txt"] },
      { contributionId: contributionIds[1], assigneeAgentId: contributorBId, title: "Fixture contribution B", ownedPaths: ["fixture/b.txt"] },
    ],
  });
  assert.equal(plan.status, 200);
  activeMission = plan.body.mission;
  const nativePlanBody = [
    "# Contributor context fixture",
    "Outcome: persist and reload the SiteBinding from the same SSR/Hono service.",
    "Interface: asynchronous read/write contract shared by backend and frontend.",
    "Constraint: close the connection after each invocation.",
    "Acceptance: a fresh service instance reads the submitted site URL.",
    "Sources: AGENTS.md and docs/implementation-plan.md.",
    ...contributionIds.map((id, index) => `Contribution ${id}: own fixture/${index ? "b" : "a"}.txt and its behavior checks.`),
  ].join("\n");
  const nativePlan = await request("human", "PUT", `/api/issues/${activeFixture.rootIssueId}/documents/plan`, {
    format: "markdown", title: "Contribution context fixture", body: nativePlanBody,
  });
  assert.equal(nativePlan.status, 200);
  assert(nativePlan.body.latestRevisionId);
  const materializedChildren: Array<{ contributionId: string; childIssueId: string; actor: string }> = [];
  for (const [index, contributionId] of contributionIds.entries()) {
    const materialized = await request("executor", "POST", agentCommandPath, {
      missionId: activeFixture.missionId,
      command: "materialize",
      commandId: randomUUID(),
      expectedVersion: activeMission.version,
      contributionId,
    });
    assert.equal(materialized.status, 200);
    assert.equal(materialized.body.outcome, "confirmed");
    assert.equal(materialized.body.effect.issue.parentId, activeFixture.rootIssueId);
    assert.equal(materialized.body.effect.issue.assigneeAgentId, index === 0 ? contributorAId : contributorBId);
    const childReadback = await request("human", "GET", `/api/issues/${materialized.body.effect.issue.id}`);
    assert.equal(childReadback.status, 200);
    assert(childReadback.body.description.includes(nativePlanBody));
    assert(childReadback.body.description.includes(nativePlan.body.latestRevisionId));
    assert(childReadback.body.description.includes(`/api/issues/${activeFixture.rootIssueId}/documents/plan`));
    assert(childReadback.body.description.includes(activeMission.aggregate.mandate.objective));
    for (const criterion of activeMission.aggregate.mandate.acceptanceCriteria) {
      assert(childReadback.body.description.includes(criterion));
    }
    activeMission = materialized.body.mission;
    materializedChildren.push({
      contributionId,
      childIssueId: materialized.body.effect.issue.id,
      actor: index === 0 ? "contributor-a" : "contributor-b",
    });
  }
  evidence.results.n1TwoNativeAttributedChildIssues = "PASS";

  for (const child of materializedChildren) {
    const childStarted = await request("human", "PATCH", `/api/issues/${child.childIssueId}`, { status: "in_progress" });
    assert.equal(childStarted.status, 200);
    await checkoutAgent(child.actor, child.childIssueId, "in_progress");
    const refusedContribution = await request(child.actor, "POST", `/api/plugins/${pluginId}/api/issues/${child.childIssueId}/council/commands`, {
      missionId: activeFixture.missionId,
      command: "record-contribution",
      commandId: randomUUID(),
      expectedVersion: activeMission.version,
      contributionId: child.contributionId,
      commit: "1".repeat(40),
    });
    assert.equal(refusedContribution.status, 409);
    assert.equal(refusedContribution.body.code, "dispatch_not_confirmed");
  }
  const refusedPublish = await request("executor", "POST", agentCommandPath, {
    missionId: activeFixture.missionId,
    command: "publish",
    commandId: randomUUID(),
    expectedVersion: activeMission.version,
    attachmentId: randomUUID(),
    expectedSha256: "0".repeat(64),
    baseCommit: "0".repeat(40),
    candidateCommit: "1".repeat(40),
  });
  assert.equal(refusedPublish.status, 409);
  assert.equal(refusedPublish.body.code, "contributions_incomplete");
  const n1Inspection = await request("human", "GET", `${missionBase}/${activeFixture.missionId}?companyId=${companyId}`);
  assert.equal(n1Inspection.status, 200);
  assert.equal(n1Inspection.body.mission.aggregate.phase, "executing");
  assert.equal(n1Inspection.body.n1.candidate, null);
  assert.equal(n1Inspection.body.n1.participants.length, 2);
  assert(n1Inspection.body.n1.participants.every((slot: any) => slot.issueState === "confirmed" && !slot.dispatchState));
  evidence.results.n1ProhibitedDispatchKeepsContributionAndPublicationBlocked = "PASS";
  evidence.n1Boundary = {
    fixtures: "owner, agents, runs, limits, usage unknowns, missions, and issues are synthetic local-sandbox fixtures",
    providerInvocation: "none; dispatch was deliberately not invoked because it requests native wakeup",
    syntheticLeadRun: "owner bound an authenticated local-sandbox fixture run to the native root checkout; no wakeup occurred",
    demonstrated: [
      "owner admission auth",
      "atomic activation reservation",
      "unsettled restart",
      "known settlement and restored capacity",
      "active pinning",
      "two native child issues",
      "manually started lead run refused until explicit fixture-only binding",
    ],
    incomplete: ["confirmed native dispatch", "two recorded contributions", "integrated bundle candidate", "failed integration verification"],
    admissionReplayLimits: {
      periodUnits: 100,
      taskUnits: 20,
      maxConcurrent: 1,
      maxRetries: 0,
      maxCorrections: 0,
      firstReservationUnits: 10,
      reconciledUsageUnits: 4,
      reconciledRemainingExposureUnits: 0,
      reusedReservationUnits: 10,
      availablePeriodUnitsAfterReuse: 86,
    },
  };

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
    const missionListPattern = "**/api/plugins/*/api/companies/*/missions?**";
    await ownerPage.route(missionListPattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          missions: body.missions.filter((item: any) => item.mission.missionId !== missionId),
        },
      });
    });
    await ownerPage.goto(`${baseUrl}/CPQ/council-missions`, { waitUntil: "networkidle" });
    await ownerPage.getByRole("heading", { name: "Council missions" }).waitFor();
    await ownerPage.getByText("The initial list shows up to the latest 50 missions.", { exact: false }).waitFor();
    assert.equal(await ownerPage.locator(`option[value="${missionId}"]`).count(), 0);
    await ownerPage.getByLabel("Mission UUID").fill(missionId);
    await ownerPage.getByRole("button", { name: "Find mission" }).click();
    await ownerPage.getByRole("status").filter({ hasText: "Mission found and selected." }).waitFor();
    assert.equal(await ownerPage.getByLabel("Select mission").inputValue(), missionId);
    const selectedMissionHeading = await ownerPage.locator("#mission-state-title").textContent();
    const unknownMissionId = randomUUID();
    await ownerPage.getByLabel("Mission UUID").fill(unknownMissionId);
    await ownerPage.getByRole("button", { name: "Find mission" }).click();
    await ownerPage.getByRole("alert").filter({ hasText: "Mission lookup failed: Mission not found" }).waitFor();
    assert.equal(await ownerPage.getByLabel("Select mission").inputValue(), missionId);
    assert.equal(await ownerPage.locator("#mission-state-title").textContent(), selectedMissionHeading);

    let releaseRefreshLookup!: () => void;
    let markRefreshLookupStarted!: () => void;
    const refreshLookupReleased = new Promise<void>((resolveRelease) => { releaseRefreshLookup = resolveRelease; });
    const refreshLookupStarted = new Promise<void>((resolveStarted) => { markRefreshLookupStarted = resolveStarted; });
    const delayedRefreshLookup = async (route: any) => {
      markRefreshLookupStarted();
      await refreshLookupReleased;
      try { await route.continue(); } catch { /* refresh aborts the obsolete request */ }
    };
    const exactMissionPattern = `**/api/plugins/*/api/companies/*/missions/${missionId}?**`;
    await ownerPage.route(exactMissionPattern, delayedRefreshLookup);
    await ownerPage.getByLabel("Mission UUID").fill(missionId);
    await ownerPage.getByRole("button", { name: "Find mission" }).click();
    await refreshLookupStarted;
    await ownerPage.getByRole("button", { name: "Refresh" }).click();
    releaseRefreshLookup();
    await ownerPage.getByText("The initial list shows up to the latest 50 missions.", { exact: false }).waitFor();
    await ownerPage.waitForTimeout(50);
    assert.equal(await ownerPage.locator(`option[value="${missionId}"]`).count(), 0, "a delayed pre-refresh lookup must be discarded");
    await ownerPage.unroute(exactMissionPattern, delayedRefreshLookup);

    let releaseCompanyLookup!: () => void;
    let markCompanyLookupStarted!: () => void;
    const companyLookupReleased = new Promise<void>((resolveRelease) => { releaseCompanyLookup = resolveRelease; });
    const companyLookupStarted = new Promise<void>((resolveStarted) => { markCompanyLookupStarted = resolveStarted; });
    const delayedCompanyLookup = async (route: any) => {
      markCompanyLookupStarted();
      await companyLookupReleased;
      try { await route.continue(); } catch { /* company navigation aborts company A lookup */ }
    };
    await ownerPage.route(exactMissionPattern, delayedCompanyLookup);
    await ownerPage.getByLabel("Mission UUID").fill(missionId);
    await ownerPage.getByRole("button", { name: "Find mission" }).click();
    await companyLookupStarted;
    const companySwitch = ownerPage.goto(`${baseUrl}/FCQ/council-missions`, { waitUntil: "networkidle" });
    releaseCompanyLookup();
    await companySwitch;
    await ownerPage.getByRole("heading", { name: "Council missions" }).waitFor();
    await ownerPage.getByText("No Council missions are recorded in the latest 50 for this company.").waitFor();
    assert.equal(await ownerPage.locator(`option[value="${missionId}"]`).count(), 0, "company A lookup must not mutate company B state");
    await ownerPage.unroute(exactMissionPattern, delayedCompanyLookup);

    await ownerPage.goto(`${baseUrl}/CPQ/council-missions`, { waitUntil: "networkidle" });
    await ownerPage.getByRole("heading", { name: "Council missions" }).waitFor();
    evidence.results.n1MissionExactLookupBeyondLatestList = "PASS";
    await ownerPage.getByLabel("Mission UUID").fill(activeFixture.missionId);
    await ownerPage.getByRole("button", { name: "Find mission" }).click();
    await ownerPage.getByRole("status").filter({ hasText: "Mission found and selected." }).waitFor();
    await ownerPage.getByRole("heading", { name: /^N1 fixture mission [AB]$/ }).waitFor();
    await ownerPage.getByRole("heading", { name: "Contributions" }).waitFor();
    await ownerPage.getByText("Admission and usage").waitFor();
    await ownerPage.route(missionListPattern, (route) => route.abort());
    await ownerPage.getByRole("button", { name: "Refresh" }).click();
    await ownerPage.getByRole("alert").waitFor();
    assert.equal(await ownerPage.getByRole("heading", { name: "Contributions" }).count(), 0);
    assert.equal(await ownerPage.getByRole("heading", { name: "Admission and usage" }).count(), 0);
    evidence.results.n1MissionUiHidesStaleDetailsOnRefreshFailure = "PASS";
    await ownerContext.close();

    evidence.syntheticDeliveryCoordinationUi = await runDeliveryCoordinationBrowser({
      browser, authenticate: (context) => addSessionCookies(context, cookie), baseUrl, companyId,
      sourceInspection: (await request("human", "GET", `${missionBase}/${missionId}?companyId=${companyId}`)).body,
      downstreamInspection: (await request("human", "GET", `${missionBase}/${activeFixture.missionId}?companyId=${companyId}`)).body,
      screenshotPath: resolve(packageRoot, ".paperclip/qualification/ui-synthetic", candidateCommit),
    });
    evidence.results.syntheticDeliveryCoordinationBrowserStates = "PASS";
    evidence.results.syntheticSourceMissionLinkAndReload = "PASS";

    const loadingContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(loadingContext, cookie);
    const loadingPage = await loadingContext.newPage();
    await loadingPage.route("**/api/plugins/*/data/council-rosters", async (route) => {
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
    await errorPage.route("**/api/plugins/*/data/council-rosters", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Injected UI load failure" }),
    }));
    await errorPage.goto(`${baseUrl}/CPQ/council-rosters`, { waitUntil: "domcontentloaded" });
    await errorPage.getByRole("alert").filter({ hasText: "Council configuration could not load" }).waitFor();
    await errorContext.close();

    const missionErrorContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(missionErrorContext, cookie);
    const missionErrorPage = await missionErrorContext.newPage();
    await missionErrorPage.route("**/api/plugins/*/api/companies/*/missions*", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Injected mission inspection failure" }),
    }));
    await missionErrorPage.goto(`${baseUrl}/CPQ/council-missions`, { waitUntil: "domcontentloaded" });
    await missionErrorPage.getByRole("alert").filter({ hasText: "Injected mission inspection failure" }).waitFor();
    await missionErrorContext.close();

    const intruderContext = await browser.newContext({ viewport: { width: 760, height: 760 } });
    await addSessionCookies(intruderContext, intruderCookie);
    const intruderPage = await intruderContext.newPage();
    await intruderPage.goto(`${baseUrl}/CPQ/council-rosters`, { waitUntil: "networkidle" });
    await intruderPage.getByText("Status: read only").waitFor();
    assert.equal(await intruderPage.getByRole("button", { name: "Create draft" }).isDisabled(), true);
    await intruderPage.goto(`${baseUrl}/CPQ/council-missions`, { waitUntil: "networkidle" });
    await intruderPage.getByRole("alert").waitFor();
    await intruderContext.close();
    evidence.results.installedBrowserPageAndAuthenticatedAction = "PASS";
    evidence.results.installedBrowserStates = "PASS";
    evidence.results.n1MissionOwnerPageAndFailureStates = "PASS";
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
    operationId: "functional-correction-v1",
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
    operationId: "functional-approval-v2",
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

  const syntheticN2 = await runSyntheticN2({
    request,
    pluginId,
    baseUrl,
    cookie,
    runtime,
    companyId,
    projectId,
    ownerUserId: userId,
    secretId: secret.body.id,
    agents: {
      lead: executorId,
      contributorA: contributorAId,
      contributorB: contributorBId,
      reviewer: councilId,
    },
    freshRun: async (actor, targetIssueId) => freshRun(actor, targetIssueId),
    bindActorRun: (actor, runId) => {
      const current = agentTokens.get(actor);
      assert(current, `unknown synthetic actor ${actor}`);
      agentTokens.set(actor, { ...current, runId });
    },
    completeRun: completeSyntheticRun,
    seedMission: seedSyntheticMission,
    evidence,
  });

  await closeApp();
  workerManager = createPluginWorkerManager();
  app = await createApp(db, opts("vite-dev"));
  server = createServer(app);
  await new Promise<void>((resolveListen, reject) => {
    server!.once("error", reject);
    server!.listen(address.port, "127.0.0.1", resolveListen);
  });
  await app.locals.bundledPluginsStartup;
  assert(workerManager.isRunning(pluginId), "installed package worker must reload after synthetic N2 acceptance");
  const syntheticRestartReadback = await request(
    "human",
    "GET",
    `${syntheticN2.missionPath}?companyId=${companyId}`,
  );
  assert.equal(syntheticRestartReadback.status, 200, JSON.stringify(syntheticRestartReadback.body));
  assert.equal(syntheticRestartReadback.body.mission.aggregate.phase, "accepted");
  assert.equal(syntheticRestartReadback.body.n2.status, "accepted");
  assert.deepEqual(
    syntheticRestartReadback.body.mission.aggregate.n2,
    syntheticN2.finalMission.mission.aggregate.n2,
  );
  evidence.syntheticN2.restartReadback = syntheticRestartReadback.body;
  evidence.results.n2SyntheticPersistedReadback = "PASS";

  if (liveNativeAuthorized) {
    const live = isolatedLiveN2Authorized
      ? await prepareN2Prerequisite({
          request,
          pluginId,
          baseUrl,
          cookie,
          runtime,
          ownerUserId: userId,
          liveN2Profile: {
            model: process.env.COUNCIL_N2_ISOLATED_LIVE_MODEL!,
            effort: process.env.COUNCIL_N2_ISOLATED_LIVE_EFFORT!,
            runReservationUnits: Number(process.env.COUNCIL_N2_ISOLATED_LIVE_RUN_UNITS),
            periodAllowanceUnits: Number(process.env.COUNCIL_N2_ISOLATED_LIVE_PERIOD_UNITS),
          },
          registerActor: (actor, identity) => {
            agentTokens.set(actor, { ...identity, runId: "", agentId: identity.id });
          },
          createFixtureRun: createN2PrerequisiteFixtureRun,
          finishFixtureRuns: finishN2PrerequisiteFixtureRuns,
        })
      : await runLiveN1({
      request,
      getRun: async (runId) => db.select({
        id: tables.heartbeatRuns.id,
        agentId: tables.heartbeatRuns.agentId,
        status: tables.heartbeatRuns.status,
        startedAt: tables.heartbeatRuns.startedAt,
        finishedAt: tables.heartbeatRuns.finishedAt,
        error: tables.heartbeatRuns.error,
        usageJson: tables.heartbeatRuns.usageJson,
      }).from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId)).then((rows: any[]) => rows[0] ?? null),
      pluginId,
      runtime,
      baseUrl,
      ownerUserId: userId,
      evidence,
      campaign: liveN2Authorized ? "n2" : "n1",
    });
    if (isolatedLiveN2Authorized) {
      evidence.configuration.models = {
        authorized: {
          model: process.env.COUNCIL_N2_ISOLATED_LIVE_MODEL,
          effort: process.env.COUNCIL_N2_ISOLATED_LIVE_EFFORT,
        },
        observedAgentConfiguration: [live.agents.lead, live.agents.reviewer].map((agent: any) => ({
          agentId: agent.id,
          adapterType: agent.adapterType,
          model: agent.adapterConfig?.model ?? null,
          effort: agent.adapterConfig?.modelReasoningEffort ?? null,
        })),
      };
      evidence.configuration.fixtureBoundary = "Isolated N2 terminalizes three deterministic N1 heartbeat fixture rows and clears their exact issue locks before public configuration creates a distinct native N2 period; only reviewer-correction-reviewer may then run against that native period.";
      evidence.n2Prerequisite = {
        proofClass: "N2 native-stage prerequisite validated",
        ...live,
        providerBoundary: {
          providerInvocationCount: 0,
          nativeAgentExecutionCount: 0,
          prerequisiteFixtureHeartbeatRowCount: live.fixtureHeartbeatRuns.length,
          wakeupCount: 0,
          reviewerRunCount: live.runReadbacks.find(
            (entry: { agentId: string }) => entry.agentId === live.agents.reviewer.id,
          )?.runCount ?? -1,
          evidence: "pre-handoff public heartbeat-run readback attributes one terminal, unexecuted fixture row to lead, Alpha, and Beta; the handoff guard later records its separately labelled reviewer fixture",
        },
        databaseBoundary: live.handoffGuard
          ? "the seam terminalizes exactly three N1 heartbeat fixtures and one separately labelled reviewer handoff fixture; public plugin and agent commands retain one native reservation without claiming provider usage or settlement"
          : "the seam terminalizes exactly three N1 heartbeat fixtures and clears only their issue locks; public plugin configuration and admission APIs then create a distinct native N2 period that remains empty until authorized reviewer dispatch",
      };
      Object.assign(evidence.results, {
        n2PrerequisitePublicMission: "PASS",
        n2PrerequisiteDistinctContributions: "PASS",
        n2PrerequisiteVerifiedCandidate: "PASS",
        n2PrerequisiteN1ReservationsSettled: "PASS",
        n2PrerequisiteFixtureZeroExposure: "PASS",
        n2PrerequisiteZeroProviderOrNativeRuns: "PASS",
        n2PrerequisiteStopsBeforeReviewer: "PASS",
        n2PrerequisiteFixtureLifecycleFinished: "PASS",
      });
    }
    let liveMission = live.mission;
    if (liveN2Campaign) {
      const n2 = await runLiveN2({
        request,
        getRun: async (runId) => db.select({
          id: tables.heartbeatRuns.id,
          agentId: tables.heartbeatRuns.agentId,
          status: tables.heartbeatRuns.status,
          startedAt: tables.heartbeatRuns.startedAt,
          finishedAt: tables.heartbeatRuns.finishedAt,
          error: tables.heartbeatRuns.error,
          usageJson: tables.heartbeatRuns.usageJson,
        }).from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId)).then((rows: any[]) => rows[0] ?? null),
        listRuns: async (agentId) => db.select({
          id: tables.heartbeatRuns.id,
          agentId: tables.heartbeatRuns.agentId,
          status: tables.heartbeatRuns.status,
          startedAt: tables.heartbeatRuns.startedAt,
          finishedAt: tables.heartbeatRuns.finishedAt,
          error: tables.heartbeatRuns.error,
          usageJson: tables.heartbeatRuns.usageJson,
        }).from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.agentId, agentId)),
        pluginId,
        evidence,
        n1: live,
        runEvidence: nativeRunEvidence,
        persistEvidence: save,
      });
      liveMission = n2.finalMission;

      await closeApp();
      workerManager = createPluginWorkerManager();
      app = await createApp(db, opts("vite-dev"));
      server = createServer(app);
      await new Promise<void>((resolveListen, reject) => {
        server!.once("error", reject);
        server!.listen(address.port, "127.0.0.1", resolveListen);
      });
      await app.locals.bundledPluginsStartup;
      assert(workerManager.isRunning(pluginId), "installed package worker must reload after N2 acceptance");
      const restartReadback = await request("human", "GET",
        `/api/plugins/${pluginId}/api/companies/${live.companyId}/missions/${live.missionId}?companyId=${live.companyId}`);
      assert.equal(restartReadback.status, 200, JSON.stringify(restartReadback.body));
      assert.equal(restartReadback.body.mission.aggregate.phase, "accepted");
      assert.equal(restartReadback.body.n2.status, "accepted");
      assert.deepEqual(restartReadback.body.n2.submission, liveMission.n2.submission);
      evidence.liveN2.restartReadback = restartReadback.body;
      evidence.results.n2RestartReadback = "PASS";
      liveMission = restartReadback.body;
    }
    const { chromium: liveChromium } = requireServer("@playwright/test");
    const liveBrowser = await liveChromium.launch({
      headless: true,
      ...(process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH
        ? { executablePath: process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH }
        : {}),
    });
    try {
      const context = await liveBrowser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.addCookies(cookie.split("; ").map((part) => {
        const separator = part.indexOf("=");
        return { name: part.slice(0, separator), value: part.slice(separator + 1), url: baseUrl };
      }));
      const page = await context.newPage();
      await page.goto(`${baseUrl}/${live.issuePrefix}/council-missions`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "Council missions" }).waitFor();
      await page.getByLabel("Mission UUID").fill(live.missionId);
      await page.getByRole("button", { name: "Find mission" }).click();
      await page.getByText("Mission found and selected.", { exact: true }).waitFor();
      const selectedMission = page.locator('section[aria-labelledby="mission-state-title"]');
      await selectedMission.locator("#mission-state-title").waitFor();
      assert.equal(
        await selectedMission.locator("#mission-state-title").textContent(),
        liveMission.mission.aggregate.mandate.objective,
      );
      await selectedMission.getByText(liveN2Campaign ? "accepted" : "ready_for_review", { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Contributions" }).waitFor();
      const admissionSection = page.locator('section[aria-labelledby="admission-title"]');
      await admissionSection.getByRole("heading", { name: "Admission and usage" }).waitFor();
      await admissionSection.getByText(
        `Measurement: ${liveMission.admission.measurement.unit} from ${liveMission.admission.measurement.source}.`,
        { exact: true },
      ).waitFor();
      if (liveN2Campaign) {
        await page.getByRole("heading", { name: "Independent review and correction" }).waitFor();
        await page.getByText("V2 / evidence revision 2", { exact: true }).waitFor();
        await page.getByText("eligible and independent", { exact: true }).waitFor();
      }
      const rendered = await page.locator("body").innerText();
      const renderedValues = [
        liveMission.nextAction,
        liveMission.mission.aggregate.responsibilities.integrationLeadAgentId,
        liveMission.mission.aggregate.responsibilities.finalReviewerAgentId,
        liveMission.n1.candidate.candidate.candidateCommit,
        liveMission.n1.candidate.candidate.baseCommit,
        liveMission.n1.candidate.candidate.sha256,
        liveMission.admission.periodKey,
        liveMission.admission.measurement.source,
        ...liveMission.n1.participants.flatMap((slot: any) => [
          slot.title, slot.assigneeAgentId, slot.dispatchRunId, slot.commit, ...slot.ownedPaths,
        ]),
        ...liveMission.n1.candidate.checks.flatMap((check: any) => [check.name, check.status, check.detail]),
        ...(liveN2Campaign ? [
          liveMission.n2.submission.submissionId,
          liveMission.n2.submission.candidateCommit,
          liveMission.n2.submission.sha256,
          liveMission.n2.review.handoff.reviewerRunId,
          liveMission.n2.review.verdict.verdict,
          liveMission.n2.application.state,
          liveMission.n2.application.operationId,
          liveMission.n2.application.receiptState,
        ] : []),
        ...liveMission.admission.reservations.flatMap((reservation: any) => [
          reservation.reservationId,
          String(reservation.requestedUnits),
          String(reservation.usage.units),
          reservation.usage.source,
          String(reservation.remainingExposure.units),
          reservation.remainingExposure.source,
        ]),
      ];
      for (const value of renderedValues) {
        assert(value !== undefined && value !== null && rendered.includes(String(value)),
          `${liveN2Campaign ? "N2" : "N1"} UI is missing observed value: ${String(value)}`);
      }
      const liveScreenshotPath = process.env[`${liveEnvironmentPrefix}_SCREENSHOT_PATH`];
      assert(liveScreenshotPath, "live screenshot path must be claimed by the launcher");
      await mkdir(dirname(liveScreenshotPath), { recursive: true });
      assert(liveScreenshotIdentity, "live screenshot identity must be claimed by the launcher");
      const screenshot = await page.screenshot({ type: "png", fullPage: true });
      writeClaimedArtifact(liveScreenshotPath, liveScreenshotIdentity, screenshot, "screenshot");
      const uiEvidence = { screenshot: liveScreenshotPath, missionId: live.missionId, rootIssueId: live.rootIssueId };
      if (liveN2Campaign) {
        evidence.liveN2.ui = uiEvidence;
        evidence.results.n2InstalledBrowserObservableState = "PASS";
      } else {
        evidence.liveN1.ui = uiEvidence;
        evidence.results.n1InstalledBrowserObservableState = "PASS";
      }
      await context.close();
    } finally {
      await liveBrowser.close();
    }
    evidence.outcome = isolatedLiveN2Authorized
      ? "N2 ISOLATED OBSERVABLE RESULT VALIDATED"
      : liveN2Authorized
      ? "N2 OBSERVABLE RESULT VALIDATED"
      : "N1 OBSERVABLE RESULT VALIDATED";
  } else {
    evidence.outcome = "N2 SYNTHETIC INTEGRATION VALIDATED";
  }
  }
} catch (error) {
  evidence.outcome = "NON-CONCLUSIVE OR BLOCKED";
  evidence.error = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : String(error);
  process.exitCode = 1;
} finally {
  let appShutdownSafe = true;
  try {
    await closeApp();
    evidence.appCleanup = "stopped only the plugin worker, listener, and application created by this run";
  } catch (error) {
    appShutdownSafe = false;
    evidence.cleanupError = String(error);
    process.exitCode = 1;
  }
  const runtimeCleanupResult = await runtimeCleanup.runAfterShutdown({
    appShutdownSafe,
    cleanupDatabase: async () => database?.cleanup(),
  });
  runtimeCleanupHandled = true;
  if (runtimeCleanupResult.error) {
    const evidenceKey = runtimeCleanupResult.failureStage === "database"
      ? "databaseCleanupError"
      : "runtimeCleanupError";
    evidence[evidenceKey] = String(runtimeCleanupResult.error);
    process.exitCode = 1;
  } else if (suppliedRuntime) {
    evidence.databaseCleanup = "fresh isolated PostgreSQL cluster removed; parent-owned temporary instance retained";
  } else if (!appShutdownSafe) {
    evidence.databaseCleanup = "fresh isolated PostgreSQL cluster removed; temporary instance retained because application shutdown was not proven";
  } else {
    evidence.databaseCleanup = "fresh isolated PostgreSQL cluster and temporary instance removed";
  }
  evidence.finishedAt = new Date().toISOString();
  const serializedEvidence = JSON.stringify(evidence);
  for (const credential of agentTokens.values()) {
    assert(!serializedEvidence.includes(credential.token), "evidence must not contain an agent token");
  }
  await save();
  ordinaryPreparationSucceeded = evidence.outcome === "ORDINARY CAMPAIGN PREPARATION OBSERVED" && !evidence.cleanupError && !evidence.databaseCleanupError && !evidence.runtimeCleanupError;
  console.log(JSON.stringify({
    outcome: evidence.outcome,
    evidence: evidencePath,
    results: evidence.results,
    error: evidence.error?.message,
  }));
}
} finally {
  if (!runtimeCleanupHandled) {
    const earlyCleanup = await runtimeCleanup.runEarlyFailure();
    if (earlyCleanup.error) throw earlyCleanup.error;
  }
}

if (ordinaryCampaignProfile) process.exit(ordinaryPreparationSucceeded ? 0 : 1);
