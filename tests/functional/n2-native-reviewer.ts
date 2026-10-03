import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Model-backend content uses exactly the production review authority, never Council routes. */
export async function nativeReviewerTurn(input: any, prepared: any, execution: any, result: any, trace: any[], approveFirst: boolean) {
  const { PaperclipRunnerToolAuthority } = await input.hostImport("server/src/services/native-runtime/paperclip-runner-tool-authority.ts");
  const [run] = await input.db.select().from(input.tables.heartbeatRuns).where(input.eq(input.tables.heartbeatRuns.id, execution.binding.runId));
  const authority = new PaperclipRunnerToolAuthority(input.db, { ...execution.binding, apiUrl: input.baseUrl,
    nativeReview: { nativeReviewInteractionId: run.contextSnapshot.nativeReviewInteractionId, nativeReviewDecisionId: run.contextSnapshot.nativeReviewDecisionId } });
  await assert.rejects(() => authority.execute({ tool: "call_api", callId: randomUUID(), arguments: { operationId: "GET /api/plugins/tools" } }), /may only inspect/);
  const context = await authority.execute({ tool: "get_task_context", callId: randomUUID(), arguments: {} });
  const description = context.activeTask.description;
  const packets = [...description.matchAll(/Council native review packet [a-f0-9]+\n```json\n([^\n]+)\n```/g)];
  assert.equal(packets.length, 1, "Native task context must expose exactly one active packet");
  const packet = JSON.parse(packets.at(-1)![1]);
  assert.equal(packet.reviewerAgentId, execution.binding.agentId); assert.equal(packet.issueId, execution.binding.issueId);
  const approved = packet.submission.ordinal === 2 || approveFirst;
  const report = reviewerReport(packet, approved);
  result.summary = JSON.stringify(report);
  const verdict = await authority.execute({ tool: "resolve_review", callId: randomUUID(), arguments: { decision: approved ? "accept" : "reject", ...(approved ? {} : { reason: report.rationale }) } });
  assert.equal(verdict.status, approved ? "accepted" : "rejected");
  const m = (await input.request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`)).body.mission;
  assert.notEqual(m.aggregate.n2.status, "accepted", "Native resolution before terminal summary/cost must not accept Council");
  const costs = await input.db.select().from(input.tables.costEvents).where(input.eq(input.tables.costEvents.issueId, prepared.rootIssueId));
  assert(!costs.some((c: any) => c.heartbeatRunId === run.id));
  trace.push({ event: "native_reviewer_resolved_before_terminal_readback", runId: run.id, context, report, verdict,
    councilStatusBeforeFinish: m.aggregate.n2.status, reviewerCostBeforeFinish: false, councilApiRefused: true });
}

export async function holdDedicatedLead(input: any, prepared: any, trace: any[], runId: string) {
  const active = (await input.db.select().from(input.tables.heartbeatRuns).where(input.eq(input.tables.heartbeatRuns.agentId, prepared.agents.lead.id)))
    .filter((r: any) => ["running", "queued"].includes(r.status));
  assert.equal(active.length, 1); assert.equal(active[0].id, runId);
  const changed = await input.request("human", "PATCH", `/api/agents/${prepared.agents.lead.id}`, {
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const readback = await input.request("human", "GET", `/api/agents/${prepared.agents.lead.id}`);
  assert.deepEqual(readback.body.runtimeConfig.heartbeat, { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 });
  trace.push({ event: "owner_holds_dedicated_lead_before_final_handoff", runId, policy: readback.body.runtimeConfig.heartbeat, activeRunIds: active.map((r: any) => r.id) });
}

export async function releaseReservedCorrection(input: any, prepared: any, mission: any, trace: any[], heartbeat: any) {
  if (mission.aggregate.n2?.native?.correctionOwnerAction !== "restore_wake_policy" || mission.aggregate.n2.status !== "correction_requested") return;
  const envelope = (await input.request("human", "GET", `${prepared.admissionPath}?companyId=${prepared.companyId}&periodKey=${encodeURIComponent(prepared.nativePeriodKey)}`)).body.envelope;
  assert(envelope.reservations.some((r: any) => r.reservationId === mission.aggregate.n2.correction.reservationId && r.status === "reserved"));
  const before = (await input.db.select().from(input.tables.heartbeatRuns).where(input.eq(input.tables.heartbeatRuns.agentId, prepared.agents.lead.id))).filter((r: any) => ["running", "queued"].includes(r.status));
  assert.equal(before.length, 0);
  const restored = await input.request("human", "PATCH", `/api/agents/${prepared.agents.lead.id}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
  assert.equal(restored.status, 200);
  // The ordinary native recovery may run in this owner-call gap. It must reuse the reservation.
  await heartbeat.reconcileStrandedAssignedIssues();
  const current = (await input.request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`)).body.mission;
  const released = await input.request("human", "POST", `${prepared.missionPath}/commands`, { companyId: prepared.companyId,
    command: "release-native-correction", commandId: randomUUID(), expectedVersion: current.version });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  trace.push({ event: "owner_releases_reserved_correction", reservationId: mission.aggregate.n2.correction.reservationId, nativeRecoveryBeforeCommand: true, outcome: released.body.outcome });
}

function reviewerReport(packet: any, approved: boolean) {
  const s = packet.submission;
  return { schema: "council-native-review-v1", packetHash: packet.packetHash,
    subject: { submissionId: s.submissionId, candidateCommit: s.candidateCommit, bundleSha256: s.sha256, evidenceRevision: s.evidenceRevision, mandateHash: s.mandateHash },
    verdict: approved ? "approved" : "changes_requested",
    rationale: approved ? "The exact candidate satisfies the bounded correction and reviewed opinions" : "alpha.txt lacks the required independent correction marker",
    dispositions: packet.opinions?.opinions.flatMap((opinion: any) => opinion.findings.filter((f: any) => f.classification !== "deferrable_improvement")
      .map((f: any) => ({ findingId: f.findingId, disposition: "upheld_with_correction", reason: "The required marker is absent; one bounded correction is necessary", evidenceRefs: f.evidenceRefs }))) ?? [] };
 }
