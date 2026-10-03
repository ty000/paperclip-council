import { continuationMode, continuationScenario } from "./n5-continuation-scenario.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalPayloadHash } from "../../src/missions.js";

/** Only the external GitHub boundary is simulated; host detection/refresh/storage/HTTP remain real. */
export const fakeN5GitHub = { headSha: "", calls: [] as string[], createCount: 0, updateCount: 0,
  async fetch(url: string) {
    this.calls.push(url);
    assert.match(url, /^https:\/\/api\.github\.com\/repos\/ty000\/paperclip-council\/pulls\/4242$/);
    return new Response(JSON.stringify({ number: 4242, state: "open", draft: false, title: "Explicit deterministic fake GitHub PR",
      head: { sha: this.headSha, ref: "codex/n5-fixture" }, base: { ref: "main" }, updated_at: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
  },
};

export async function prepareN5Scenario(input: any, prepared: any) {
  const { request, agentTokens } = input;
  const actor = "n5-publisher"; const guards: any[] = [];
  const settings = await request("human", "GET", "/api/instance/settings/experimental");
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  const enabled = await request("human", "PATCH", "/api/instance/settings/experimental", { ...settings.body, enableExternalObjects: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  guards.push({ ephemeralInstanceExternalObjectsEnabled: enabled.body.enableExternalObjects });
  const created = await request("human", "POST", `/api/companies/${prepared.companyId}/agents`, { name: "N5 authorized publisher", role: "engineer",
    adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "deterministic-test" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } }, budgetMonthlyCents: 0 });
  assert.equal(created.status, 201, JSON.stringify(created.body)); const agent = created.body;
  const key = await request("human", "POST", `/api/agents/${agent.id}/keys`, { name: actor, scope: { kind: "standard" } });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  agentTokens.set(actor, { id: agent.id, agentId: agent.id, companyId: prepared.companyId, token: key.body.token, runId: "" });
  const readMission = () => request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`);
  const initial = (await readMission()).body.mission;
  const plan = { missionId: initial.missionId, mandateHash: canonicalPayloadHash(initial.aggregate.mandate),
    plannerAgentId: prepared.agents.lead.id, orchestratorAgentId: prepared.agents.lead.id, integrationLeadAgentId: prepared.agents.lead.id,
    qaAgentId: prepared.agents.reviewer.id,
    work: ["alpha", "beta"].map(name => ({ assigneeAgentId: prepared.agents.lead.id, sourceRefs: [`prepared:${name}`], ownedPaths: [`${name}.txt`],
      dependencies: [], evidenceRefs: [`git:${name}`], skills: ["native-git"], interface: "Two complementary text inputs form the integrated candidate" })) };
  const document = await request("human", "PUT", `/api/issues/${prepared.rootIssueId}/documents/plan`, { format: "markdown", body: JSON.stringify(plan), title: "Native N5 operational plan" });
  assert.equal(document.status, 201, JSON.stringify(document.body));
  const doc = document.body.document ?? document.body;
  const configure = { companyId: prepared.companyId, command: "configure-delivery", commandId: randomUUID(), expectedVersion: initial.version,
    planRevisionId: randomUUID(), publisherAgentId: agent.id, repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/n5-fixture" };
  const stale = await request("human", "POST", `${prepared.missionPath}/commands`, configure);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  const configured = await request("human", "POST", `${prepared.missionPath}/commands`, { ...configure, commandId: randomUUID(), planRevisionId: doc.latestRevisionId });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  guards.push({ stalePlan: stale.body.code, documentId: doc.id, planRevisionId: doc.latestRevisionId, configuredVersion: configured.body.mission.version });
  const continuation = continuationScenario(input, prepared, readMission, guards, fakeN5GitHub);
  return { agent, guards, readMission, advance: continuation.advance, rebind: continuation.rebind,
    async afterFinish() {
      if (continuationMode) return continuation.afterFinish();
      const current = (await readMission()).body.mission;
      const p = current.aggregate.n5.publication;
      assert(p.settledAt, "Publisher must finish before late observations");
      const issuePath = `/api/issues/${p.issueId}`;
      fakeN5GitHub.headSha = p.submission.candidateCommit;
      const refresh = await request("human", "POST", `${issuePath}/external-objects/refresh`, { objectIds: [p.observation.objectId] });
      assert.equal(refresh.status, 200, JSON.stringify(refresh.body));
      const late = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId, command: "reconcile-delivery",
        checks: { headSha: fakeN5GitHub.headSha, state: "passed", evidenceRefs: ["fixture:late-checks-after-terminal"] },
        reviews: { headSha: fakeN5GitHub.headSha, state: "approved", evidenceRefs: ["fixture:late-review-after-terminal"] } });
      assert.equal(late.status, 200, JSON.stringify(late.body));
      const after = await readMission(); assert.equal(after.body.n5.ready, true, JSON.stringify(after.body.n5));
      assert(after.body.n5.publication.checks.userId); assert.equal(after.body.n5.publication.checks.runId, null);
      fakeN5GitHub.headSha = "e".repeat(40);
      const nextRefreshAt = refresh.body.refreshed[0].object.nextRefreshAt;
      const waitMs = Math.max(0, Date.parse(nextRefreshAt) - Date.now() + 30);
      assert(waitMs <= 301_000, "Bound native refresh TTL; never bypass host backoff");
      guards.push({ waitingForNativeRefresh: { nextRefreshAt, waitMs, publisherFinished: true } });
      await input.save();
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const refreshed = await request("human", "POST", `${issuePath}/external-objects/refresh`, { objectIds: [p.observation.objectId] });
      assert.equal(refreshed.body.refreshed[0].refreshed, true, JSON.stringify(refreshed.body));
      const mismatch = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId, command: "reconcile-delivery" });
      assert.equal(mismatch.status, 200, JSON.stringify(mismatch.body));
      const divergent = await readMission(); assert.equal(divergent.body.n5.ready, false);
      assert.equal(divergent.body.n5.publication.observation.matchesCandidate, false);
      assert.equal(fakeN5GitHub.createCount, 1);
      assert.equal(canonicalPayloadHash(divergent.body.mission.aggregate.n2), canonicalPayloadHash(current.aggregate.n2));
      guards.push({ afterPublisherTerminal: { runId: p.runId, settledAt: p.settledAt, lateChecks: after.body.n5.publication.checks,
        readinessWithLateObservations: after.body.n5.ready, divergentAfterTerminal: divergent.body.n5.publication.observation, fakeEffectCount: fakeN5GitHub.createCount } });
    },
    async publisher(execution: any) {
      if (execution.binding.agentId !== agent.id) return false;
      const { issueId, runId } = execution.binding;
      agentTokens.set(actor, { ...agentTokens.get(actor), runId });
      const route = `/api/plugins/${input.pluginId}/api/issues/${issueId}/council/commands`;
      const call = (body: any) => request(actor, "POST", route, { missionId: prepared.missionId, ...body });
      let inspected = await call({ command: "n5-inspect" }); assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
      const p = inspected.body.delivery.publication;
      const pre = await call({ command: "n5-observe-delivery", commandId: randomUUID(), expectedVersion: inspected.body.version });
      assert.equal(pre.body.code, "n5_intent_required", JSON.stringify(pre.body));
      const wrongActor = await request("n2-prerequisite-lead", "POST", route, { missionId: prepared.missionId, command: "n5-inspect" });
      assert.equal(wrongActor.status, 403, JSON.stringify(wrongActor.body));
      const body = { command: "n5-claim-publication", commandId: randomUUID(), expectedVersion: inspected.body.version };
      const claimed = await call(body); assert.equal(claimed.status, 200, JSON.stringify(claimed.body)); assert.equal(claimed.body.effectPermission, "execute");
      const replay = await call(body); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.effectPermission, "none");
      const duplicate = await call({ ...body, commandId: randomUUID(), expectedVersion: claimed.body.mission.version });
      assert.equal(duplicate.body.code, "n5_effect_already_claimed");
      const durable = (await readMission()).body.mission.aggregate.n5.publication;
      assert.equal(durable.state, "unknown"); assert.equal(durable.runId, runId);
      if (p.operation === "update") fakeN5GitHub.updateCount++; else fakeN5GitHub.createCount++; // Explicit external-effect fixture, after the installed one-shot claim.
      assert.equal(fakeN5GitHub.createCount, 1); fakeN5GitHub.headSha = p.submission.candidateCommit;
      const url = "https://github.com/ty000/paperclip-council/pull/4242";
      const product = await request(actor, "POST", `/api/issues/${issueId}/work-products`, { type: "pull_request", provider: "github", title: "Explicit fake N5 PR", url, createdByRunId: runId });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      const delivery = await request(actor, "PUT", `/api/issues/${issueId}/documents/delivery`, { format: "markdown", title: "N5 delivery binding", body: JSON.stringify({ intentId: p.intentId, url, link: `<${url}>` }) });
      assert.equal(delivery.status, 201, JSON.stringify(delivery.body));
      const objects = await request(actor, "GET", `/api/issues/${issueId}/external-objects`);
      assert.equal(objects.status, 200, JSON.stringify(objects.body)); const objectId = objects.body.find((entry: any) => entry.object?.providerKey === "github")?.object?.id; assert(objectId, JSON.stringify(objects.body));
      const refresh = async () => {
        const response = await request(actor, "POST", `/api/issues/${issueId}/external-objects/refresh`, { objectIds: [objectId] });
        assert.equal(response.status, 200, JSON.stringify(response.body));
      };
      await refresh();
      inspected = await call({ command: "n5-inspect" });
      const observed = await call({ command: "n5-observe-delivery", commandId: randomUUID(), expectedVersion: inspected.body.version });
      if (p.operation === "update") {
        assert.equal(observed.status, 409, "Prior snapshot cannot prove newly updated head");
        guards.push({ updatePublished: { intentId: p.intentId, targetUrl: p.targetUrl, runId, issueId, oldSnapshotRejected: observed.body.code, replayPermission: replay.body.effectPermission } });
        return true;
      }
      assert.equal(observed.status, 200, JSON.stringify(observed.body));
      inspected = await call({ command: "n5-inspect" }); assert.equal(inspected.body.delivery.ready, false, "Missing checks/reviews cannot be ready");
      const checks = { headSha: fakeN5GitHub.headSha, state: "passed", evidenceRefs: ["deterministic-github-fixture:checks"] };
      const reviews = { headSha: fakeN5GitHub.headSha, state: "approved", evidenceRefs: ["deterministic-github-fixture:review"] };
      const ready = await call({ command: "n5-observe-delivery", commandId: randomUUID(), expectedVersion: inspected.body.version, checks, reviews });
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      inspected = await call({ command: "n5-inspect" }); assert.equal(inspected.body.delivery.ready, true);
      const acceptedHistory = canonicalPayloadHash((await readMission()).body.mission.aggregate.n2);
      // Finish with pending checks; later owner observations use no active model/run.
      const pending = await call({ command: "n5-observe-delivery", commandId: randomUUID(), expectedVersion: inspected.body.version,
        checks: { ...checks, state: "pending" }, reviews: { ...reviews, state: "pending" } });
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
      guards.push({ runId, issueId, intentId: p.intentId, missingIntent: pre.body.code, wrongActor: wrongActor.body.code,
        replayPermission: replay.body.effectPermission, duplicate: duplicate.body.code, persistedUnknown: durable.state,
        nativeReadback: observed.body.mission.aggregate.n5.publication.observation, readyObserved: ready.body.mission.aggregate.n5.publication,
        pendingAtFinish: pending.body.mission.aggregate.n5.publication, acceptedHistorySha256: acceptedHistory, fakeEffectCount: fakeN5GitHub.createCount,
        githubTransportCalls: fakeN5GitHub.calls });
      return true;
    },
  };
}
