import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLinearHost, waitForLinear, linearHostCommit, type LinearHost } from "./linear-intake-host.js";
import { startLinearSource } from "./linear-intake-source.js";
import { installLinearCouncil, installLinearIntake, linearPolicy } from "./linear-intake-setup.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const councilSchema = "plugin_private_paperclip_council_270061461e";

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

async function packageDigests(root: string) {
  const tracked = git(root, "ls-files", "src", "migrations", "package.json").split("\n");
  const added = git(root, "ls-files", "--others", "--exclude-standard", "src", "migrations").split("\n").filter(Boolean);
  const paths = [...new Set([...tracked, ...added, ...await buildFiles(root)])]
    .filter(Boolean).sort();
  return Object.fromEntries(await Promise.all(paths.map(async path => [path,
    createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")])));
}

async function journals(host: LinearHost, companyId: string) {
  const intake = await host.db.$client.unsafe(`SELECT root_issue_id, mission_id, policy_revision_id, version, state
    FROM ${councilSchema}.project_task_intakes WHERE company_id = $1 ORDER BY root_issue_id`, [companyId]);
  const challenges = await host.db.$client.unsafe(`SELECT challenge_id, mission_id, stage, generation, request_hash,
    response, consumed_at FROM ${councilSchema}.linear_intake_challenges WHERE company_id = $1 ORDER BY created_at`, [companyId]);
  return { intake: Array.from(intake) as any[], challenges: Array.from(challenges) as any[] };
}

async function jobRuns(host: LinearHost, pluginId: string) {
  const jobs = await host.api("GET", `/api/plugins/${pluginId}/jobs`);
  return Promise.all(jobs.map(async (job: any) => ({ jobKey: job.jobKey,
    runs: await host.api("GET", `/api/plugins/${pluginId}/jobs/${job.id}/runs`) })));
}

async function noAdmission(host: LinearHost, companyId: string, council: Awaited<ReturnType<typeof installLinearCouncil>>) {
  const missions = await host.api("GET", `${council.missions}?companyId=${companyId}`);
  assert.equal(missions.missions.length, 0);
  const runs = await host.api("GET", `/api/companies/${companyId}/heartbeat-runs`);
  assert.equal(runs.length, 0);
  const [wakes] = await host.db.$client.unsafe("SELECT count(*)::int AS count FROM agent_wakeup_requests WHERE company_id = $1", [companyId]);
  assert.equal(wakes.count, 0);
  const admission = (await host.api("GET", `${council.admissionPath}?companyId=${companyId}&periodKey=${council.profile.periodKey}`)).envelope;
  assert.equal(admission.reservations.length, 0);
  return { missions: 0, runs: 0, wakeRequests: 0, reservations: 0 };
}

function verifyRunOrder(runs: any[], correspondence: any[], ids: Record<string, string>) {
  const native = (sourceId: string) => correspondence.find(item => item.sourceId === sourceId).nativeId;
  const forSource = (sourceId: string) => runs.filter(run => run.contextSnapshot?.issueId === native(sourceId));
  const alpha = forSource(ids.alpha!), beta = forSource(ids.beta!);
  assert.equal(alpha.length, 1); assert.equal(beta.length, 1); assert.equal(forSource(ids.history!).length, 0);
  assert.equal(forSource(ids.root!).length, 0, "The original product root is not a coordinator execution issue");
  assert(Date.parse(alpha[0].finishedAt) <= Date.parse(beta[0].startedAt), "Dependency predecessor must finish before beta starts");
  assert(runs.every(run => run.status === "succeeded"));
  assert.equal(runs.length, 3, "Only the coordinator and two executable leaves may run");
  return { alphaRunId: alpha[0].id, betaRunId: beta[0].id, historicalRuns: 0, originalRootRuns: 0 };
}

async function sourceFamily(host: LinearHost, companyId: string, projectId: string) {
  const issues = await host.api("GET", `/api/companies/${companyId}/issues?projectId=${projectId}&includePluginOperations=true&limit=50`);
  return issues.filter((issue: any) => issue.originKind === "plugin:ty000.linear-intake");
}

async function refuseEarlyBoardActivation(host: LinearHost, companyId: string,
  council: Awaited<ReturnType<typeof installLinearCouncil>>, mission: any) {
  assert.equal(mission.aggregate.phase, "draft"); assert.equal(mission.aggregate.n1, undefined);
  const reservationId = randomUUID();
  const response = await fetch(`${host.base}${council.missions}/${mission.missionId}/commands`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ companyId, command: "activate", commandId: randomUUID(), expectedVersion: mission.version,
      periodKey: council.profile.periodKey, reservationId, requestedUnits: 1_000 }), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 409, "Board cannot admit an imported draft before the persisted fresh source receipt");
  const rejected = await response.json();
  assert.match(rejected.code, /^linear_/);
  const admission = (await host.api("GET", `${council.admissionPath}?companyId=${companyId}&periodKey=${council.profile.periodKey}`)).envelope;
  assert.equal(admission.reservations.length, 0);
  return { status: response.status, reason: rejected.code, rejectedReservationId: reservationId, reservations: 0 };
}

async function runScenario(host: LinearHost, proof: any, save: () => Promise<void>, intakeRepository: string) {
  const source = await startLinearSource();
  let releaseSource: (() => void) | undefined;
  try {
    const companyId = await host.bootstrapOwner();
    proof.companyId = companyId;
    const council = await installLinearCouncil(host, companyId, repository);
    const intake = await installLinearIntake(host, source, companyId, council.projectId, intakeRepository);
    proof.packages = { councilPluginId: council.pluginId, intakePluginId: intake.pluginId };
    const webhook = source.webhook();
    await intake.deliver(webhook); await intake.deliver(webhook);
    const prepared = await waitForLinear("installed importer prepares complete family", () => intake.action("inspect-import"),
      value => value.plans?.length === 1 && value.plans[0].status === "prepared", 240_000);
    proof.import = prepared;
    const before = await sourceFamily(host, companyId, council.projectId);
    assert.equal(before.length, 4);
    assert(before.every((issue: any) => issue.assigneeAgentId === null && issue.assigneeUserId === null));
    const root = before.find((issue: any) => issue.parentId === null); assert(root);
    const document = await host.api("GET", `/api/issues/${root.id}/documents/linear-intake-readiness-v1`);
    const readiness = JSON.parse(document.body);
    const fullRoot = await host.api("GET", `/api/issues/${root.id}`);
    assert.equal(fullRoot.description, source.issues.get(source.ids.root!)!.description);
    assert(fullRoot.description.length > 34_000);
    proof.preAdmission = await noAdmission(host, companyId, council);
    proof.readiness = { documentId: document.id, revisionId: document.latestRevisionId,
      sha256: createHash("sha256").update(document.body).digest("hex"), intakeId: readiness.intakeId,
      correspondence: readiness.correspondence, longDescriptionLength: fullRoot.description.length };
    await save();

    const policyBody = linearPolicy(council, source, companyId, root.id);
    const disabled = await host.api("POST", council.policyPath, { ...policyBody, enabled: false });
    const priorRuns = (await jobRuns(host, council.pluginId))[0].runs.length;
    await waitForLinear("native scheduler observes disabled mandate", () => jobRuns(host, council.pluginId),
      groups => groups[0].runs.length > priorRuns && groups[0].runs[0].status !== "running", 90_000);
    proof.disabledMandate = await noAdmission(host, companyId, council);

    source.controls.hold = new Promise<void>(done => { releaseSource = done; });
    const beforeSourceCalls = source.calls.length;
    const policy = await host.api("POST", council.policyPath, { ...policyBody, commandId: randomUUID(), expectedVersion: disabled.policy.version });
    await waitForLinear("authenticated revalidation reaches real intake worker", async () => source.calls.length,
      count => count > beforeSourceCalls, 100_000);
    const pending = await journals(host, companyId);
    assert.equal(pending.intake.length, 1); assert.equal(pending.challenges.length, 1);
    proof.beforeRestart = pending;
    proof.pendingReadback = await noAdmission(host, companyId, council);
    proof.restart = await host.restartWorker(council.pluginId);
    releaseSource(); source.controls.hold = undefined;
    const restored = await journals(host, companyId);
    assert.equal(restored.intake[0].mission_id, pending.intake[0].mission_id);
    assert.equal(restored.challenges[0].challenge_id, pending.challenges[0].challenge_id);
    await save();

    const missionId = pending.intake[0].mission_id;
    const missionPath = `${council.missions}/${missionId}`;
    const readMission = async () => {
      const missions = await host.api("GET", `${council.missions}?companyId=${companyId}`);
      return missions.missions.find((entry: any) => entry.mission.missionId === missionId)?.mission;
    };
    await waitForLinear("draft before source admission receipt", readMission,
      mission => mission?.aggregate.phase === "draft", 150_000);
    await waitForLinear("durable unconsumed admission challenge", () => journals(host, companyId),
      state => state.challenges.some(challenge => challenge.stage === "admission" && challenge.consumed_at === null), 30_000);
    const draft = await readMission();
    proof.earlyBoardActivation = await refuseEarlyBoardActivation(host, companyId, council, draft);
    await save();
    const ready = await waitForLinear("native Council subtree reaches settled N1", readMission,
      mission => mission?.aggregate.phase === "ready_for_review", 300_000);
    // Qualification ends before a new review stage. This is an explicit stop, not admission or progress assistance.
    await host.api("POST", council.policyPath, { companyId, command: "suspend", commandId: randomUUID(), expectedVersion: policy.policy.version });
    proof.mission = (await host.api("GET", `${missionPath}?companyId=${companyId}`)).mission;
    assert.equal(proof.mission.missionId, ready.missionId);
    assert.equal(proof.mission.aggregate.n2, undefined);
    proof.runs = await host.api("GET", `/api/companies/${companyId}/heartbeat-runs`);
    proof.order = verifyRunOrder(proof.runs, readiness.correspondence, source.ids);
    proof.admission = (await host.api("GET", `${council.admissionPath}?companyId=${companyId}&periodKey=${council.profile.periodKey}`)).envelope;
    assert.equal(proof.admission.reservations.length, 3);
    assert(proof.admission.reservations.every((entry: any) => entry.status === "settled" && entry.attempt.kind === "initial" && entry.attempt.ordinal === 0));
    assert(proof.admission.reservations.every((entry: any) => entry.missionId === missionId));
    assert(proof.admission.reservations.every((entry: any) => entry.reservationId !== proof.earlyBoardActivation.rejectedReservationId));
    assert.equal(proof.admission.commandReceipts.filter((entry: any) => entry.command === "configure").length, 1);
    assert.equal(proof.admission.allowance.knownUsageUnits, 450);
    assert.equal(proof.admission.periodKey, council.profile.periodKey);
    proof.finalJournals = await journals(host, companyId);
    assert.equal(proof.finalJournals.intake.length, 1);
    assert.equal(proof.finalJournals.intake[0].mission_id, missionId);
    const after = await sourceFamily(host, companyId, council.projectId);
    const historyId = readiness.correspondence.find((entry: any) => entry.sourceId === source.ids.history).nativeId;
    const history = after.find((issue: any) => issue.id === historyId);
    assert.equal(history.status, "cancelled"); assert.equal(history.assigneeAgentId, null);
    for (const issue of before) {
      const detail = await host.api("GET", `/api/issues/${issue.id}`);
      const original = readiness.correspondence.find((entry: any) => entry.nativeId === issue.id);
      assert.equal(detail.description, source.issues.get(original.sourceId)!.description);
      assert.equal(detail.parentId, issue.parentId); assert.equal(detail.originId, issue.originId);
      assert.deepEqual(detail.blockedByIssueIds, issue.blockedByIssueIds);
    }
    proof.jobs = { intake: await jobRuns(host, intake.pluginId), council: await jobRuns(host, council.pluginId) };
    for (const groups of Object.values(proof.jobs) as any[][]) {
      assert(groups.every(group => group.runs.length && group.runs.every((run: any) => run.trigger === "schedule")));
    }
    const requestState = await intake.action("inspect-intake");
    assert.equal(requestState.requests.length, 1); assert.equal(requestState.requests[0].attempts, 1);
    proof.intakeRequest = requestState;
    proof.sourceReads = source.calls;
    proof.checks = { completeImportBeforeAdmission: "PASS", disabledMandateNoAdmission: "PASS", pendingResponseNoAdmission: "PASS",
      restartOriginalIdentity: "PASS", earlyBoardAdmissionRefused: "PASS", oneAdmissionAttempt: "PASS", dependencyOrder: "PASS", historicalTerminalPreserved: "PASS",
      existingAccountingSettled: "PASS", nativeScheduledJobs: "PASS", noImporterWake: "PASS", noProvider: "PASS" };
  } finally { proof.sourceReads = source.calls; releaseSource?.(); await source.close(); }
}

const intakeRepository = process.env.LINEAR_INTAKE_TEST_REPOSITORY;
assert(intakeRepository, "Exact responder checkout is required");
const packageHashes = { council: await packageDigests(repository), intake: await packageDigests(intakeRepository) };
const host = await startLinearHost(repository);
const proof: any = { schema: "council-linear-intake-native.v1", outcome: "RUNNING", startedAt: new Date().toISOString(),
  councilCommit: git(repository, "rev-parse", "HEAD"), councilDirty: git(repository, "status", "--porcelain") !== "",
  intakeCommit: git(intakeRepository, "rev-parse", "HEAD"), hostCommit: linearHostCommit,
  packageDigests: packageHashes,
  boundary: "Real installed intake and Council workers, plugin event bus, scheduled jobs, native admission, runs and costs. Linear HTTP and CLI model content/usage are deterministic. Identity bootstrap alone is an explicit local-board fixture; no plugin business state is seeded. No operational instance or provider." };
const output = resolve(host.runtime, "proof.json");
const save = () => writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
await save();
try {
  await runScenario(host, proof, save, intakeRepository);
  proof.outcome = "NATIVE LINEAR COUNCIL ADMISSION VALIDATED";
} catch (error) {
  proof.outcome = "BLOCKED"; proof.error = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  try {
    if (proof.companyId) proof.failureJournals = await journals(host, proof.companyId);
    if (proof.packages) proof.failureJobs = { intake: await jobRuns(host, proof.packages.intakePluginId),
      council: await jobRuns(host, proof.packages.councilPluginId) };
  } catch (diagnosticError) { proof.diagnosticError = String(diagnosticError); }
} finally {
  try { proof.cleanup = await host.cleanup(); }
  catch (error) { proof.cleanup = { error: String(error) }; proof.outcome = "BLOCKED"; }
  try {
    proof.packageDigestsAfter = { council: await packageDigests(repository), intake: await packageDigests(intakeRepository) };
    assert.deepEqual(proof.packageDigestsAfter, proof.packageDigests, "Source and complete build bytes must remain unchanged throughout qualification");
    proof.packageBytesUnchanged = true;
  } catch (error) { proof.packageBytesUnchanged = false; proof.packageVerificationError = String(error); proof.outcome = "BLOCKED"; }
  proof.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ outcome: proof.outcome, output, error: proof.error?.message }));
process.exit(proof.outcome === "NATIVE LINEAR COUNCIL ADMISSION VALIDATED" ? 0 : 1);
