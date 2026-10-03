import express from "../../.paperclip/qualification/paperclip/server/node_modules/express/index.js";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../.paperclip/qualification/paperclip/server/node_modules/drizzle-orm/index.js";
import { authUsers, companyMemberships, agents, companies, completionContracts, createDb, heartbeatRuns, issues, issueThreadInteractions, agentWakeupRequests } from "../../.paperclip/qualification/paperclip/packages/db/src/index.ts";
import { actorMiddleware } from "../../.paperclip/qualification/paperclip/server/src/middleware/auth.ts";
import { errorHandler } from "../../.paperclip/qualification/paperclip/server/src/middleware/error-handler.ts";
import { issueRoutes } from "../../.paperclip/qualification/paperclip/server/src/routes/issues.ts";
import { startEmbeddedPostgresTestDatabase } from "../../.paperclip/qualification/paperclip/server/src/__tests__/helpers/embedded-postgres.ts";
import { CONTROL_PLANE_CONFORMANCE_OPEN, CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../.paperclip/qualification/paperclip/server/src/vendor/paperclip-runner/testing.ts";
import { PaperclipControlPlanePort } from "../../.paperclip/qualification/paperclip/server/src/services/native-runtime/paperclip-control-plane-port.ts";
import { finalizeNativeRun } from "../../.paperclip/qualification/paperclip/server/src/services/native-runtime/native-run-finalizer.ts";
import { claimNativeReviewExecutionLock, getNativeReviewAssignment } from "../../.paperclip/qualification/paperclip/server/src/services/native-runtime/native-review-participant.ts";
import { PaperclipRunnerToolAuthority } from "../../.paperclip/qualification/paperclip/server/src/services/native-runtime/paperclip-runner-tool-authority.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const host = join(repository, ".paperclip/qualification/paperclip");
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const hostCommit = git(host, ["rev-parse", "HEAD"]);
if (hostCommit !== "61b3fd57a695614dc4a37e2303f426a34a9795cf" || git(host, ["status", "--porcelain", "--untracked-files=no"])) {
  throw new Error("The native dependency probe requires unchanged host 61b3fd57");
}
const candidateCommit = git(repository, ["rev-parse", "HEAD"]);
const candidateDirty = Boolean(git(repository, ["status", "--porcelain"]));
const proofStem = `n2-native-dependency-${candidateCommit}-${Date.now()}`;
function writeProof(kind: string, value: unknown) {
  const path = join(repository, "artifacts", `${proofStem}-${kind}.json`);
  writeFileSync(path, JSON.stringify({ candidateCommit, candidateDirty, hostCommit,
    sourceSha256: createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex"),
    evidence: value }, null, 2), { flag: "wx" });
  console.log(`Native dependency evidence: ${path}`);
}

// Substitute only the official model-backend seam, including services created
// by public routes. Preserve every scheduling, admission, event and cost method.
const injectedModel = vi.hoisted(() => ({ factory: undefined as undefined | ((execution: any) => any) }));
vi.mock("../../.paperclip/qualification/paperclip/server/src/services/heartbeat.ts", async (original) => {
  const real: any = await original();
  return { ...real, heartbeatService: (db: any, options: any = {}) => real.heartbeatService(db, {
    ...options, nativeSessionBackendFactory: options.nativeSessionBackendFactory ?? injectedModel.factory,
  }) };
});

let temporary: any;
let db: any;
const runtimeHome = mkdtempSync(join(tmpdir(), "paperclip-council-native-probe-"));
process.env.PAPERCLIP_HOME = runtimeHome;
process.env.PAPERCLIP_INSTANCE_ID = "native-probe";
process.env.PAPERCLIP_TELEMETRY_ENABLED = "false";
process.env.OTEL_SDK_DISABLED = "true";

beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("council-dependency-probe-");
  db = createDb(temporary.connectionString);
  const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
  await db.insert(companies).values({ id: identity.companyId, name: "N2 dependency probe", issuePrefix: "N2D" });
  await db.insert(authUsers).values({ id: "reviewer-24", name: "Fixture owner", email: "n2-owner@example.invalid", createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: identity.companyId, principalType: "user", principalId: "reviewer-24", membershipRole: "owner", status: "active" });
  await db.insert(authUsers).values({ id: "local-board", name: "Local board fixture", email: "n2-board@example.invalid", createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: identity.companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" });
  await db.insert(agents).values({ id: identity.agentId, companyId: identity.companyId, name: "Worker", adapterType: "process", adapterConfig: { command: "/usr/bin/true" }, status: "idle" });
}, 30000);
function removeOwnedRuntime(path: string) {
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeOwnedRuntime(join(path, name));
}
afterAll(async () => { await temporary?.cleanup(); removeOwnedRuntime(runtimeHome); rmSync(runtimeHome, { recursive: true, force: true }); }, 30000);
async function prepareNativeSourceFixture(adapterType: "codex_local" | "paperclip_runner") {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = randomUUID();
    const localContractId = randomUUID();
    const runId = randomUUID();
    const runnerInstanceId = randomUUID();
    const reviewerAgentId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId, companyId: identity.companyId, name: "Review lead",
      adapterType, ...(adapterType === "paperclip_runner" ? { adapterConfig: { provider: "codex", model: "deterministic-test" } } : {}), status: "idle",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Native review interaction",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      responsibleUserId: "reviewer-24",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "phase6-v1", objective: "Review", criteria: [{ id: "objective", requirement: "Review" }] },
      canonicalSha256: "native-review-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "native-review-control",
    });
    await port.openRun({
      identity: { ...identity, issueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result = { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: "phase6-v1" }, reportedWorkDisposition: "needs_review" as const, attentionRequests: [{ kind: "review" as const, summary: "Review release notes", ownerClass: "agent" as const, targetAgentId: reviewerAgentId }] };
    await port.completeRun({ result, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" }, callerResultId: randomUUID() });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [agentReview] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    return { identity, issueId, localContractId, reviewerAgentId, agentReview };
}

async function startProbeApi(trace: any[]) {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID();
    const app = express(); app.use(express.json()); app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any, {}));
    const { agentRoutes } = await import("../../.paperclip/qualification/paperclip/server/src/routes/agents.ts");
    app.use("/api", agentRoutes(db, { deploymentMode: "local_trusted" })); app.use(errorHandler);
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening", resolve));
    const apiUrl = `http://127.0.0.1:${(listener.address() as any).port}`;
    const request = async (method: string, path: string, body: unknown) => {
      const response = await fetch(`${apiUrl}/api${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json(); trace.push({ event: "board_api", method, path, status: response.status, body: data });
      expect(response.status).toBeLessThan(300); return data;
    };
    return { apiUrl, request, close: () => new Promise<void>(resolve => listener.close(() => resolve())) };
}

it("installs a blocker by HTTP after reviewer claim and before native rejection", async () => {
    const { identity, issueId, localContractId, reviewerAgentId, agentReview } = await prepareNativeSourceFixture("codex_local");
    const reviewRunId = randomUUID();
    const reviewRunnerId = randomUUID();
    const nativeReview = { nativeReviewInteractionId: agentReview.id, nativeReviewDecisionId: (agentReview.payload as any).target.revisionId };
    await db.insert(heartbeatRuns).values({ id: reviewRunId, companyId: identity.companyId, agentId: reviewerAgentId,
      status: "running", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: identity.sessionId,
      runnerInstanceId: reviewRunnerId, completionContractId: localContractId, completionContractSha256: "native-review-contract",
      contextSnapshot: { issueId, wakeReason: "native_completion_review", ...nativeReview } });
    expect(await claimNativeReviewExecutionLock(db, { companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId,
      contextSnapshot: nativeReview, agentNameKey: "reviewer", claimedAt: new Date() })).toBe(true);

    const trace: any[] = [];
    const snapshot = async (event: string) => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [reviewer] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, reviewRunId));
      const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, agentReview.id));
      const entry = { event, issue: { status: issue.status, statusVersion: issue.statusVersion, executionRunId: issue.executionRunId, assigneeAgentId: issue.assigneeAgentId, lastStatusDecisionId: issue.lastStatusDecisionId }, reviewer: { status: reviewer.status, finishedAt: reviewer.finishedAt }, interaction: { status: interaction.status, resolvedByRunId: interaction.resolvedByRunId } };
      trace.push(entry); return entry;
    };
    const { apiUrl, request, close } = await startProbeApi(trace);
    try {
      const before = await snapshot("reviewer_claimed");
      const blocker = await request("POST", `/companies/${identity.companyId}/issues`, { title: "Council deterministic settlement", status: "todo" });
      await request("PATCH", `/issues/${issueId}`, { blockedByIssueIds: [blocker.id] });
      const after = await snapshot("blocker_installed_via_api");
      expect(after.issue).toEqual(before.issue);
      expect(after.reviewer.status).toBe("running");
      expect(await getNativeReviewAssignment(db, { companyId: identity.companyId, issueId, agentId: reviewerAgentId, contextSnapshot: nativeReview, actingRunId: reviewRunId })).not.toBeNull();
      const authority = new PaperclipRunnerToolAuthority(db, { companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId, nativeReview, apiUrl });
      await expect(authority.execute({ tool: "resolve_review", callId: randomUUID(), arguments: { decision: "reject", reason: "Correct candidate verification" } })).resolves.toMatchObject({ status: "rejected" });
      const rejected = await snapshot("native_rejection_before_finish");
      expect(rejected.reviewer.status).toBe("running");
      expect(rejected.interaction.resolvedByRunId).toBe(reviewRunId);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, identity.agentId));
      trace.push({ event: "real_wakeup", wakes });
      expect(wakes).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "issue_execution_deferred", status: "deferred_issue_execution", runId: null })]));
      const reviewerPort = new PaperclipControlPlanePort(db, { companyId: identity.companyId, issueId, runId: reviewRunId, agentId: reviewerAgentId,
        sessionId: identity.sessionId, completionContractId: localContractId, completionContractSha256: "native-review-contract", sourceInstanceId: reviewRunnerId, controlPlaneSourceInstanceId: "probe-reviewer" });
      await reviewerPort.openRun({ identity: { ...identity, issueId, runId: reviewRunId, agentId: reviewerAgentId }, backendKind: "mock", sourceInstanceId: reviewRunnerId });
      await reviewerPort.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: randomUUID() });
      await finalizeNativeRun({ db, runId: reviewRunId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      await snapshot("reviewer_finalized");
      const { heartbeatService } = await import("../../.paperclip/qualification/paperclip/server/src/services/heartbeat.ts");
      await heartbeatService(db).reconcileStrandedAssignedIssues();
      const finalWakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, identity.agentId));
      trace.push({ event: "recovery_after_finish", wakes: finalWakes });
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId));
      expect(runs).toHaveLength(2);
    } finally {
      writeProof("api", { boundary: "Seeded source/review admission, real native finalizer and JWT/HTTP decision, blocker through Board HTTP, real wake; no provider; no Council G3/G4 completion claim", trace });
      await close();
    }
}, 30000);

function deterministicModel(trace: any[], onTurn: (execution: any, result: any) => Promise<void>) {
  return (execution: any) => {
    trace.push({ event: "native_backend", binding: execution.binding, session: execution.session });
    const runId = execution.binding.runId;
    const identity = { ...execution.binding, sessionId: execution.session.normalizedSessionId };
    const turnId = randomUUID();
    let done!: () => void;
    const started = new Promise<void>(resolve => { done = resolve; });
    const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
    const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    return {
      async descriptor() { return { kind: "mock", name: "council-deterministic-model", version: "1", capabilities,
        runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
      async openSession() { return {
        identity: () => identity,
        async capabilities() { return capabilities; },
        async startTurn(input: any) {
          const delivered = JSON.parse(input.message.text);
          result.completionClaim.contractRevision = delivered.completionContract.revision;
          result.completionClaim.criteria = delivered.completionContract.criteria.map((c: any) => ({ ...result.completionClaim.criteria[0], criterionId: c.id }));
          await onTurn(execution, result);
          done(); return { turnId };
        },
        async *events() {
          await started;
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          yield { schema: "paperclip.prp.event.v1", sourceEventId: `${run.runnerInstanceId}:terminal`, sourceSeq: 1,
            sourceInstanceId: run.runnerInstanceId, sourceKind: "runner", runId, normalizedSessionId: identity.sessionId, turnId,
            eventType: "turn.completed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: {} };
        },
        async result() { return { result, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: result.reportedWorkDisposition }, turnId }; },
        async usage() { return { inputTokens: 101, outputTokens: 23, costUsd: 0.001 }; },
        async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity, providerSessionId: null, activeTurnId: null, cursor: "1", pendingRuntimeRequests: [], lineage: [] }; },
        async close() {},
      }; },
    } as any;
  };
}

it("dispatches the native reviewer and accounts its real lifecycle with only the model substituted", async () => {
    const { identity, issueId, reviewerAgentId } = await prepareNativeSourceFixture("paperclip_runner");
  const { heartbeatService } = await import("../../.paperclip/qualification/paperclip/server/src/services/heartbeat.ts");
  const { costEvents } = await import("../../.paperclip/qualification/paperclip/packages/db/src/index.ts");
  const trace: any[] = [];
  const { apiUrl, request, close } = await startProbeApi(trace);
  const registry = await import("../../.paperclip/qualification/paperclip/server/src/adapters/registry.ts");
  await registry.waitForExternalAdapters();
  const processAdapter = registry.getServerAdapter("process");
  let correctionAdapterExecutions = 0;
  registry.registerServerAdapter({ ...processAdapter, async execute(ctx: any) {
    correctionAdapterExecutions += 1;
    return processAdapter.execute(ctx);
  } });
  const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: deterministicModel(trace, async (execution, _result) => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          const blocker = await request("POST", `/companies/${execution.binding.companyId}/issues`, { title: "Settlement before correction", status: "todo" });
          await request("PATCH", `/issues/${issueId}`, { blockedByIssueIds: [blocker.id] });
          const authority = new PaperclipRunnerToolAuthority(db, { companyId: execution.binding.companyId, issueId, agentId: reviewerAgentId, runId: execution.binding.runId, apiUrl,
            nativeReview: { nativeReviewInteractionId: run.contextSnapshot.nativeReviewInteractionId, nativeReviewDecisionId: run.contextSnapshot.nativeReviewDecisionId } });
          trace.push({ event: "native_decision", response: await authority.execute({ tool: "resolve_review", callId: randomUUID(), arguments: { decision: "reject", reason: "Correct candidate verification" } }) });
  }) });
  try {
    trace.push({ event: "dispatch", result: await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: identity.companyId }) });
    await heartbeat.drainActiveRunExecutions();
    const { buildHostServices } = await import("../../.paperclip/qualification/paperclip/server/src/services/plugin-host-services.ts");
    const { createPluginEventBus } = await import("../../.paperclip/qualification/paperclip/server/src/services/plugin-event-bus.ts");
    const services = buildHostServices(db, randomUUID(), "private.council-native-probe", createPluginEventBus());
    const summary = await services.issues.getOrchestrationSummary({ companyId: identity.companyId, issueId, includeSubtree: false });
    services.dispose();
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, identity.companyId)))
      .filter((run: any) => run.contextSnapshot?.issueId === issueId);
    const costs = await db.select().from(costEvents).where(eq(costEvents.issueId, issueId));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, identity.companyId));
    trace.push({ event: "readback", summary, runs: runs.map((run: any) => ({ id: run.id, agentId: run.agentId, status: run.status,
      runtimeMode: run.runtimeMode, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, errorCode: run.errorCode,
      processStartedAt: run.processStartedAt, usageJson: run.usageJson, createdAt: run.createdAt, contextSnapshot: run.contextSnapshot })), costs, wakes });
    expect(runs).toHaveLength(3);
    expect(summary.runs).toHaveLength(3);
    const rejectedAdmission = runs.find((run: any) => run.status === "cancelled");
    expect(rejectedAdmission).toMatchObject({ startedAt: null, processStartedAt: null, errorCode: "issue_dependencies_blocked" });
    expect(summary.runs.find((run: any) => run.id === rejectedAdmission.id)).toMatchObject({ status: "cancelled", startedAt: null,
      error: "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve" });
    expect(runs.find((r: any) => r.agentId === reviewerAgentId)).toMatchObject({ status: "succeeded", runtimeMode: "native" });
    expect(correctionAdapterExecutions).toBe(0);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({ inputTokens: 101, outputTokens: 23 });
    // Use the same standard agent-key authority as Council, never the board
    // identity, to qualify the public per-run accounting readback.
    const keyResponse = await fetch(`${apiUrl}/api/agents/${reviewerAgentId}/keys`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Council accounting readback", scope: { kind: "standard" } }),
    });
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json();
    const reviewerRun = runs.find((run: any) => run.agentId === reviewerAgentId);
    const readResponse = await fetch(`${apiUrl}/api/heartbeat-runs/${reviewerRun.id}`, {
      headers: { authorization: `Bearer ${key.token}` },
    });
    const publicRun = await readResponse.json();
    trace.push({ event: "council_agent_run_readback", status: readResponse.status, run: {
      id: publicRun.id, companyId: publicRun.companyId, agentId: publicRun.agentId,
      nativeIssueId: publicRun.nativeIssueId, contextSnapshot: publicRun.contextSnapshot,
      status: publicRun.status, startedAt: publicRun.startedAt, finishedAt: publicRun.finishedAt,
      usageJson: publicRun.usageJson,
    } });
    expect(readResponse.status).toBe(200);
    expect(publicRun).toMatchObject({ id: reviewerRun.id, companyId: identity.companyId,
      agentId: reviewerAgentId, status: "succeeded", usageJson: { inputTokens: 101, outputTokens: 23 } });
  } finally {
    registry.registerServerAdapter(processAdapter);
    writeProof("model", { boundary: "N1 source fixture; actual heartbeat reviewer admission/finalizer/cost with NativeSessionBackend model substitution; no Council G3/G4 claim", trace });
    await close();
  }
}, 60000);

it("checks public release of a reviewer wait after a real native transmission", async () => {
  const companyId = CONTROL_PLANE_CONFORMANCE_OPEN.identity.companyId;
  const leadId = randomUUID();
  const reviewerId = randomUUID();
  const issueId = randomUUID();
  // Only identities and the already-terminated N1 predecessor are fixtures.
  // Transmission admission, result/card, cost and reviewer wake are real.
  await db.insert(agents).values([
    { id: leadId, companyId, name: "Transmission lead", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "deterministic-test" }, status: "idle" },
    { id: reviewerId, companyId, name: "Final reviewer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "deterministic-test" }, status: "idle" },
  ]);
  await db.insert(issues).values({ id: issueId, companyId, title: "N1 candidate ready for native transmission", status: "in_progress", assigneeAgentId: leadId, responsibleUserId: "reviewer-24", workMode: "standard" });
  await db.insert(heartbeatRuns).values({ companyId, agentId: leadId, status: "succeeded", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId, fixtureSource: "N1 legacy predecessor" } });
  const trace: any[] = [];
  const executions: string[] = [];
  let blockerId = "";
  let request: Awaited<ReturnType<typeof startProbeApi>>["request"];
  injectedModel.factory = deterministicModel(trace, async (execution, result) => {
    executions.push(execution.binding.runId);
    if (executions.length > 1) throw new Error("Unexpected successor: public release did not restore the native reviewer contract");
    expect(execution.binding.agentId).toBe(leadId);
    const blocker = await request("POST", `/companies/${companyId}/issues`, { title: "Transmission accounting gate", status: "todo" });
    blockerId = blocker.id;
    await request("PATCH", `/issues/${issueId}`, { blockedByIssueIds: [blockerId] });
    result.reportedWorkDisposition = "needs_review";
    result.attentionRequests = [{ kind: "review", summary: "Review verified V1", ownerClass: "agent", targetAgentId: reviewerId }];
  });
  const api = await startProbeApi(trace);
  request = api.request;
  const { heartbeatService } = await import("../../.paperclip/qualification/paperclip/server/src/services/heartbeat.ts");
  const heartbeat = heartbeatService(db);
  const readback = async (event: string) => {
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).filter((run: any) => run.contextSnapshot?.issueId === issueId);
    const interactions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter((wake: any) => wake.payload?.issueId === issueId);
    const { costEvents } = await import("../../.paperclip/qualification/paperclip/packages/db/src/index.ts");
    const costs = await db.select().from(costEvents).where(eq(costEvents.issueId, issueId));
    const entry = { event, runs: runs.map((run: any) => ({ id: run.id, agentId: run.agentId, status: run.status, runtimeMode: run.runtimeMode, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, errorCode: run.errorCode, contextSnapshot: run.contextSnapshot })), interactions, wakes, costs };
    trace.push(entry); return entry;
  };
  try {
    await request("POST", `/agents/${leadId}/wakeup`, { source: "on_demand", reason: "council_n2_transmission", payload: { issueId }, idempotencyKey: `transmission:${issueId}` });
    await heartbeat.drainActiveRunExecutions();
    const held = await readback("transmission_terminal_reviewer_held");
    expect(held.runs.find((run: any) => run.id === executions[0])).toMatchObject({ status: "succeeded", runtimeMode: "native" });
    expect(held.costs).toHaveLength(1);
    expect(held.interactions).toHaveLength(1);
    expect(held.interactions[0].status).toBe("pending");
    // Disable only the lead after terminal to make unexpected dependency wakes
    // observable without executing another transmission. Reviewer stays enabled.
    await request("PATCH", `/agents/${leadId}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
    await request("PATCH", `/issues/${issueId}`, { blockedByIssueIds: [] });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.reconcileStrandedAssignedIssues();
    await heartbeat.drainActiveRunExecutions();
    const released = await readback("after_public_release_and_recovery");
    expect(released.interactions[0].status).toBe("pending");
    expect(released.runs.filter((run: any) => run.agentId === reviewerId && run.startedAt)).toHaveLength(0);
    const review = held.interactions[0];
    await request("POST", `/agents/${reviewerId}/wakeup`, { source: "on_demand", reason: "native_completion_review", payload: { issueId,
      nativeReviewInteractionId: review.id, nativeReviewDecisionId: review.payload.target.revisionId }, idempotencyKey: `review-public-recovery:${review.id}` });
    await heartbeat.drainActiveRunExecutions();
    const retried = await readback("public_reviewer_wake_readback");
    expect(retried.interactions[0].status).toBe("pending");
    expect(retried.runs.filter((run: any) => run.agentId === reviewerId && run.startedAt)).toHaveLength(0);
  } finally {
    injectedModel.factory = undefined;
    writeProof("release", { boundary: "Real native transmission from terminated legacy N1 fixture; model-only factory injected into real route heartbeat services; no Council G3/G4 completion claim", trace });
    await api.close();
  }
}, 60000);
