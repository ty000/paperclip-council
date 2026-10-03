import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalPayloadHash } from "../../src/missions.js";

export const continuationMode = process.env.COUNCIL_N5_CONTINUATION === "1";

export function continuationScenario(input: any, prepared: any, readMission: any, guards: any[], github: any) {
  const { request } = input;
  return {
    async advance(mission: any) {
      if (!continuationMode || mission.aggregate.n5.continuation || !mission.aggregate.n5.publication?.settledAt) return;
      const body = { companyId: prepared.companyId, command: "request-delivery-correction", commandId: randomUUID(), reservationId: randomUUID(),
        expectedVersion: mission.version, reason: "Deterministic post-publication check discovered missing alpha correction marker", criteria: ["alpha.txt contains the independent correction marker"] };
      const result = await request("human", "POST", `${prepared.missionPath}/commands`, body);
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.effectPermission, "execute");
      const replay = await request("human", "POST", `${prepared.missionPath}/commands`, body);
      assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.effectPermission, "none");
      assert.equal(result.body.mission.aggregate.n2.correctionsUsed, 1);
      assert.deepEqual(result.body.mission.aggregate.n2.rounds, mission.aggregate.n2.rounds);
      const beforeRoot = await request("human", "GET", `/api/issues/${prepared.rootIssueId}`);
      const action = result.body.nativeAction;
      const resumed = await request("human", action.method, action.path, action.body);
      assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      const afterRoot = await request("human", "GET", `/api/issues/${prepared.rootIssueId}`);
      guards.push({ ownerResume: { command: body.commandId, reservationId: body.reservationId, action, status: resumed.status, nativeStatus: resumed.body.status,
        workspaceBoundary: { profile: "shared_workspace/project_primary", before: workspaceObservation(beforeRoot.body), after: workspaceObservation(afterRoot.body), reconstructionClaim: false },
        historicalApplication: result.body.mission.aggregate.n5.continuation.previousApplication, replayPermission: replay.body.effectPermission } });
    },
    async rebind(actor: string, call: any) {
      if (!continuationMode) return;
      const current = (await readMission()).body.mission;
      const old = await request(actor, "GET", `/api/issues/${prepared.rootIssueId}/documents/plan`);
      assert.equal(old.status, 200, JSON.stringify(old.body)); const doc = old.body.document ?? old.body;
      const plan = JSON.parse(doc.body); plan.work[0].evidenceRefs.push("fixture:post-publication-check");
      const edited = await request(actor, "PUT", `/api/issues/${prepared.rootIssueId}/documents/plan`, { format: "markdown", body: JSON.stringify(plan), baseRevisionId: doc.latestRevisionId });
      assert.equal(edited.status, 200, JSON.stringify(edited.body)); const next = edited.body.document ?? edited.body;
      const rebound = await call({ command: "n5-rebind-plan", commandId: randomUUID(), expectedVersion: current.version,
        planRevisionId: next.latestRevisionId, reason: "Attach the post-publication finding to the same authorized work" });
      assert.deepEqual(rebound.mission.aggregate.n5.authority, current.aggregate.n5.authority);
      assert.equal(rebound.mission.aggregate.n5.planHistory.length, 1);
      guards.push({ planRebind: { oldRevision: doc.latestRevisionId, newRevision: next.latestRevisionId, authorityUnchanged: true } });
    },
    async afterFinish() {
      const current = (await readMission()).body.mission; const n5 = current.aggregate.n5; const p = n5.publication;
      assert.equal(p.operation, "update"); assert(p.settledAt); assert.equal(github.createCount, 1); assert.equal(github.updateCount, 1);
      assert.equal(current.aggregate.n2.correctionsUsed, 1); assert.equal(current.aggregate.n2.rounds.length, 2);
      assert(current.aggregate.n2.rounds.every((round: any) => round.verdict?.verdict === "approved"), JSON.stringify(current.aggregate.n2.rounds));
      const old = n5.continuation.previousPublication;
      const objects = await request("human", "GET", `/api/issues/${p.issueId}/external-objects`);
      const object = objects.body.find((entry: any) => entry.object.providerKey === "github").object;
      const waitMs = Math.max(0, Date.parse(object.nextRefreshAt) - Date.now() + 30);
      assert(waitMs <= 301_000); guards.push({ waitingForNativeRefresh: { nextRefreshAt: object.nextRefreshAt, waitMs, publisherFinished: true } }); await input.save();
      await new Promise(resolve => setTimeout(resolve, waitMs));
      const refreshed = await request("human", "POST", `/api/issues/${p.issueId}/external-objects/refresh`, { objectIds: [object.id] });
      assert.equal(refreshed.body.refreshed[0].refreshed, true, JSON.stringify(refreshed.body));
      const readback = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId, command: "reconcile-delivery",
        checks: { headSha: github.headSha, state: "passed", evidenceRefs: ["fixture:updated-head-checks"] },
        reviews: { headSha: github.headSha, state: "approved", evidenceRefs: ["fixture:updated-head-review"] } });
      assert.equal(readback.status, 200, JSON.stringify(readback.body));
      const final = (await readMission()).body;
      assert.equal(final.n5.ready, true, JSON.stringify(final.n5)); assert.equal(final.n5.publication.observation.url, old.observation.url);
      assert.notEqual(final.n5.publication.observation.headSha, old.observation.headSha);
      assert.deepEqual(final.n5.continuation.previousPublication, old);
      const exhausted = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId, command: "request-delivery-correction",
        commandId: randomUUID(), reservationId: randomUUID(), expectedVersion: final.mission.version, reason: "Another correction", criteria: ["Another change"] });
      assert.equal(exhausted.body.code, "correction_limit_exceeded", JSON.stringify(exhausted.body));
      assert.equal(canonicalPayloadHash((await readMission()).body.mission.aggregate), canonicalPayloadHash(final.mission.aggregate));
      guards.push({ continuationComplete: { samePr: final.n5.publication.observation.url, oldHead: old.observation.headSha,
        newHead: final.n5.publication.observation.headSha, ready: true, createCount: github.createCount, updateCount: github.updateCount, exhausted: exhausted.body.code } });
    },
  };
}

function workspaceObservation(issue: any) {
  return { id: issue.executionWorkspaceId ?? null, rootStatus: issue.status, workspaceStatus: issue.currentExecutionWorkspace?.status ?? null };
}
