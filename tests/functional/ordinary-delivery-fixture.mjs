import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function rebindDeliveryPlan({ api, call, config }) {
  const inspected = await call({ command: "ordinary-inspect" });
  assert(inspected.n2.correction.runId);
  const doc = await api("GET", `/api/issues/${config.rootIssueId}/documents/plan`);
  const plan = JSON.parse(doc.body); plan.work[0].evidenceRefs.push("fixture:post-publication-correction");
  const next = await api("PUT", `/api/issues/${config.rootIssueId}/documents/plan`, { format: "markdown", body: JSON.stringify(plan), baseRevisionId: doc.latestRevisionId });
  await call({ command: "n5-rebind-plan", commandId: randomUUID(), expectedVersion: inspected.version,
    planRevisionId: next.latestRevisionId, reason: "Attach the bounded post-publication correction to the same delegated plan" });
}

async function preflightPublicationClaim({ view, p, call, config, issueId, runId }) {
  const claim = { command: "n5-claim-publication", commandId: randomUUID(), expectedVersion: view.version };
  if (view.delivery.authority.publisherPreflight) {
    let denied;
    try { await call({ ...claim, commandId: randomUUID() }); }
    catch (error) { denied = error.response?.code; }
    assert.equal(denied, "n5_publisher_preflight_required");
    const refusalView = await call({ command: "n5-inspect" });
    assert.equal(refusalView.delivery.publication.claimedAt, undefined);
    claim.expectedVersion = refusalView.version;
    // Explicitly simulated GitHub access in this deterministic transport. The
    // installed plugin still verifies real run/intent/candidate attribution.
    claim.preflight = { protocol: "publisher-run-report-v1", provenance: "publisher_run_report", status: "pass",
      missionId: config.missionId, intentId: p.intentId, issueId, runId,
      repository: view.delivery.authority.repository, candidateCommit: p.submission.candidateCommit,
      baseCommit: p.submission.baseCommit, baseRef: view.delivery.authority.baseRef, headRef: view.delivery.authority.headRef,
      remoteHead: p.operation === "update" ? view.delivery.continuation.previousPublication.submission.candidateCommit : null,
      observedAt: new Date().toISOString(), publicationWriteObserved: false, providerTurnsStartedByProbe: 0,
      checks: Object.fromEntries(["gitTool", "ghTool", "workspaceIdentity", "localCandidate", "originIdentity", "trackedFilesClean", "repositoryRead", "pushPermissionReported", "remoteBase", "remoteHeadLease"].map(key => [key, true])) };
  }
  return claim;
}

export async function publishDelivery({ api, call, config, issueId, runId, git }) {
  let view = await call({ command: "n5-inspect" });
  const p = view.delivery.publication;
  assert.equal(git("rev-parse", "HEAD"), p.submission.candidateCommit);
  const claim = await preflightPublicationClaim({ view, p, call, config, issueId, runId });
  assert.equal((await call(claim)).effectPermission, "execute");
  assert.equal((await call(claim)).effectPermission, "none");
  if (view.delivery.authority.publisherPreflight) {
    const accepted = await call({ command: "n5-inspect" });
    assert.equal(accepted.delivery.publication.preflight.runId, runId);
    assert.equal(accepted.delivery.publication.preflight.provenance, "publisher_run_report");
  }
  const path = resolve(config.runtime, "github-transport.json");
  const remote = JSON.parse(await readFile(path, "utf8"));
  assert(!remote.intents.includes(p.intentId));
  if (p.operation === "update") { assert.equal(p.targetUrl, remote.url); assert.equal(remote.createCount, 1); remote.updateCount++; }
  else { assert.equal(remote.createCount, 0); remote.createCount++; }
  remote.headSha = p.submission.candidateCommit; remote.headRef = view.delivery.authority.headRef; remote.intents.push(p.intentId);
  // This file is the explicitly simulated GitHub publication transport, after the real one-shot claim.
  await writeFile(path, JSON.stringify(remote));
  await api("POST", `/api/issues/${issueId}/work-products`, { type: "pull_request", provider: "github", title: "Simulated ordinary delivery", url: remote.url, createdByRunId: runId });
  await api("PUT", `/api/issues/${issueId}/documents/delivery`, { format: "markdown", title: "Delivery", body: JSON.stringify({ intentId: p.intentId, url: remote.url, link: `<${remote.url}>` }) });
  const objects = await api("GET", `/api/issues/${issueId}/external-objects`);
  const objectId = objects.find(entry => entry.object.providerKey === "github").object.id;
  const refresh = await api("POST", `/api/issues/${issueId}/external-objects/refresh`, { objectIds: [objectId] });
  view = await call({ command: "n5-inspect" });
  const body = { command: "n5-observe-delivery", commandId: randomUUID(), expectedVersion: view.version,
    checks: { headSha: remote.headSha, state: "passed", evidenceRefs: ["fixture:exact-head-check"] },
    reviews: { headSha: remote.headSha, state: "approved", evidenceRefs: ["fixture:exact-head-review"] } };
  let observation;
  try { observation = await call(body); }
  catch (error) {
    assert.equal(p.operation, "update"); assert.equal(error.response?.code, "n5_readback_unqualified");
    observation = { retained: error.response.code };
  }
  view = await call({ command: "n5-inspect" });
  assert.equal(view.delivery.ready, false, "An active publisher cannot finish delivery accounting");
  await writeFile(resolve(config.runtime, `publisher-${runId}.json`), JSON.stringify({ runId, issueId, intentId: p.intentId, operation: p.operation, url: remote.url, headSha: remote.headSha, objectId, refresh, observation, readyWhileRunning: view.delivery.ready }));
  return { fixture: "ordinary publisher", operation: p.operation, url: remote.url, headSha: remote.headSha };
}
