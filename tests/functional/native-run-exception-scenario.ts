import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Seeded exception readback, separate from the real deterministic CLI cycle. */
export async function qualifyNativeRunException(input: any) {
  const { api, db, tables, companyId, actors, rootIssueId, pluginId, missionPath, admissionPath, profile, proof } = input;
  const missionBefore = (await api("GET", `${missionPath}?companyId=${companyId}`)).mission;
  const before = (await api("GET", `${admissionPath}?companyId=${companyId}&periodKey=${profile.periodKey}`)).envelope;
  const runId = randomUUID();
  const nativeUsage = { inputTokens: 300, outputTokens: 45, cachedInputTokens: 100 };
  await db.insert(tables.heartbeatRuns).values({ id: runId, companyId, agentId: actors.lead,
    status: "succeeded", invocationSource: "automation", triggerDetail: "system",
    startedAt: new Date(Date.now() - 1000), finishedAt: new Date(),
    contextSnapshot: { issueId: rootIssueId, taskId: rootIssueId, wakeReason: "fixture_unadmitted_exception" },
    usageJson: { ...nativeUsage, usageSource: "cumulative" } });
  const reconcile = () => api("POST", `${missionPath}/commands`, { companyId, command: "reconcile-native-runs" }, "unadmitted_native_run");
  const envelope = async () => (await api("GET", `${admissionPath}?companyId=${companyId}&periodKey=${profile.periodKey}`)).envelope;
  assert.equal((await reconcile()).code, "unadmitted_native_run");
  const held = await envelope();
  assert.equal(held.unadmittedRuns.length, 1); assert.equal(held.unadmittedRuns[0].runId, runId);
  assert.equal(held.unadmittedRuns[0].usage.status, "unknown"); assert.equal(held.accountedUnits, null);
  assert.equal(held.allowance.knownUsageUnits, before.allowance.knownUsageUnits);
  assert.deepEqual(held.reservations, before.reservations);
  const workerBefore = await api("GET", `/api/plugins/${pluginId}/dashboard`);
  await api("POST", `/api/plugins/${pluginId}/disable`, {});
  await api("POST", `/api/plugins/${pluginId}/enable`, {});
  const workerAfter = await api("GET", `/api/plugins/${pluginId}/dashboard`);
  assert.equal(workerAfter.worker.status, "running");
  assert.notEqual(workerAfter.worker.pid, workerBefore.worker.pid);
  assert.equal((await reconcile()).code, "unadmitted_native_run");
  assert.deepEqual(await envelope(), held);
  await db.update(tables.heartbeatRuns).set({ usageJson: { ...nativeUsage, usageSource: "per_run" } }).where(input.eq(tables.heartbeatRuns.id, runId));
  await reconcile();
  const accounted = await envelope();
  assert.equal(accounted.unadmittedRuns[0].usage.units, 345);
  assert.equal(accounted.allowance.knownUsageUnits, before.allowance.knownUsageUnits + 345);
  assert.equal(accounted.status, "blocked");
  await reconcile(); assert.deepEqual(await envelope(), accounted);
  assert.deepEqual((await api("GET", `${missionPath}?companyId=${companyId}`)).mission, missionBefore);
  proof.nativeException = { seam: "seeded native heartbeat row; no new CLI or provider invocation", runId,
    held, accounted, checks: { cumulativeUsageHeldUnknown: "PASS", restartPreservesHold: "PASS", perRunCostAddedOnce: "PASS",
      originalReservationsAndCandidatePreserved: "PASS", noNewDepartureGranted: "PASS" } };
}
