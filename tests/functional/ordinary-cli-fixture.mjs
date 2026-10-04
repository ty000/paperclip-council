#!/usr/bin/env node
// Sole model seam: deterministic CLI output and content; all business calls use installed APIs.
import { publishDelivery, rebindDeliveryPlan } from "./ordinary-delivery-fixture.mjs";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const config = JSON.parse(await readFile(process.env.COUNCIL_ORDINARY_FIXTURE, "utf8"));
const base = process.env.PAPERCLIP_API_URL;
assert.equal(new URL(base).hostname, "127.0.0.1");
const issueId = process.env.PAPERCLIP_TASK_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const runId = process.env.PAPERCLIP_RUN_ID;
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
const call = body => api("POST", route, { missionId: issueId === config.n6RootIssueId ? config.n6MissionId : config.missionId, ...body });
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
const inspectCommand = agentId === config.actors.publisher ? "n5-inspect" : "inspect";
let inspection = await observe(async () => { try { return await call({ command: inspectCommand }); }
  catch (e) { if (["root_dispatch_run_mismatch", "dispatch_run_mismatch"].includes(e.response?.code)) return null; throw e; } }, Boolean, "dispatch binding");
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
  const attached = await api("POST", `/api/companies/${config.companyId}/issues/${config.rootIssueId}/attachments`, form);
  return { attachmentId: attached.id, candidateCommit, baseCommit: config.baseCommit, expectedSha256 };
}
let summary;
if (issueId === config.n6RootIssueId) {
  // This bounded fixture proves dispatch/inspection, not a completed B implementation.
  await writeFile(resolve(config.runtime, "n6-downstream-running"), JSON.stringify({ runId, issueId, missionId: config.n6MissionId, inspection }));
  await observe(async () => {
    try { await readFile(resolve(config.runtime, "n6-finish")); return true; } catch { return false; }
  }, Boolean, "owner bounded downstream observation complete");
  summary = { fixture: "N6 downstream N1 launch", missionId: config.n6MissionId, runId, issueId, inspected: inspection.missionId };
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
    const findings = slot.perspective === "quality" && !corrected && !config.delivery ? [{ findingId: randomUUID(), classification: "blocking_defect",
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
    if (config.n6 && summary.verdict === "approved") await observe(async () => {
      try { await readFile(resolve(config.runtime, "n6-gate-configured")); return true; } catch { return false; }
    }, Boolean, "N6 downstream durable wait prepared");
    await new Promise(r => setTimeout(r, 400));
  } else {
    assert.equal(task.kind, "correction");
    if (config.delivery) await rebindDeliveryPlan({ api, call, config });
    await writeFile(resolve(config.repoPath, "alpha.txt"), "alpha corrected\n");
    git("add", "alpha.txt"); git("commit", "--amend", "-m", "fixture: bounded correction");
    const candidate = await uploadCandidate();
    await command("prepare-resubmission", { ...candidate, submissionId: randomUUID(), correctedPaths: ["alpha.txt"] });
    summary = { fixture: "ordinary-correction", taskId: task.taskId, candidateCommit: candidate.candidateCommit };
  }
} else if (agentId === config.actors.lead) {
  const contributions = ["alpha", "beta"].map(name => ({ contributionId: randomUUID(), assigneeAgentId: config.actors[name], title: name, ownedPaths: [`${name}.txt`] }));
  await command("plan", { contributions });
  for (const slot of contributions) await command("materialize", { contributionId: slot.contributionId });
  for (const slot of contributions) {
    const dispatched = await command("dispatch", { contributionId: slot.contributionId, reservationId: randomUUID(), requestedUnits: 1000 });
    const item = dispatched.mission.aggregate.n1.contributions.find(item => item.contributionId === slot.contributionId);
    const run = await observe(() => api("GET", `/api/heartbeat-runs/${item.dispatchRunId}`), run => !["queued", "running"].includes(run.status), "child terminal");
    assert.equal(run.status, "succeeded", run.error);
    const body = { command: "reconcile-usage", commandId: randomUUID(), contributionId: slot.contributionId };
    await observe(async () => { try { return await call(body); } catch (e) { if (["g4_usage_unavailable", "g4_run_not_terminal"].includes(e.response?.code)) return null; throw e; } }, Boolean, "child costs");
    await observe(() => api("GET", `/api/issues/${item.childIssueId}`), issue => issue.status === "done", "owner closes prerequisite child");
  }
  git("commit", "--allow-empty", "-m", "fixture: integrate two contributions");
  const candidate = await uploadCandidate();
  await command("publish", candidate);
  summary = { fixture: "N1 real CLI prerequisite", candidateCommit: candidate.candidateCommit };
} else {
  const name = agentId === config.actors.alpha ? "alpha" : "beta";
  await writeFile(resolve(config.repoPath, `${name}.txt`), `${name} contribution\n`);
  git("add", `${name}.txt`); git("commit", "-m", `fixture: ${name} contribution`);
  const slot = inspection.n1.participants.find(slot => slot.assigneeAgentId === agentId);
  await command("record-contribution", { contributionId: slot.contributionId, commit: git("rev-parse", "HEAD") });
  summary = { fixture: "N1 real CLI contribution", name };
}
console.log(JSON.stringify({ type: "thread.started", thread_id: randomUUID() }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(summary) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }));
