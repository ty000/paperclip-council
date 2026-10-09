import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLinearHost, waitForLinear, linearHostCommit, type LinearHost } from "./linear-intake-host.js";
import { startLinearSource, type LinearSource } from "./linear-intake-source.js";
import { installLinearCouncil, installLinearIntake, linearCampaignPolicy } from "./linear-intake-setup.js";
import { packageDigests, journals, jobRuns, verifyNativeSourceDescription } from "./linear-qualification-proof.js";
import { canonicalPayloadHash } from "../../src/mission-primitives.js";
import { assertIndependentCampaignReviewer } from "../../src/campaign-closure-subject.js";
import { nativeRunBindings } from "../../src/native-run-bindings.js";
import { installCampaignGitHubTransport, campaignTransportPath } from "./linear-campaign-github.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
function protectedSource(source: LinearSource) {
  return [...source.issues.values()].map(issue => ({ id: issue.uuid, title: issue.title, description: issue.description,
    parentId: issue.parentId, teamId: issue.teamId, projectId: issue.projectId, milestone: issue.projectMilestone,
    relations: structuredClone(issue.relations) }));
}

type Council = Awaited<ReturnType<typeof installLinearCouncil>>;

async function missions(host: LinearHost, council: Council, companyId: string) {
  const view = await host.api("GET", `${council.missions}?companyId=${companyId}`);
  return view.missions.map((entry: any) => entry.mission) as any[];
}

async function bootstrapCampaign(host: LinearHost, source: LinearSource, proof: any, intakeRepository: string) {
  const companyId = await host.bootstrapOwner(); proof.companyId = companyId;
  const settings = await host.api("GET", "/api/instance/settings/experimental");
  await host.api("PATCH", "/api/instance/settings/experimental", { ...settings, enableExternalObjects: true });
  const council = await installLinearCouncil(host, companyId, repository, true);
  const intake = await installLinearIntake(host, source, companyId, council.projectId, intakeRepository);
  proof.packages = { councilPluginId: council.pluginId, intakePluginId: intake.pluginId };
  const event = source.webhook(); await intake.deliver(event); await intake.deliver(event);
  proof.import = await waitForLinear("complete fixed milestone import", () => intake.action("inspect-import"),
    value => value.plans?.length === 1 && value.plans[0].status === "prepared", 240_000);
  const issues = await host.api("GET", `/api/companies/${companyId}/issues?projectId=${council.projectId}&includePluginOperations=true&limit=50`);
  const family = issues.filter((issue: any) => issue.originKind === "plugin:ty000.linear-intake");
  assert.equal(family.length, 5); assert(family.every((issue: any) => !issue.assigneeAgentId && !issue.assigneeUserId));
  const root = family.find((issue: any) => issue.parentId === null); assert(root);
  const document = await host.api("GET", `/api/issues/${root.id}/documents/linear-intake-readiness-v1`);
  const readiness = JSON.parse(document.body); assert.equal(readiness.campaign.mode, "milestone-fixed-v1");
  proof.readiness = { documentId: document.id, revisionId: document.latestRevisionId, body: readiness };
  assert.equal((await missions(host, council, companyId)).length, 0);
  assert.equal((await host.api("GET", `/api/companies/${companyId}/heartbeat-runs`)).length, 0);
  proof.preAdmission = { missions: 0, runs: 0, completeNativeFamily: family.length };
  return { companyId, council, intake, family, root, readiness };
}

async function assertNominalCampaignJobs(host: LinearHost, council: Council, companyId: string, proof: any) {
  const jobs = await jobRuns(host, council.pluginId);
  const failed = jobs.flatMap(group => group.runs.filter((run: any) => run.status === "failed"));
  assert.equal(failed.length, 0, "A failed native Council job requires diagnosis before continuing qualification");
  proof.latestJournals = await journals(host, companyId);
  const questions = proof.latestJournals.intake.flatMap((row: any) =>
    Object.entries(row.state.questions ?? {}).filter(([code]) => code !== "previous_delivery_pending")
      .map(([code, question]) => ({ missionId: row.mission_id, code, question })));
  // The second leaf legitimately waits for its predecessor. Every other retained
  // intake question is a non-nominal condition, even when the scheduled job succeeds.
  assert.equal(questions.length, 0, `Native intake requires diagnosis: ${JSON.stringify(questions)}`);
}

async function observeCampaign(host: LinearHost, setup: Awaited<ReturnType<typeof bootstrapCampaign>>, proof: any, save: () => Promise<void>) {
  const { council, companyId, root } = setup;
  let priorState = ""; let checkedJobsAt = 0;
  return waitForLinear("two integrated leaves and native global closure", async () => {
    assert(!existsSync(resolve(host.runtime, "qualification-stop")), "Qualification explicitly stopped for diagnosis");
    if (Date.now() - checkedJobsAt >= 10_000) {
      checkedJobsAt = Date.now();
      await assertNominalCampaignJobs(host, council, companyId, proof);
    }
    const current = await missions(host, council, companyId);
    const control = current.find(m => m.rootIssueId === root.id);
    const members = current.filter(m => m.aggregate.repositoryCampaign);
    const runs = await host.api("GET", `/api/companies/${companyId}/heartbeat-runs`);
    const failures = runs.filter((run: any) => ["failed", "cancelled", "timed_out"].includes(run.status));
    assert.equal(failures.length, 0, JSON.stringify(failures.map((run: any) => ({ id: run.id, error: run.error }))));
    if (control) {
      assert.equal(control.aggregate.n1, undefined, "Control root must never launch redundant implementation");
      assert.equal(control.aggregate.n5, undefined, "Control root must never create a redundant PR");
    }
    const state = JSON.stringify(current.map(m => ({ id: m.missionId, phase: m.aggregate.phase,
      completion: m.aggregate.completion?.state, continuity: m.aggregate.linearContinuity?.control })));
    if (state !== priorState) {
      priorState = state; proof.progress.push({ at: new Date().toISOString(), missions: current }); await save();
    }
    proof.latest = { missions: current, runs };
    const blockers = current.flatMap(m => (m.aggregate.linearContinuity?.publications ?? []).filter((item: any) => item.kind === "blocker"));
    assert.equal(blockers.length, 0, "A native blocker requires diagnosis before continuing nominal qualification");
    return { control, members, runs };
  }, value => value.control?.aggregate.completion?.state === "closed", 35 * 60_000);
}

function verifyCampaignRunCounts(result: Awaited<ReturnType<typeof observeCampaign>>) {
  const memberRunIds = result.members.flatMap(member => {
    const ids = nativeRunBindings(member).map(binding => binding.runId);
    assert.equal(ids.length, 8); assert(ids.every(Boolean));
    assert.equal(result.runs.filter((run: any) => ids.includes(run.id)).length, 8);
    return ids;
  });
  const expected = [...memberRunIds, result.control.aggregate.campaignClosure.task.runId];
  assert.equal(new Set(expected).size, 17);
  assert.deepEqual(result.runs.map((run: any) => run.id).sort(), expected.sort());
}

function verifySerialResult(result: Awaited<ReturnType<typeof observeCampaign>>, setup: Awaited<ReturnType<typeof bootstrapCampaign>>) {
  const { control, members, runs } = result;
  verifyCampaignRunCounts(result);
  assert.equal(members.length, 2); assert(members.every(member => member.aggregate.completion?.state === "closed"));
  const plan = control.aggregate.linearContinuity.publications.find((publication: any) => publication.payload.campaignPlan);
  assert(plan?.acknowledgement);
  const ordered = plan.payload.campaignPlan.leaves.map((leaf: any) => {
    const member = members.find(item => item.rootIssueId === leaf.nativeId);
    assert(member); return member;
  });
  assert.equal(new Set(ordered.map((member: any) => member.missionId)).size, members.length);
  const [first, second] = ordered;
  assert.equal(second.aggregate.deliveryPredecessor.sourceMissionId, first.missionId);
  assert.notEqual(first.aggregate.n5.publication.observation.url, second.aggregate.n5.publication.observation.url);
  const firstComplete = Date.parse(first.aggregate.completion.completedAt);
  const secondRuns = runs.filter((run: any) => run.contextSnapshot?.issueId === second.aggregate.n1.coordination.issueId);
  assert(secondRuns.length > 0); assert(secondRuns.every((run: any) => Date.parse(run.startedAt) >= firstComplete));
  assert(control.aggregate.linearContinuity.publications.every((publication: any) => publication.acknowledgement));
  assert(runs.every((run: any) => run.status === "succeeded"));
  assert(runs.every((run: any) => Date.parse(run.startedAt) >= Date.parse(plan.acknowledgement.confirmedAt)), "Plan acknowledgement precedes every run");
  assert.equal(git(setup.council.workspace.repoPath, "show", "main:alpha.txt"), "alpha contribution");
  assert.equal(git(setup.council.workspace.repoPath, "show", "main:beta.txt"), "beta contribution");
  return { orderedMissionIds: ordered.map((member: any) => member.missionId), runCount: runs.length,
    noRootImplementation: true, serialPredecessor: true, bothFilesIntegrated: true };
}

async function verifyGlobalReview(host: LinearHost, setup: Awaited<ReturnType<typeof bootstrapCampaign>>, proof: any) {
  const { control, members, runs } = proof.final;
  const state = control.aggregate.campaignClosure;
  assert.equal(state.phase, "closed"); assert.equal(state.report.verdict, "approved");
  assert.equal(state.reportSha256, canonicalPayloadHash(state.report));
  assert.equal(state.subject.results.length, 2);
  assert.deepEqual(state.subject.results.map((item: any) => item.missionId).sort(), members.map((m: any) => m.missionId).sort());
  for (const kind of ["milestone", "milestone-root", "prd", "tad"]) {
    assert(state.subject.coverage.some((item: any) => item.kind === kind), `Global coverage includes ${kind}`);
  }
  assert.equal(state.report.rows.length, state.subject.coverage.length);
  assert(state.report.rows.every((row: any) => row.result === "satisfied" && row.proofIds.length > 0 && row.remainder === null));
  const reviewer = runs.find((run: any) => run.id === state.task.runId);
  assert(reviewer); assert.equal(reviewer.status, "succeeded");
  assertIndependentCampaignReviewer(control, members, reviewer.agentId);
  const document = await host.api("GET", `/api/issues/${setup.root.id}/documents/${state.proofDocument.key}`);
  assert.equal(document.latestRevisionId, state.proofDocument.revisionId); assert.equal(document.body, state.proofDocument.body);
  assert(state.nativeClosures.every((entry: any) => entry.state === "confirmed"));
  assert.equal(state.nativeClosures.at(-1).issueId, setup.root.id);
  proof.globalReview = { runId: reviewer.id, agentId: reviewer.agentId, coverageRows: state.report.rows.length,
    reportSha256: state.reportSha256, proofRevisionId: document.latestRevisionId };
}

async function verifyRemoteDeliveries(host: LinearHost, proof: any) {
  const index = JSON.parse(await readFile(resolve(host.runtime, "github-transport-index.json"), "utf8"));
  assert.equal(Object.keys(index.byMission).length, 2);
  const deliveries = [];
  for (const missionId of proof.serial.orderedMissionIds) {
    const remote = JSON.parse(await readFile(campaignTransportPath(host.runtime, missionId), "utf8"));
    assert.equal(remote.createCount, 1); assert.equal(remote.mergeCount, 1); assert.equal(remote.updateCount, 0);
    assert.equal(remote.merged, true); deliveries.push(remote);
  }
  assert.equal(deliveries[1].baseCommit, deliveries[0].integratedCommit);
  proof.remoteDeliveries = deliveries; proof.remoteIndex = index;
}

function verifyNativeOrder(nativeClosures: any[], source: LinearSource) {
  for (const parent of nativeClosures) for (const child of nativeClosures.filter(node => node.parentId === parent.issueId)) {
    assert(Date.parse(parent.completedAt) >= Date.parse(child.completedAt));
  }
  assert(source.effects.every(effect => effect.sourceId !== source.ids.history), "Historical work receives no publication effect");
}

async function verifyNativeFamily(host: LinearHost, source: LinearSource, setup: Awaited<ReturnType<typeof bootstrapCampaign>>, proof: any) {
  const { readiness } = setup;
  const closure = proof.final.control.aggregate.campaignClosure;
  const nativeClosures: any[] = [];
  for (const entry of readiness.correspondence) {
    const native = await host.api("GET", `/api/issues/${entry.nativeId}`);
    const original = source.issues.get(entry.sourceId)!;
    verifyNativeSourceDescription(native, original.description, proof.final.members);
    assert.equal(native.status, entry.sourceId === source.ids.history ? "cancelled" : "done");
    assert.equal(original.statusType, entry.sourceId === source.ids.history ? "canceled" : "completed");
    if (closure.nativeClosures.some((closed: any) => closed.issueId === native.id)) {
      assert(Date.parse(native.completedAt) >= Date.parse(closure.publicationAcknowledgedAt), "Native parent closure follows Linear acknowledgement");
    }
    if (entry.sourceId !== source.ids.history) nativeClosures.push({ issueId: native.id, parentId: native.parentId, completedAt: native.completedAt });
  }
  verifyNativeOrder(nativeClosures, source);
  proof.nativeClosures = nativeClosures;
}

async function verifyClosure(host: LinearHost, source: LinearSource, setup: Awaited<ReturnType<typeof bootstrapCampaign>>, proof: any) {
  const { companyId, council, intake } = setup;
  const closure = proof.final.control.aggregate.campaignClosure;
  assert(Date.parse(closure.completedAt) >= Date.parse(closure.publicationAcknowledgedAt));
  await verifyNativeFamily(host, source, setup, proof);
  const terminal = source.effects.filter(effect => effect.role === "saveIssue" && effect.state === source.ids.completed);
  assert.equal(terminal.at(-1)?.sourceId, source.ids.root, "Campaign ticket terminal publication is last");
  assert(source.comments.length >= 4, "Plan, two deliveries and global closure are visible");
  assert.equal(new Set(source.comments.map(comment => comment.body)).size, source.comments.length, "No duplicated publication body");
  const admission = (await host.api("GET", `${council.admissionPath}?companyId=${companyId}&periodKey=${council.profile.periodKey}`)).envelope;
  assert(admission.reservations.every((reservation: any) => reservation.status === "settled"));
  assert.equal(admission.commandReceipts.filter((receipt: any) => receipt.command === "configure").length, 1);
  proof.admission = admission;
  await verifyGlobalReview(host, setup, proof);
  await verifyRemoteDeliveries(host, proof);
  proof.intake = await intake.action("inspect-intake"); assert.equal(proof.intake.requests.length, 1);
  proof.finalJournals = await journals(host, companyId);
  proof.jobs = { council: await jobRuns(host, council.pluginId), intake: await jobRuns(host, intake.pluginId) };
}

async function scenario(host: LinearHost, proof: any, save: () => Promise<void>, intakeRepository: string) {
  const source = await startLinearSource({ campaign: true });
  const restoreGitHub = await installCampaignGitHubTransport(host.runtime, proof);
  proof.progress = [];
  const sourceBefore = protectedSource(source);
  try {
    const setup = await bootstrapCampaign(host, source, proof, intakeRepository); await save();
    proof.policy = await host.api("POST", setup.council.policyPath, linearCampaignPolicy(setup.council, source, setup.companyId, setup.root.id));
    const result = await observeCampaign(host, setup, proof, save);
    proof.final = result; proof.serial = verifySerialResult(result, setup);
    await verifyClosure(host, source, setup, proof);
    assert.deepEqual(protectedSource(source), sourceBefore);
    proof.checks = { completeImport: "PASS", noImporterWake: "PASS", serialIntegratedLeaves: "PASS",
      independentGlobalClosure: "PASS", terminalReadback: "PASS", singleBudget: "PASS", noProvider: "PASS" };
  } finally {
    proof.sourceReads = source.calls; proof.publications = { comments: source.comments, effects: source.effects };
    restoreGitHub(); await source.close();
  }
}

const intakeRepository = process.env.LINEAR_INTAKE_TEST_REPOSITORY;
assert(intakeRepository, "Exact built responder checkout is required");
const hashes = { council: await packageDigests(repository), intake: await packageDigests(intakeRepository) };
const host = await startLinearHost(repository);
const proof: any = { schema: "council-linear-campaign-native.v1", outcome: "RUNNING", startedAt: new Date().toISOString(),
  councilCommit: git(repository, "rev-parse", "HEAD"), intakeCommit: git(intakeRepository, "rev-parse", "HEAD"),
  hostCommit: linearHostCommit, packageDigests: hashes,
  boundary: "Real isolated host, installed plugin workers, native event bus, scheduler, missions, admission, runs and accounting. Linear HTTP, GitHub transport and CLI model output are deterministic fixtures; Git commits are real in a private fixture repository. No recipe runtime or provider." };
const output = resolve(host.runtime, "campaign-proof.json");
const save = () => writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
await save();
try { await scenario(host, proof, save, intakeRepository); proof.outcome = "NATIVE CAMPAIGN VALIDATED"; }
catch (error) {
  proof.outcome = "BLOCKED"; proof.error = String(error);
  try {
    if (proof.companyId) proof.failureJournals = await journals(host, proof.companyId);
    if (proof.packages) proof.failureJobs = { council: await jobRuns(host, proof.packages.councilPluginId), intake: await jobRuns(host, proof.packages.intakePluginId) };
  }
  catch (diagnosticError) { proof.diagnosticError = String(diagnosticError); }
} finally {
  try { proof.cleanup = await host.cleanup(); }
  catch (error) { proof.cleanup = { error: String(error) }; proof.outcome = "BLOCKED"; }
  try {
    assert.deepEqual({ council: await packageDigests(repository), intake: await packageDigests(intakeRepository) }, hashes);
    proof.packageBytesUnchanged = true;
  } catch { proof.packageBytesUnchanged = false; proof.outcome = "BLOCKED"; }
  proof.finishedAt = new Date().toISOString(); await save();
}
console.log(JSON.stringify({ outcome: proof.outcome, output, error: proof.error }));
process.exit(proof.outcome === "NATIVE CAMPAIGN VALIDATED" ? 0 : 1);
