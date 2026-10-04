#!/usr/bin/env node
// Deterministic, provider-free Codex JSONL protocol fixture. Never invokes Codex.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const base = process.env.PAPERCLIP_API_URL;
assert(new URL(base).hostname === "127.0.0.1");
const issueId = process.env.PAPERCLIP_TASK_ID;
const runId = process.env.PAPERCLIP_RUN_ID;
const agentId = process.env.PAPERCLIP_AGENT_ID;
const root = process.env.INTERMEDIATE_RUNTIME;
assert(root && root.startsWith("/tmp/council-n2-intermediate-"));
async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`, "x-paperclip-run-id": runId, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  assert(response.ok, `${method} ${path} ${response.status} ${JSON.stringify(value)}`);
  return value;
}
const issue = await api("GET", `/api/issues/${issueId}`);
const task = JSON.parse(issue.description);
const git = (...args) => execFileSync("git", args, { cwd: task.repoPath, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), task.candidateCommit);
await api("POST", `/api/issues/${issueId}/checkout`, { agentId, expectedStatuses: ["todo", "in_progress"] });
const report = { schema: "synthetic-intermediate-report-v1", kind: task.kind, issueId, runId, agentId,
  candidateCommit: task.candidateCommit, syntheticJudgment: true, rationale: "", verdict: null };
if (task.kind === "technical") {
  const code = await readFile(resolve(task.repoPath, "candidate.txt"), "utf8");
  report.verdict = code.includes("V2 corrected") ? "pass" : "correction_required";
  report.rationale = report.verdict === "pass" ? "The candidate now declares the required corrected value; no fixture defect remains." : "The candidate contains the V1 defective value; replace it with V2 corrected in one commit.";
} else if (task.kind === "council") {
  const comments = await api("GET", `/api/issues/${task.reviewIssueId}/comments`);
  const review = comments.map(x => { try { return JSON.parse(x.body); } catch { return null; } })
    .find(x => x?.schema === report.schema && x.kind === "technical");
  assert(review && review.candidateCommit === task.candidateCommit && review.agentId !== agentId);
  report.reviewIssueId = task.reviewIssueId;
  report.reviewRunId = review.runId;
  report.verdict = review.verdict === "pass" ? "accepted" : "changes_requested";
  report.rationale = report.verdict === "accepted" ? "Technical V2 evidence applies to this exact commit and the required correction is present. Accept this candidate." : "Technical V1 evidence identifies an applicable defect on this exact commit. Require one correction before acceptance.";
} else {
  assert.equal(task.kind, "correction");
  await writeFile(resolve(task.repoPath, "candidate.txt"), "V2 corrected\n");
  git("add", "candidate.txt");
  git("commit", "-m", "fixture: correct V1 candidate once");
  report.resultCommit = git("rev-parse", "HEAD");
  assert.notEqual(report.resultCommit, task.candidateCommit);
  report.rationale = "One deterministic developer correction committed to the owned fixture repository.";
}
await api("POST", `/api/issues/${issueId}/comments`, { body: JSON.stringify(report) });
// Intentional handshake: report visible while the process/run and task remain active.
// The owner controller closes the ordinary task only after terminal readback.
await writeFile(resolve(root, `${issueId}.ready.json`), JSON.stringify({ report, argv: process.argv.slice(2), pid: process.pid }));
const deadline = Date.now() + 30000;
while (true) {
  try { await access(resolve(root, `${issueId}.release`)); break; } catch {}
  assert(Date.now() < deadline, "Controller did not release fixture within 30s");
  await new Promise(r => setTimeout(r, 50));
}
console.log(JSON.stringify({ type: "thread.started", thread_id: randomUUID() }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(report) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } }));
