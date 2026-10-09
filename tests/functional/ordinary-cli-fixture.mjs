#!/usr/bin/env node
import { coordinateFixture } from "./n6-coordination-fixture.mjs";
// Sole model seam: deterministic CLI output and content; all business calls use installed APIs.
import { publishDelivery, rebindDeliveryPlan } from "./ordinary-delivery-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
let config = JSON.parse(await readFile(process.env.COUNCIL_ORDINARY_FIXTURE, "utf8"));
const base = process.env.PAPERCLIP_API_URL;
assert.equal(new URL(base).hostname, "127.0.0.1");
const issueId = process.env.PAPERCLIP_TASK_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const runId = process.env.PAPERCLIP_RUN_ID;
process.on("uncaughtException", async error => {
  await writeFile(resolve(config.runtime, `fixture-failure-${runId}.json`), JSON.stringify({ runId, message: String(error.message).slice(0, 2000) })).catch(() => {});
  process.exitCode = 1;
});
const headers = { authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, "x-paperclip-run-id": runId };
async function api(method, path, body, expected) {
  const form = body instanceof FormData;
  const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(!form ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: form ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (expected) assert.equal(response.status, expected, JSON.stringify(value));
  else if (!response.ok) throw Object.assign(new Error(`${response.status} ${JSON.stringify(value)}`), { response: value });
  return value;
}
const route = `/api/plugins/private.paperclip-council/api/issues/${issueId}/council/commands`;
if (config.campaignMode) {
  const nativeIssue = await api("GET", `/api/issues/${issueId}`);
  const describedMissionId = /"missionId"\s*:\s*"([0-9a-f-]{36})"/i.exec(nativeIssue.description ?? "")?.[1];
  const campaignReview = nativeIssue.description?.includes('"command":"campaign-review-inspect"') === true;
  let discovered;
  if (describedMissionId) discovered = { missionId: describedMissionId };
  else discovered = await api("POST", route, { command: "inspect" });
  assert(discovered.missionId, "Each campaign run must discover its own mission from its authenticated native task");
  config = { ...config, missionId: discovered.missionId, campaignReview,
    ...(discovered.n1?.rootIssueId ? { rootIssueId: discovered.n1.rootIssueId } : {}),
    baseCommit: discovered.n1?.sourceBaseCommit ?? execFileSync("git", ["rev-parse", "main"], { cwd: config.repoPath, encoding: "utf8" }).trim() };
} else if (config.projectIntake && !config.missionId) {
  assert.equal(agentId, config.actors.lead);
  const discovered = await api("POST", route, { command: "inspect" });
  assert(discovered.missionId);
  config.missionId = discovered.missionId;
  config.rootIssueId = discovered.n1.rootIssueId ?? issueId;
  await writeFile(process.env.COUNCIL_ORDINARY_FIXTURE, JSON.stringify(config));
}
const coordinationActor = [config.actors.pm, config.actors.pmSuccessor, config.actors.facilitator].includes(agentId);
const call = body => api("POST", route, { missionId: coordinationActor || issueId === config.n6RootIssueId ? config.n6MissionId : config.missionId, ...body });
const pause = () => new Promise(r => setTimeout(r, 150));
async function observe(read, ok, label) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const value = await read(); if (ok(value)) return value;
    await pause();
  }
  throw new Error(`Timeout ${label}`);
}
const git = (...args) => execFileSync("git", args, { cwd: config.repoPath, encoding: "utf8" }).trim();
await api("POST", `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ["todo", "in_progress"] });
const inspectCommand = config.campaignReview ? "campaign-review-inspect" : coordinationActor ? "n6-inspect" : agentId === config.actors.publisher ? "n5-inspect" : "inspect";
let inspection = await observe(async () => { try { return await call({ command: inspectCommand }); }
  catch (e) { if (["root_dispatch_run_mismatch", "dispatch_run_mismatch"].includes(e.response?.code)) return null; throw e; } }, Boolean, "dispatch binding");
inspection = inspection.inspection ?? inspection;
if (config.campaignMode) {
  assert.equal(inspection.missionId, config.missionId, "Authenticated inspection must confirm the mission discovered from this native task");
  const rootIssueId = inspection.rootIssueId ?? inspection.n1?.rootIssueId;
  assert(rootIssueId, "Campaign inspection must reveal the exact leaf root issue");
  config = { ...config, rootIssueId, baseCommit: inspection.n1?.sourceBaseCommit ?? config.baseCommit };
}
async function command(command, extra = {}) {
  inspection = await call({ command: "inspect" });
  return call({ command, commandId: randomUUID(), expectedVersion: inspection.version, ...extra });
}
async function uploadCandidate() {
  const candidateCommit = git("rev-parse", "HEAD");
  git("branch", "-f", "candidate", candidateCommit);
  const path = resolve(config.runtime, `candidate-${runId}.bundle`);
  git("bundle", "create", path, "refs/heads/base", "refs/heads/candidate");
  const bytes = await readFile(path); const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData(); form.append("file", new Blob([bytes]), "candidate.bundle");
  const attached = await api("POST", `/api/companies/${config.companyId}/issues/${config.integrationMode ? issueId : config.rootIssueId}/attachments`, form);
  return { attachmentId: attached.id, candidateCommit, baseCommit: config.baseCommit, expectedSha256 };
}
let summary;
if (coordinationActor) summary = await coordinateFixture({ api, call, config, runId, issueId, agentId, observe });
else if (issueId === config.n6RootIssueId) {
  // Prove B obtains A through its real authenticated API, not hidden fixture candidate IDs.
  const handoff = inspection.n6Handoff; assert(handoff);
  const response = await fetch(`${base}${handoff.downloadPath}`, { headers }); assert(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(createHash("sha256").update(bytes).digest("hex"), handoff.sha256);
  assert.equal(handoff.candidateCommit, inspection.n6Handoff.expectedResult.candidateCommit);
  // This bounded fixture proves dispatch/inspection, not a completed B implementation.
  await writeFile(resolve(config.runtime, "n6-downstream-running"), JSON.stringify({ runId, issueId, missionId: config.n6MissionId, inspection }));
  await observe(async () => {
    try { await readFile(resolve(config.runtime, "n6-finish")); return true; } catch { return false; }
  }, Boolean, "owner bounded downstream observation complete");
  summary = { fixture: "N6 downstream N1 launch", missionId: config.n6MissionId, runId, issueId, inspected: inspection.missionId };
}
else if (config.campaignReview) {
  const subject = inspection.campaignClosure.subject;
  assert.equal(subject.campaignRootMissionId, config.missionId);
  const resultBySource = new Map(subject.results.map(result => [result.sourceId, result]));
  const rows = subject.coverage.map(criterion => {
    const related = resultBySource.get(criterion.criterionId.replace(/^source:/, ""));
    const results = related ? [related] : subject.results;
    const proofIds = [...new Set(results.flatMap(result => [result.proofId, result.completionDocument.revisionId,
      result.completionDocument.bodySha256, result.integratedResultSha256]).concat(subject.priorPublicationSha256s))];
    return { criterionId: criterion.criterionId, sourceSha256: criterion.sourceSha256,
      deliveryOrObligationIds: related ? [related.resultId] : ["transverse:campaign"],
      verification: { environment: "isolated installed campaign fixture",
        method: related ? "Matched the pinned source node to its proof-closed integrated delivery" : "Checked the pinned campaign sources against both proof-closed deliveries and acknowledged publications" },
      result: "satisfied", proofIds, remainder: null };
  });
  summary = { schema: "council-linear-campaign-review-report-v1", campaignRootMissionId: subject.campaignRootMissionId,
    taskId: inspection.campaignClosure.task.taskId, sourceSha256: subject.sourceSha256, mandateSha256: subject.mandateSha256,
    coverageSha256: subject.coverageSha256, resultsSha256: subject.resultsSha256, verdict: "approved", rows };
}
else if (agentId === config.actors.publisher) summary = await publishDelivery({ api, call, config, issueId, runId, git });
else if (inspection.task) {
  inspection = await call({ command: "ordinary-inspect" });
  await writeFile(resolve(config.runtime, `api-${runId}.json`), JSON.stringify({ runId, issueId, agentId, taskId: inspection.task.taskId }));
  const task = inspection.task;
  if (task.kind === "specialist" && inspection.n2.submissions.length === 1 && agentId === config.actors.product) {
    const refusal = await api("POST", "/api/plugins/tools/execute", { tool: "private.paperclip-council:mission-command",
      runContext: { companyId: config.companyId, projectId: config.projectId, agentId, runId },
      parameters: { operation: "command", body: { missionId: config.missionId, command: "ordinary-inspect" } } }, 403);
    await writeFile(resolve(config.runtime, "gateway-refusal.json"), JSON.stringify({ runId, issueId, refusal }));
  }
  if (task.kind === "specialist") {
    const review = inspection.n3.review;
    const slot = review.slots.find(slot => slot.slotId === task.slotId);
    const corrected = (await readFile(resolve(config.repoPath, "alpha.txt"), "utf8")).includes("corrected");
    const findings = slot.perspective === "quality" && !corrected && (!config.delivery || config.feedbackMode && inspection.n5Feedback?.reviewSubmissionId === task.submissionId) ? [{ findingId: randomUUID(), classification: "blocking_defect",
      criterionOrRisk: "Alpha must contain corrected marker", evidenceRefs: [`git:${review.subject.candidateCommit}:alpha.txt`],
      evidenceLimits: ["Deterministic fixture opinion; model judgment not qualified"], consequence: "The required marker is absent", recommendedAction: "Correct alpha.txt once" }] : [];
    const opinion = { opinionId: randomUUID(), slotId: task.slotId, subject: review.subject,
      outcome: findings.length ? "changes_requested" : "support", rationale: findings.length ? "V1 lacks the required marker" : `${slot.perspective} fixture checks support this exact candidate`, findings, unresolvedQuestions: [] };
    const rejected = await api("POST", route, { missionId: config.missionId, command: "n3-opinion", commandId: randomUUID(), expectedVersion: inspection.version,
      opinion: { ...opinion, subject: { ...review.subject, evidenceRevision: review.subject.evidenceRevision + 1 } } }, 409);
    assert.equal(rejected.code, "stale_n3_subject");
    await command("n3-opinion", { opinion });
    summary = { fixture: "ordinary-specialist", taskId: task.taskId, subject: review.subject, opinion };
  } else if (task.kind === "council") {
    const review = inspection.n3.review;
    const defects = review.opinions.flatMap(opinion => opinion.findings).filter(finding => finding.classification !== "deferrable_improvement");
    const synthesis = { subject: review.subject, verdict: defects.length ? "changes_requested" : "approved",
      rationale: defects.length ? "The exact candidate has an upheld blocking quality defect; one correction is required" : "Both independent specialist opinions support the corrected candidate, with no unresolved material objection",
      dispositions: defects.map(finding => ({ findingId: finding.findingId, disposition: "upheld_with_correction", reason: "The cited file lacks the mandate marker", evidenceRefs: finding.evidenceRefs })) };
    const prepared = await command("ordinary-verdict", { synthesis });
    summary = prepared.finishReport;
    // Report exists during a running CLI process; product must not accept or launch correction yet.
    await writeFile(resolve(config.runtime, `council-${task.taskId}.prepared.json`), JSON.stringify({ runId, issueId, summary }));
    if (config.n6 && (summary.verdict === "approved" || config.coordination)) await observe(async () => {
      try { await readFile(resolve(config.runtime, "n6-gate-configured")); return true; } catch { return false; }
    }, Boolean, "N6 downstream durable wait prepared");
    await new Promise(r => setTimeout(r, 400));
  } else {
    assert.equal(task.kind, "correction");
    if (config.delivery && !config.feedbackMode) await rebindDeliveryPlan({ api, call, config });
    await writeFile(resolve(config.repoPath, "alpha.txt"), "alpha corrected\n");
    git("add", "alpha.txt"); git("commit", "--amend", "-m", "fixture: bounded correction");
    const candidate = await uploadCandidate();
    await command("prepare-resubmission", { ...candidate, submissionId: randomUUID(), correctedPaths: ["alpha.txt"] });
    summary = { fixture: "ordinary-correction", taskId: task.taskId, candidateCommit: candidate.candidateCommit };
  }
} else if (agentId === config.actors.lead && config.prePlanResume && await writeFile(resolve(config.runtime, "preplan-first-terminal"), runId, { flag: "wx" })
  .then(() => true, error => { if (error.code === "EEXIST") return false; throw error; })) {
  summary = { fixture: "Terminal lead before any plan; explicit resume required", runId, issueId };
} else if (agentId === config.actors.lead && config.integrationMode && inspection.n1.integration?.runId === runId) {
  git("commit", "--allow-empty", "-m", "fixture final leaf integration");
  const candidate = await uploadCandidate();
  await command("publish", candidate);
  summary = { fixture: "N1 admitted final integration", candidateCommit: candidate.candidateCommit };
} else if (agentId === config.actors.lead) {
  const contributions = inspection.n1.hierarchy?.leaves ?? ["alpha", "beta"].map(name => ({ contributionId: randomUUID(), assigneeAgentId: config.actors[name], title: name, ownedPaths: [`${name}.txt`] }));
  if (config.campaignMode) {
    assert.equal(contributions.length, 1, "A campaign leaf mission owns exactly one planned contribution");
    assert.equal(inspection.n1.contributions.length, 0, "Campaign work branch is initialized only for a fresh leaf plan");
    const baseCommit = git("rev-parse", "main");
    git("checkout", "-B", `campaign-${config.missionId}`, baseCommit);
    git("branch", "-f", "base", baseCommit);
    config = { ...config, baseCommit };
  }
  if (config.leadCommandBlock) {
    assert.equal(inspection.n1.leadCommands.protocol, "council-lead-commands-v1");
    execFileSync("bash", ["-c", inspection.n1.leadCommands.shell], { cwd: config.repoPath,
      env: { ...process.env, COUNCIL_LEAD_OPERATION: "plan" }, encoding: "utf8", timeout: 60000 });
    for (let index = 1; index <= contributions.length; index++) {
      const fresh = await call({ command: "inspect" });
      execFileSync("bash", ["-c", fresh.n1.leadCommands.shell], { cwd: config.repoPath,
        env: { ...process.env, COUNCIL_LEAD_OPERATION: "materialize", COUNCIL_LEAD_INPUT: String(index) }, encoding: "utf8", timeout: 60000 });
    }
  } else {
    await command("plan", { contributions, ...(config.completionMode ? { sourceBaseCommit: config.baseCommit } : {}) });
    for (const slot of contributions) await command("materialize", { contributionId: slot.contributionId });
  }
  if (config.integrationMode) summary = { fixture: "N1 one existing code leaf planned/materialized; native driver continues" };
  else {
  for (const slot of contributions) {
    const dispatched = await command("dispatch", { contributionId: slot.contributionId, reservationId: randomUUID(), requestedUnits: 1000 });
    const item = dispatched.mission.aggregate.n1.contributions.find(item => item.contributionId === slot.contributionId);
    const run = await observe(() => api("GET", `/api/heartbeat-runs/${item.dispatchRunId}`), run => !["queued", "running"].includes(run.status), "child terminal");
    assert.equal(run.status, "succeeded", run.error);
    const body = { command: "reconcile-usage", commandId: randomUUID(), contributionId: slot.contributionId };
    await observe(async () => { try { return await call(body); } catch (e) { if (["g4_usage_unavailable", "g4_run_not_terminal"].includes(e.response?.code)) return null; throw e; } }, Boolean, "child costs");
    await observe(() => api("GET", `/api/issues/${item.childIssueId}`), issue => issue.status === "done", "Council finishes the exact recorded child");
  }
  git("commit", "--allow-empty", "-m", `fixture: integrate ${contributions.length} contributions`);
  const candidate = await uploadCandidate();
  await command("publish", candidate);
  summary = { fixture: "N1 real CLI prerequisite", candidateCommit: candidate.candidateCommit };
  }
} else {
  const name = Object.entries(config.actors).find(([name, id]) => ["alpha", "beta", "gamma"].includes(name) && id === agentId)?.[0];
  assert(name);
  if (config.hierarchyCount) {
    const guidance = await api("GET", `/api/issues/${issueId}/documents/council-execution-${config.missionId}`);
    assert(guidance.body.includes("record-contribution"));
  }
  await writeFile(resolve(config.repoPath, `${name}.txt`), `${name} contribution\n`);
  git("add", `${name}.txt`); git("commit", "-m", `fixture: ${name} contribution`);
  const slot = inspection.n1.participants.find(slot => slot.assigneeAgentId === agentId);
  if (config.completionMode) {
    const { contributionCommand } = await import(new URL("file://" + resolve(config.councilRepository, "dist/contribution-command.js")));
    execFileSync("bash", ["-c", contributionCommand(config.missionId, slot.contributionId)], { cwd: config.repoPath, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
    const held = await api("GET", `/api/issues/${issueId}`);
    assert.equal(held.status, "blocked");
    await writeFile(resolve(config.runtime, `child-proof-${runId}.json`), JSON.stringify({ runId, issueId, statusWhileRunning: held.status }));
  } else await command("record-contribution", { contributionId: slot.contributionId, commit: git("rev-parse", "HEAD") });
  summary = { fixture: "N1 real CLI contribution", name };
}
console.log(JSON.stringify({ type: "thread.started", thread_id: randomUUID() }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(summary) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }));
