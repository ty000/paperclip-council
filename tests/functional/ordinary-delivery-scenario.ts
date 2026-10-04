import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalPayloadHash } from "../../src/missions.js";

export async function installOrdinaryGitHubTransport(runtime: string, proof: any) {
  const remotePath = resolve(runtime, "github-transport.json");
  await writeFile(remotePath, JSON.stringify({ url: "https://github.com/ty000/paperclip-council/pull/4242", headSha: "", createCount: 0, updateCount: 0, intents: [] }));
  const original = globalThis.fetch;
  proof.githubTransportCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.github.com/")) {
      assert.equal(url, "https://api.github.com/repos/ty000/paperclip-council/pulls/4242");
      const remote = JSON.parse(await readFile(remotePath, "utf8"));
      proof.githubTransportCalls.push({ url, headSha: remote.headSha, at: new Date().toISOString() });
      return new Response(JSON.stringify({ number: 4242, state: "open", draft: false, title: "Simulated GitHub transport",
        head: { sha: remote.headSha, ref: "codex/n5-fixture" }, base: { ref: "main" }, updated_at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Qualification forbids unsimulated outbound fetch");
    return original(input, init);
  };
  return () => { globalThis.fetch = original; };
}

export async function prepareOrdinaryDelivery(input: any) {
  const { api, companyId, actors, rootIssueId, missionPath, runtime, proof, save } = input;
  const get = async () => api("GET", `${missionPath}?companyId=${companyId}`);
  const settings = await api("GET", "/api/instance/settings/experimental");
  await api("PATCH", "/api/instance/settings/experimental", { ...settings, enableExternalObjects: true });
  const mission = (await get()).mission;
  const plan = { missionId: mission.missionId, mandateHash: canonicalPayloadHash(mission.aggregate.mandate),
    plannerAgentId: actors.lead, orchestratorAgentId: actors.lead, integrationLeadAgentId: actors.lead, qaAgentId: actors.quality,
    work: ["alpha", "beta"].map(name => ({ assigneeAgentId: actors[name], sourceRefs: [`prepared:${name}`], ownedPaths: [`${name}.txt`],
      dependencies: [], evidenceRefs: [`git:${name}`], skills: ["native-git"], interface: "Complementary attributed candidate text" })) };
  const doc = await api("PUT", `/api/issues/${rootIssueId}/documents/plan`, { format: "markdown", body: JSON.stringify(plan), title: "Ordinary operational plan" });
  await api("POST", `${missionPath}/commands`, { companyId, command: "configure-delivery", commandId: randomUUID(), expectedVersion: mission.version,
    planRevisionId: doc.latestRevisionId, publisherAgentId: actors.publisher, repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/n5-fixture" });
  let correctionRequested = false;
  return {
    async advance(m: any) {
      if (correctionRequested || !m.aggregate.n5.publication?.settledAt) return;
      correctionRequested = true;
      assert.equal(m.aggregate.n2.correctionsUsed, 0);
      assert.equal(m.aggregate.n2.rounds[0].verdict.verdict, "approved");
      const body = { companyId, command: "request-delivery-correction", commandId: randomUUID(), reservationId: randomUUID(), expectedVersion: m.version,
        reason: "Post-publication check requests the bounded alpha correction marker", criteria: ["alpha.txt contains corrected"] };
      const claimed = await api("POST", `${missionPath}/commands`, body);
      assert.equal(claimed.effectPermission, "execute");
      const replay = await api("POST", `${missionPath}/commands`, body);
      assert.equal(replay.effectPermission, "none");
      const beforeRoot = await api("GET", `/api/issues/${rootIssueId}`);
      assert.match(beforeRoot.description, /n5-rebind-plan/); assert.match(beforeRoot.description, /alpha.txt contains corrected/);
      const action = claimed.nativeAction;
      await api(action.method, action.path, action.body);
      proof.ownerResume = { commandId: body.commandId, reservationId: body.reservationId, action, replayPermission: replay.effectPermission,
        rootBefore: beforeRoot, historicalPublication: claimed.mission.aggregate.n5.continuation.previousPublication };
      await save();
    },
    complete: (m: any) => Boolean(m.aggregate.n5.continuation?.updateAdmitted && m.aggregate.n5.publication?.settledAt),
    async finish() {
      let view = await get(); const n5 = view.mission.aggregate.n5; const p = n5.publication;
      assert.equal(p.operation, "update"); assert(p.settledAt);
      proof.publishers = await Promise.all((await readdir(runtime)).filter(name => name.startsWith("publisher-")).map(async name => JSON.parse(await readFile(resolve(runtime, name), "utf8"))));
      assert.equal(proof.publishers.length, 2);
      const update = proof.publishers.find((r: any) => r.operation === "update");
      assert.equal(update.observation.retained, "n5_readback_unqualified");
      assert.equal(view.n5.ready, false);
      const objects = await api("GET", `/api/issues/${p.issueId}/external-objects`);
      const object = objects.find((entry: any) => entry.object.id === update.objectId).object;
      const waitUntil = Date.parse(object.nextRefreshAt) + 50;
      assert(waitUntil - Date.now() <= 301000);
      proof.nativeBackoff = { objectId: object.id, oldHead: object.data.headSha, nextRefreshAt: object.nextRefreshAt, waitStartedAt: new Date().toISOString() };
      await save();
      while (Date.now() < waitUntil) await new Promise(r => setTimeout(r, Math.min(10000, waitUntil - Date.now())));
      const refreshed = await api("POST", `/api/issues/${p.issueId}/external-objects/refresh`, { objectIds: [object.id] });
      const remote = JSON.parse(await readFile(resolve(runtime, "github-transport.json"), "utf8"));
      const reconcile = { companyId, command: "reconcile-delivery", checks: { headSha: remote.headSha, state: "passed", evidenceRefs: ["fixture:post-terminal-updated-head-check"] },
        reviews: { headSha: remote.headSha, state: "approved", evidenceRefs: ["fixture:post-terminal-updated-head-review"] } };
      await api("POST", `${missionPath}/commands`, reconcile);
      view = await get(); assert.equal(view.n5.ready, true);
      assert.equal(view.n5.publication.observation.url, n5.continuation.previousPublication.observation.url);
      assert.notEqual(view.n5.publication.observation.headSha, n5.continuation.previousPublication.observation.headSha);
      assert.equal(remote.createCount, 1); assert.equal(remote.updateCount, 1); assert.equal(view.mission.aggregate.n2.correctionsUsed, 1);
      assert.equal(view.mission.aggregate.n5.planHistory.length, 1);
      assert(view.mission.aggregate.n2.rounds.every((r: any) => r.verdict.verdict === "approved"));
      await api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-delivery" });
      proof.publisherIssues = await Promise.all([n5.continuation.previousPublication.issueId, p.issueId].map(id => api("GET", `/api/issues/${id}`)));
      assert(proof.publisherIssues.every((issue: any) => issue.status === "done" && issue.parentId === rootIssueId && !issue.executionPolicy && !issue.executionState));
      const correction = view.mission.aggregate.n2.ordinary.tasks.find((task: any) => task.kind === "correction");
      const resumedRun = await api("GET", `/api/heartbeat-runs/${correction.runId}`);
      assert.equal(resumedRun.contextSnapshot.resumeIntent, true); assert.equal(resumedRun.contextSnapshot.issueId, rootIssueId);
      assert.equal(resumedRun.agentId, actors.lead); assert.equal(resumedRun.status, "succeeded");
      proof.ownerResume.run = resumedRun;
      proof.delivery = { refreshed, remote, final: view.n5, checks: { samePr: "PASS", changedHead: "PASS", oneCumulativeCorrection: "PASS", readyAfterSettlementAndFreshReadback: "PASS" } };
    },
  };
}
