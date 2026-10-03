import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareN2Prerequisite } from "./n2-prerequisite.js";
import { nativeRunEvidence } from "./n1-live.js";
import { nativeModel } from "./n2-native-model.js";

export async function runN2NativeLifecycle(input: any) {
  const { request, hostImport, evidence, save, agentTokens, db, tables, eq } = input;
  const { CONTROL_PLANE_CONFORMANCE_RESULT: resultTemplate, CONTROL_PLANE_CONFORMANCE_TERMINAL: terminalTemplate } = await hostImport("server/src/vendor/paperclip-runner/testing.ts");
  const prepared = await prepareN2Prerequisite({ ...input,
    registerActor: (actor: string, identity: any) => agentTokens.set(actor, { ...identity, runId: "", agentId: identity.id }),
    liveN2Profile: { model: "deterministic-test", effort: "high", runReservationUnits: 2_000_000, periodAllowanceUnits: 10_000_000 },
  });
  const config = await request("human", "GET", `/api/plugins/${input.pluginId}/config?companyId=${prepared.companyId}`);
  assert.equal(config.status, 200, JSON.stringify(config.body));
  const configured = await request("human", "POST", `/api/plugins/${input.pluginId}/config`, { companyId: prepared.companyId,
    configJson: { ...config.body.configJson, n2RuntimeProfile: "paperclip_runner-experimental" } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  // Only this ephemeral company adopts the selected experimental runtime.
  for (const agent of [prepared.agents.lead, prepared.agents.reviewer]) {
    const changed = await request("human", "PATCH", `/api/agents/${agent.id}`, { adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "deterministic-test" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  const root = await request("human", "PATCH", `/api/issues/${prepared.rootIssueId}`, { executionPolicy: { mode: "normal", stages: [] } });
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const executions: any[] = []; const trace: any[] = []; const errors: string[] = [];
  evidence.nativeLifecycle = { executions, trace, modelErrors: errors, simulatedUsage: true, profile: "paperclip_runner-experimental",
    fixtureBoundary: "Only N1 legacy prerequisite rows are fixtures. Transmission, two reviewers and correction use real native admission, HTTP, plugin, finalizer, costs and events.",
    prerequisite: prepared };
  evidence.configuration.models = "NativeSessionBackend factory only; no provider, scheduler mock, handoff rendezvous or wake toggles during the cycle";
  nativeModel.factory = execution => {
    const runId = execution.binding.runId;
    const identity = { ...execution.binding, sessionId: execution.session.normalizedSessionId };
    const turnId = randomUUID(); const result = structuredClone(resultTemplate);
    const capabilities = { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    let completed!: () => void; const started = new Promise<void>(resolve => { completed = resolve; });
    return {
      async descriptor() { return { kind: "mock", name: "council-deterministic-model", version: "1", capabilities, runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
      async openSession() { return {
        identity: () => identity, async capabilities() { return capabilities; },
        async startTurn(delivery: any) {
          try {
            const contract = JSON.parse(delivery.message.text).completionContract;
            result.completionClaim.contractRevision = contract.revision;
            result.completionClaim.criteria = contract.criteria.map((c: any) => ({ ...result.completionClaim.criteria[0], criterionId: c.id }));
            assert.equal(execution.binding.issueId, prepared.rootIssueId);
            assert(executions.length < 4, "Unexpected fifth model execution");
            executions.push({ runId, agentId: execution.binding.agentId, issueId: prepared.rootIssueId });
            const reviewer = execution.binding.agentId === prepared.agents.reviewer.id;
            assert(reviewer || execution.binding.agentId === prepared.agents.lead.id);
            const actor = reviewer ? "n2-prerequisite-reviewer" : "n2-prerequisite-lead";
            agentTokens.set(actor, { ...agentTokens.get(actor), runId });
            const route = `/api/plugins/${input.pluginId}/api/issues/${prepared.rootIssueId}/council/commands`;
            const call = async (body: any) => {
              const response = await request(actor, "POST", route, { missionId: prepared.missionId, ...body });
              assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
            };
            let inspection = await call({ command: "inspect" });
            if (reviewer) {
              await call({ command: "confirm-review-handoff", commandId: randomUUID(), expectedVersion: inspection.version });
              inspection = await call({ command: "inspect" });
              const submission = inspection.n2.submission;
              const approved = inspection.n2.review.round === 2;
              assert.equal(execFileSync("git", ["show", `${submission.candidateCommit}:alpha.txt`], { cwd: prepared.repository, encoding: "utf8" }),
                approved ? "alpha contribution corrected after independent review\n" : "alpha contribution\n");
              const decision = await request(actor, "POST", `/api/plugins/${input.pluginId}/api/issues/${prepared.rootIssueId}/decision`, {
                operationId: randomUUID(), verdict: approved ? "approved" : "changes_requested",
                ...(approved ? { approvedCommit: submission.candidateCommit } : { correctionReservationId: randomUUID() }),
                resultReference: `council:n2:submission:${submission.submissionId}`,
                justification: approved ? "V2 contains the requested bounded correction" : "alpha.txt needs the independent correction marker",
              });
              assert.equal(decision.status, 200, JSON.stringify(decision.body));
              const [stillRunning] = await db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId));
              assert.equal(stillRunning.status, "running");
              trace.push({ event: "native_verdict_while_reviewer_running", runId, approved, decision: decision.body });
            } else if (!inspection.native.transmission.attestedAt) {
              await call({ command: "attest-transmission", commandId: randomUUID(), expectedVersion: inspection.version });
              result.reportedWorkDisposition = "needs_review";
              result.attentionRequests = [{ kind: "review", summary: "Council review of verified V1", ownerClass: "agent", targetAgentId: prepared.agents.reviewer.id }];
            } else {
          const git = (args: string[]) => execFileSync("git", args, { cwd: prepared.repository, encoding: "utf8" }).trim();
          git(["switch", "contribution-beta"]);
          git(["switch", "-c", "deterministic-correction"]);
          git(["merge", "--no-ff", "--no-commit", "contribution-alpha"]);
          await writeFile(resolve(prepared.repository, "alpha.txt"), "alpha contribution corrected after independent review\n");
          git(["add", "alpha.txt"]);
          git(["commit", "-m", "Deterministic model: bounded N2 correction"]);
          const candidateCommit = git(["rev-parse", "HEAD"]);
          git(["branch", "-f", "candidate", candidateCommit]);
          const bundle = resolve(input.runtime, "deterministic-v2.bundle");
          git(["bundle", "create", bundle, "refs/heads/base", "refs/heads/candidate"]);
          const bytes = await readFile(bundle);
          const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
          const form = new FormData();
          form.append("file", new Blob([bytes]), "deterministic-v2.bundle");
          const identity = agentTokens.get(actor);
          const uploaded = await fetch(`${input.baseUrl}/api/companies/${prepared.companyId}/issues/${prepared.rootIssueId}/attachments`, {
            method: "POST", headers: { authorization: `Bearer ${identity.token}`, "x-paperclip-run-id": execution.binding.runId }, body: form,
          });
          const attachment = await uploaded.json() as any;
          assert.equal(uploaded.status, 201, JSON.stringify(attachment));
          assert.equal(attachment.sha256, expectedSha256);
          inspection = await call({ command: "inspect" });
          await call({ command: "prepare-resubmission", commandId: randomUUID(), expectedVersion: inspection.version,
            submissionId: randomUUID(), attachmentId: attachment.id, expectedSha256,
            baseCommit: prepared.baseCommit, candidateCommit, reviewReservationId: randomUUID(), correctedPaths: ["alpha.txt"] });
              result.reportedWorkDisposition = "needs_review";
              result.attentionRequests = [{ kind: "review", summary: "Council review of verified V2", ownerClass: "agent", targetAgentId: prepared.agents.reviewer.id }];
            }
            await save(); completed(); return { turnId };
          } catch (error) { errors.push(String(error)); completed(); throw error; }
        },
        async *events() {
          await started;
          const [run] = await db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId));
          yield { schema: "paperclip.prp.event.v1", sourceEventId: `${run.runnerInstanceId}:terminal`, sourceSeq: 1, sourceInstanceId: run.runnerInstanceId,
            sourceKind: "runner", runId, normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload: {} };
        },
        async result() { return { result, terminal: { ...terminalTemplate, reportedWorkDisposition: result.reportedWorkDisposition }, turnId }; },
        async usage() { return { inputTokens: 101, outputTokens: 23, costUsd: 0.001 }; },
        async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity, providerSessionId: null, activeTurnId: null, cursor: "1", pendingRuntimeRequests: [], lineage: [] }; },
        async close() {},
      }; },
    };
  };
  for (const agent of [prepared.agents.lead, prepared.agents.reviewer]) {
    const changed = await request("human", "PATCH", `/api/agents/${agent.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  const before = await request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`);
  const started = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId,
    command: "start-review", commandId: randomUUID(), expectedVersion: before.body.mission.version,
    submissionId: randomUUID(), reservationId: randomUUID(), transmissionReservationId: randomUUID() });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const { heartbeatService } = await hostImport("server/src/services/heartbeat.ts");
  const heartbeat = heartbeatService(db);
  let mission: any; let admission: any;
  for (let attempt = 0; attempt < 80; attempt++) {
    await heartbeat.drainActiveRunExecutions();
    mission = (await request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`)).body.mission;
    admission = (await request("human", "GET", `${prepared.admissionPath}?companyId=${prepared.companyId}&periodKey=${encodeURIComponent(prepared.nativePeriodKey)}`)).body.envelope;
    if (errors.length || mission.aggregate.n2?.status === "accepted" && admission.reservations.every((entry: any) => entry.status === "settled")) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const runs = (await db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.companyId, prepared.companyId))).filter((run: any) => run.contextSnapshot?.issueId === prepared.rootIssueId);
  const finalRuns = runs.filter((run: any) => executions.some(execution => execution.runId === run.id));
  const costs = await db.select().from(tables.costEvents).where(eq(tables.costEvents.issueId, prepared.rootIssueId));
  evidence.nativeLifecycle.finalRuns = finalRuns.map((run: any) => ({ ...nativeRunEvidence(run), runtimeMode: run.runtimeMode }));
  evidence.nativeLifecycle.allRootRuns = runs.map((run: any) => ({ ...nativeRunEvidence(run), runtimeMode: run.runtimeMode, errorCode: run.errorCode }));
  evidence.nativeLifecycle.costs = costs;
  evidence.nativeLifecycle.finalMission = mission;
  evidence.nativeLifecycle.finalAdmission = admission;
  await save();
  assert.deepEqual(errors, []);
  assert.equal(executions.length, 4, JSON.stringify({ errors, runs: finalRuns.map((r: any) => ({ id: r.id, status: r.status, error: r.error })), mission: mission.aggregate.n2 }));
  assert(finalRuns.every((run: any) => run.status === "succeeded" && run.runtimeMode === "native"));
  assert.equal(costs.length, 4);
  assert.equal(mission.aggregate.n2.status, "accepted");
  assert(admission.reservations.every((entry: any) => entry.status === "settled"));
  assert.equal(admission.exposure.units, 0);
  const recovery = await request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId, command: "reconcile-native-n2" });
  assert.equal(recovery.status, 200, JSON.stringify(recovery.body));
  await heartbeat.reconcileStrandedAssignedIssues(); await heartbeat.drainActiveRunExecutions();
  assert.equal(executions.length, 4, "Replay must not dispatch another model run");
  evidence.nativeLifecycle.recovery = { status: recovery.status, executionsAfter: executions.length };
  evidence.outcome = "N2 NATIVE LIFECYCLE WITH DETERMINISTIC MODEL VALIDATED";
  await save();
}
