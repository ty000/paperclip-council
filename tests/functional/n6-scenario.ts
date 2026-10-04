import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Extends the installed ordinary fixture only: A is produced by real APIs, B runs a deterministic CLI executable. */
export function prepareN6Scenario(input: { api: (...args: any[]) => Promise<any>; companyId: string; projectId: string;
  actors: Record<string, string>; missions: string; missionPath: string; profile: any; runtime: string; fixtureConfig: string; proof: any; coordinationMode?: boolean }) {
  const { api, companyId, projectId, actors, missions, missionPath, profile, runtime, fixtureConfig, proof, coordinationMode } = input;
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
  async function transferHeldCoordinator() {
    if (!coordinationMode || proof.n6.coordinatorTransfer) return;
    let observed: any;
    try { observed = JSON.parse(await readFile(resolve(runtime, "n6-facilitator-running"), "utf8")); } catch { return; }
    const current = (await api("GET", `${downstreamPath}?companyId=${companyId}`)).mission;
    const c = current.aggregate.n6.coordination;
    assert(c.tasks.filter((t: any) => t.kind === "coordinator").every((t: any) => t.closedAt && t.settledAt));
    const body = { companyId, command: "transfer-result-coordinator", commandId: randomUUID(), expectedVersion: current.version,
      coordinatorAgentId: actors.pmSuccessor, reason: "Fixture demonstrates coordinator replacement while facilitator owns the separate handoff task" };
    const transferred = await api("POST", `${downstreamPath}/commands`, body);
    const replay = await api("POST", `${downstreamPath}/commands`, body); assert.equal(replay.outcome, "replayed");
    const config = JSON.parse(await readFile(fixtureConfig, "utf8"));
    await api("POST", `/api/plugins/${config.pluginId}/upgrade`, {});
    const restarted = (await api("GET", `${downstreamPath}?companyId=${companyId}`)).mission;
    assert.deepEqual(restarted.aggregate.n6.coordination, transferred.mission.aggregate.n6.coordination);
    proof.n6.coordinatorTransfer = { observed, body, transferred, restarted };
    await writeFile(resolve(runtime, "n6-coordinator-transferred"), "same persisted task identities after owner transfer and restart");
  }
  async function rebindAcceptedCorrection(downstream: any) {
    if (!coordinationMode || proof.n6.resultRebind || downstream.aggregate.n6.coordination.tasks.some((t: any) => !t.closedAt)) return;
    const source = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
    if (source.aggregate.n2.status !== "accepted") return;
    const approved = source.aggregate.n2.ordinary.tasks.find((t: any) => t.report?.verdict === "approved");
    const body = { companyId, command: "rebind-result-dependency", commandId: randomUUID(), expectedVersion: downstream.version,
      expectedResult: approved.report.subject, preserveCoordinationRelease: true, reason: "Owner carries priority/release forward to the exact same-mandate accepted correction; no claim PM reviewed V2" };
    const rebound = await api("POST", `${downstreamPath}/commands`, body);
    const replay = await api("POST", `${downstreamPath}/commands`, body); assert.equal(replay.outcome, "replayed");
    assert.equal(rebound.mission.aggregate.n6.intentId, downstream.aggregate.n6.intentId);
    assert.equal(rebound.mission.aggregate.n6.guardIssueId, downstream.aggregate.n6.guardIssueId);
    const root = await api("GET", `/api/issues/${downstream.rootIssueId}`); assert(root.description.includes("SUPERSEDED"));
    assert(root.description.includes(approved.report.subject.candidateCommit));
    proof.n6.resultRebind = { body, before: downstream, rebound, root };
  }
  async function terminalDownstream(end: number) {
    while (Date.now() < end) {
      await transferHeldCoordinator();
      const downstream = (await api("GET", `${downstreamPath}?companyId=${companyId}`)).mission;
      await rebindAcceptedCorrection(downstream);
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
      const council = source.aggregate.n2?.ordinary?.tasks.find((task: any) => task.kind === "council" && (coordinationMode ? task.report : task.report?.verdict === "approved"));
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
        sourceMissionId: source.missionId, expectedResult: council.report.subject, periodKey: profile.periodKey, requestedUnits: 1000,
        ...coordinationMode ? { coordination: { coordinatorAgentId: actors.pm, facilitatorAgentId: actors.facilitator,
          allowedPriorities: ["medium", "high"], participantAgentIds: [actors.lead, actors.quality], requestedUnits: 1000,
          mandate: "Order A before B; resolve the accepted artifact handoff, choose B priority within delegation, preserve owner commitments" } } : {} };
      configured = await api("POST", `${downstreamPath}/commands`, body);
      const waiting = await api("GET", `${downstreamPath}?companyId=${companyId}`);
      assert.equal(waiting.n6.state, "waiting"); assert.equal(waiting.mission.aggregate.n1, undefined);
      assert.equal((await api("GET", `/api/issues/${root.id}`)).status, "blocked");
      const before = await api("GET", `/api/companies/${companyId}/heartbeat-runs`);
      assert(before.every((run: any) => run.contextSnapshot?.issueId !== root.id));
      const replay = await api("POST", `${downstreamPath}/commands`, body); assert.equal(replay.outcome, "replayed");
      if (!coordinationMode) await api("POST", `/api/plugins/${config.pluginId}/upgrade`, {});
      const restarted = await api("GET", `${downstreamPath}?companyId=${companyId}`);
      if (!coordinationMode) assert.deepEqual(restarted.mission.aggregate.n6, waiting.mission.aggregate.n6);
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
