import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Extends the installed ordinary fixture only: A is produced by real APIs, B runs a deterministic CLI executable. */
export function prepareN6Scenario(input: { api: (...args: any[]) => Promise<any>; companyId: string; projectId: string;
  actors: Record<string, string>; missions: string; missionPath: string; profile: any; runtime: string; fixtureConfig: string; proof: any }) {
  const { api, companyId, projectId, actors, missions, missionPath, profile, runtime, fixtureConfig, proof } = input;
  let downstreamPath: string | undefined;
  let configured: any;
  const configureId = randomUUID(); const downstreamId = randomUUID();
  async function releaseInspectedRun(run: any) {
    if (proof.n6.ownerStoppedWakes || run?.status !== "running") return;
    let observed: any;
    try { observed = JSON.parse(await readFile(resolve(runtime, "n6-downstream-running"), "utf8")); }
    catch { return; }
    assert.equal(observed.runId, run.id); assert.equal(observed.missionId, downstreamId);
    const agent = await api("PATCH", `/api/agents/${actors.lead}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    assert.equal(agent.runtimeConfig.heartbeat.wakeOnDemand, false);
    proof.n6.ownerStoppedWakes = { at: new Date().toISOString(), runId: run.id, status: run.status, agentId: actors.lead, wakeOnDemand: false, inspection: observed };
    await writeFile(resolve(runtime, "n6-finish"), "owner observed authenticated inspection and disabled subsequent lead wakes");
  }
  async function terminalDownstream(end: number) {
    while (Date.now() < end) {
      const downstream = (await api("GET", `${downstreamPath}?companyId=${companyId}`)).mission;
      const runs = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
      const run = runs.find((r: any) => r.id === downstream.aggregate.n1?.rootDispatchRunId);
      if (run?.status === "succeeded") return { downstream, run };
      assert(!run || ["running", "queued"].includes(run.status), JSON.stringify({ runId: run?.id, status: run?.status, error: run?.error }));
      await releaseInspectedRun(run);
      // Existing owner recovery, same persisted activation/start command identities.
      try { await api("POST", `${downstreamPath}/commands`, { companyId, command: "reconcile-result-dependency" }); }
      catch (error) { assert(String(error).includes('"version_conflict"'), String(error)); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Downstream terminal observation timed out");
  }
  async function settleDownstream(downstream: any, end: number) {
    const body = { companyId, command: "reconcile-lead-usage", commandId: randomUUID(), expectedVersion: downstream.version };
    while (Date.now() < end) {
      try { await api("POST", `${downstreamPath}/commands`, body); return; }
      catch (error) { assert(String(error).includes('"g4_usage_unavailable"'), String(error)); }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Terminal native issue-token summary unavailable under the same settlement command");
  }
  return {
    async advance(source: any) {
      const council = source.aggregate.n2?.ordinary?.tasks.find((task: any) => task.kind === "council" && task.report?.verdict === "approved");
      if (!council || downstreamPath) return;
      assert.equal(source.aggregate.n2.status, "reviewing");
      const root = await api("POST", `/api/companies/${companyId}/issues`, { title: "N6 downstream waits for exact A", projectId, status: "backlog", assigneeAgentId: actors.lead });
      const created = await api("POST", missions, { companyId, command: "create", commandId: randomUUID(), missionId: downstreamId, rootIssueId: root.id, projectId,
        teamRosterId: source.teamRosterId, teamRevision: source.teamRevision, councilRosterId: source.councilRosterId, councilRevision: source.councilRevision,
        mandate: { ...source.aggregate.mandate, objective: "Consume the exact accepted source; bounded N1 launch only" } });
      downstreamPath = `${missions}/${downstreamId}`;
      const config = JSON.parse(await readFile(fixtureConfig, "utf8"));
      await writeFile(fixtureConfig, JSON.stringify({ ...config, n6MissionId: downstreamId, n6RootIssueId: root.id }));
      const body = { companyId, command: "configure-result-dependency", commandId: configureId, expectedVersion: created.mission.version,
        sourceMissionId: source.missionId, expectedResult: council.report.subject, periodKey: profile.periodKey, requestedUnits: 1000 };
      configured = await api("POST", `${downstreamPath}/commands`, body);
      const waiting = await api("GET", `${downstreamPath}?companyId=${companyId}`);
      assert.equal(waiting.n6.state, "waiting"); assert.equal(waiting.mission.aggregate.n1, undefined);
      assert.equal((await api("GET", `/api/issues/${root.id}`)).status, "blocked");
      const before = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
      assert(before.every((run: any) => run.contextSnapshot?.issueId !== root.id));
      const replay = await api("POST", `${downstreamPath}/commands`, body); assert.equal(replay.outcome, "replayed");
      await api("POST", `/api/plugins/${config.pluginId}/upgrade`, {});
      const restarted = await api("GET", `${downstreamPath}?companyId=${companyId}`);
      assert.deepEqual(restarted.mission.aggregate.n6, waiting.mission.aggregate.n6);
      await api("POST", `${downstreamPath}/commands`, { companyId, command: "reconcile-result-dependency" });
      proof.n6 = { sourceMissionId: source.missionId, downstreamId, rootIssueId: root.id, waiting, restarted,
        configurationCommand: body, beforeRunCount: before.length, boundary: "Provider-free: CLI executable/content/usage synthetic; native API/auth/CAS/blockers/admission/heartbeat real. No Codex/provider model invoked." };
      await writeFile(resolve(runtime, "n6-gate-configured"), "release source Council fixture");
    },
    async finish() {
      assert(downstreamPath && configured);
      const end = Date.now() + 60000;
      const { downstream, run } = await terminalDownstream(end);
      assert.equal(run.usageJson.usageSource, "per_run");
      assert(proof.n6.ownerStoppedWakes);
      assert(Date.parse(proof.n6.ownerStoppedWakes.at) <= Date.parse(run.finishedAt));
      const admissionPath = `/api/plugins/${JSON.parse(await readFile(fixtureConfig, "utf8")).pluginId}/api/companies/${companyId}/admission`;
      const envelope = (await api("GET", `${admissionPath}?companyId=${companyId}&periodKey=${profile.periodKey}`)).envelope;
      const reservation = envelope.reservations.find((r: any) => r.reservationId === downstream.aggregate.n6.reservationId);
      assert(Date.parse(reservation.reservedAt) <= Date.parse(run.startedAt));
      proof.n6.terminalRuns = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
      await settleDownstream(downstream, end);
      await api("PATCH", `/api/issues/${downstream.rootIssueId}`, { status: "done" });
      const before = (await api("GET", `/api/companies/${companyId}/heartbeat-runs`)).length;
      await api("POST", `${downstreamPath}/commands`, { companyId, command: "reconcile-result-dependency" });
      const after = await api("GET", `/api/companies/${companyId}/heartbeat-runs`); assert.equal(after.length, before);
      const guard = await api("GET", `/api/issues/${downstream.aggregate.n6.guardIssueId}`);
      assert.equal(guard.status, "done");
      proof.n6 = { ...proof.n6, downstream, run, reservation, guard, sourceAccepted: (await api("GET", `${missionPath}?companyId=${companyId}`)).n2.status,
        replayRunCount: after.length, sourceAcceptanceBeforeRun: true };
    },
  };
}
