import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { campaignTransportPath } from "./linear-campaign-github.ts";

function canWaitForMerge(error, attempt, deadline) {
  return error.status === 409 && ["linear_continuity_source_pending", "linear_continuity_publication_pending"].includes(error.response?.code)
    && attempt < 5 && deadline - performance.now() > 5000;
}

async function claimMerge(call, claim) {
  const deadline = performance.now() + 30000;
  for (let attempt = 0; attempt < 6; attempt++) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Bounded native claim wait exhausted");
    try { return await call(claim, Math.max(1, Math.floor(remaining))); }
    catch (error) {
      if (!canWaitForMerge(error, attempt, deadline)) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

export async function integrateDelivery({ api, call, config, issueId, runId, git }) {
  let view = await call({ command: "n5-inspect" });
  const p = view.delivery.publication, a = view.delivery.authority;
  const path = config.campaignMode ? campaignTransportPath(config.runtime, config.missionId) : resolve(config.runtime, "github-transport.json");
  const remote = JSON.parse(await readFile(path, "utf8"));
  const report = { protocol: "publisher-integration-report-v1", provenance: "publisher_run_report", companyId: config.companyId,
    missionId: config.missionId, intentId: p.intentId, issueId, runId, observedAt: new Date().toISOString(), repository: a.repository,
    url: p.targetUrl, candidateCommit: p.submission.candidateCommit, baseRef: a.baseRef, baseCommit: p.submission.baseCommit,
    state: "open", integratedCommit: null, baseContainsIntegrated: false, mergeParents: [], checks: [] };
  const feedbackReport = { protocol: "publisher-github-feedback-v1", provenance: "publisher_run_report", missionId: config.missionId,
    intentId: p.intentId, issueId, runId, observedAt: new Date().toISOString(), url: p.targetUrl, repository: a.repository,
    headSha: p.submission.candidateCommit, baseRef: a.baseRef, headRef: a.headRef, draft: false,
    checks: [{ name: "fixture-ci", state: "passed", evidenceUrl: p.targetUrl }],
    reviews: [{ id: 1, author: "fixture-reviewer", headSha: p.submission.candidateCommit, state: "APPROVED", body: "Exact candidate verified",
      url: p.targetUrl + "#pullrequestreview-1", submittedAt: new Date().toISOString() }] };
  const claim = { command: "n5-claim-merge", commandId: randomUUID(), expectedVersion: view.version, integrationReport: report, feedbackReport };
  await writeFile(resolve(config.runtime, `integration-claim-${runId}.json`), JSON.stringify({ missionId: config.missionId, ...claim }), { flag: "wx", mode: 0o600 });
  assert.equal((await claimMerge(call, claim)).effectPermission, "execute");
  assert.equal((await call(claim)).effectPermission, "none");
  assert.equal(remote.mergeCount ?? 0, 0);
  // GitHub alone is simulated. The isolated Git commit really has the candidate tree and pinned base parent.
  const integrated = git("commit-tree", git("rev-parse", p.submission.candidateCommit + "^{tree}"), "-p", p.submission.baseCommit, "-m", "Fixture integrated delivery");
  git("update-ref", "refs/heads/main", integrated, p.submission.baseCommit);
  remote.mergeCount = 1; remote.merged = true; remote.integratedCommit = integrated;
  if (config.campaignMode) remote.baseCommit = p.submission.baseCommit;
  await writeFile(path, JSON.stringify(remote));
  view = await call({ command: "n5-inspect" });
  const mergedReport = { ...report, observedAt: new Date().toISOString(), state: "merged", integratedCommit: integrated,
    baseContainsIntegrated: git("merge-base", integrated, "main") === integrated,
    mergeParents: git("show", "-s", "--format=%P", integrated).split(" "), checks: [{ name: "integrated-ci", state: "passed", evidenceUrl: p.targetUrl }] };
  await call({ command: "n5-observe-integration", commandId: randomUUID(), expectedVersion: view.version, integrationReport: mergedReport });
  assert.equal((await api("GET", `/api/issues/${config.rootIssueId}`)).status, "blocked", "Publisher costs still prevent product closure");
  await writeFile(resolve(config.runtime, `integration-${runId}.json`), JSON.stringify({ claim, report: mergedReport, mergeCount: 1, replayPermission: "none", rootHeld: true }));
  return "Exact simulated merge observed; native settlement remains pending";
}
