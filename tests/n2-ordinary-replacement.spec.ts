import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
vi.mock("../src/decision-adapter.js", async original => ({ ...await original(), councilNativeRequest: vi.fn() }));
import { councilNativeRequest } from "../src/decision-adapter.js";
import { handleMissionApi } from "../src/missions.js";
import { ordinaryTask } from "../src/n2-ordinary-state.js";
import { configureAdmission, reserveAdmission } from "../src/admission.js";
import { nativeAdmissionConfiguration, settleOrdinaryRunUsage } from "../src/g4-native.js";
import { handleN2AgentApi, inspectN2State } from "../src/n2-missions.js";
import { acceptedN5Submission } from "../src/n5-preflight.js";

async function fixture() {
  const company = randomUUID(), mission = randomUUID(), owner = randomUUID(), agent = randomUUID(), submissionId = randomUUID();
  const rootIssueId = randomUUID(), projectId = randomUUID(), attachmentId = randomUUID();
  const task = { ...ordinaryTask("specialist", submissionId, agent, randomUUID()), issueId: randomUUID(), runId: randomUUID(),
    creation: "confirmed" as const, wake: "claimed" as const, settledAt: new Date().toISOString() };
  const subject = { submissionId, candidateCommit: "a".repeat(40), bundleSha256: "b".repeat(64), evidenceRevision: 1, mandateHash: "c".repeat(64) };
  const next = ordinaryTask("specialist", submissionId, randomUUID(), randomUUID());
  const submission = { ...subject, sha256: subject.bundleSha256, attachmentId, byteSize: 100, baseCommit: "d".repeat(40),
    ordinal: 2, predecessorSubmissionId: randomUUID(), verifiedAt: new Date().toISOString() };
  const aggregate: any = { phase: "review_handoff", control: { status: "active" }, readiness: { blockers: [] },
    responsibilities: { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: randomUUID() }, compositions: { council: { members: [] } },
    schemaVersion: 1, commandReceipts: [], journal: [], n2: { status: "review_handoff", activeSubmissionId: submissionId,
    submissions: [submission], rounds: [], ordinary: { protocol: "ordinary-cli-v1", tasks: [task, next] } },
    n3: { rounds: [{ review: { subject, opinions: [], slots: [] }, specialists: [] }] } };
  let row: any = { company_id: company, mission_id: mission, root_issue_id: rootIssueId, project_id: projectId, owner_user_id: owner,
    team_roster_id: randomUUID(), team_revision: randomUUID(), council_roster_id: randomUUID(), council_revision: randomUUID(), aggregate, version: 37,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  let ledger: any;
  const receiptRows: any[] = [];
  const effects: string[] = [];
  const profile = { kind: "paperclip-orchestration-tokens-v1" as const, periodKey: "replacement-test", periodStart: new Date(Date.now() - 60000).toISOString(),
    periodEnd: new Date(Date.now() + 60000).toISOString(), periodAllowanceUnits: 10000, runReservationUnits: 1000,
    initialKnownUsageUnits: 0, initialExposureUnits: 0, initialTokenAccountingSource: "replacement-test", maxCorrections: 1 as const };
  const run: any = { id: task.runId, companyId: company, agentId: agent, nativeIssueId: null, contextSnapshot: { issueId: task.issueId },
    status: "succeeded", startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), usageJson: { usageSource: "per_run", inputTokens: 100, outputTokens: 10 } };
  const runs = new Map<string, any>([[run.id, run]]);
  const ctx = { config: { get: async () => ({ n1OperatingProfile: profile }) }, companies: { get: async () => ({ defaultResponsibleUserId: owner }) },
    agents: { get: async () => ({ status: "idle", adapterType: "codex_local", adapterConfig: { engine: "cli" } }) },
    db: { namespace: "plugin_test", query: async (sql: string, p: any[]) => {
      if (sql.includes(".admission_envelopes")) return ledger ? [structuredClone(ledger)] : [];
      if (sql.includes(".decision_receipts")) {
        if (sql.includes("operation_id = $3")) return receiptRows.filter(item => item.company_id === p[0] && item.issue_id === p[1] && item.operation_id === p[2]);
        if (sql.includes("operation_id = $2")) return receiptRows.filter(item => item.company_id === p[0] && item.operation_id === p[1]);
        return receiptRows.filter(item => item.company_id === p[0] && item.issue_id === p[1] && item.state === "indeterminate");
      }
      return [structuredClone(row)];
    },
      execute: async (sql: string, p: any[]) => {
        if (sql.includes(".admission_envelopes")) {
          if (sql.startsWith("INSERT")) ledger = { company_id: company, period_key: profile.periodKey, version: 1, document: JSON.parse(p[2]), created_at: row.created_at, updated_at: row.updated_at };
          else { if (ledger.version !== p[3]) return { rowCount: 0 }; ledger.document = JSON.parse(p[2]); ledger.version++; effects.push("reserve-or-settle"); }
        } else if (sql.includes(".decision_receipts")) {
          if (sql.startsWith("INSERT")) {
            if (receiptRows.some(item => item.company_id === p[0] && item.operation_id === p[2])) return { rowCount: 0 };
            receiptRows.push({ company_id: p[0], issue_id: p[1], operation_id: p[2], content_sha256: p[3], verdict: p[4],
              target_url: p[5], request_body: JSON.parse(p[6]), actor_agent_id: p[7], run_id: p[8], attempt_id: p[9],
              state: "indeterminate", block_reason: "readback_record_pending", native_status: null, native_body: null,
              native_observed_at: null, human_decisions: [], claimed_at: row.created_at, updated_at: row.updated_at });
          } else if (sql.includes("native_observed_at")) {
            const receipt = receiptRows.find(item => item.company_id === p[4] && item.issue_id === p[5]
              && item.operation_id === p[6] && item.attempt_id === p[7] && item.native_observed_at === null);
            if (!receipt) return { rowCount: 0 };
            Object.assign(receipt, { state: p[0], block_reason: p[1], native_status: p[2], native_body: JSON.parse(p[3]), native_observed_at: row.updated_at });
          }
          effects.push("decision-receipt");
        } else { if (row.version !== p[3]) return { rowCount: 0 }; row = { ...row, aggregate: JSON.parse(p[0]), version: row.version + 1 }; effects.push("mission-cas"); }
        return { rowCount: 1 };
      } },
    issues: { update: async () => { effects.push("issue-update"); }, create: async () => { effects.push("create"); return { id: randomUUID() }; },
      listAttachments: async () => [{ id: attachmentId, companyId: company, issueId: rootIssueId, sha256: submission.sha256, byteSize: submission.byteSize }],
      requestWakeup: async (issueId: string) => { const runId = randomUUID(); effects.push("wake");
        runs.set(runId, { id: runId, companyId: company, agentId: agent, nativeIssueId: null, contextSnapshot: { issueId },
          status: "running", startedAt: new Date().toISOString(), finishedAt: null, usageJson: null }); return { runId }; } } } as unknown as PluginContext;
  vi.mocked(councilNativeRequest).mockImplementation(async (_ctx, _companyId, path) => {
    const runId = path.split("/").at(-1)!;
    return { status: runs.has(runId) ? 200 : 404, body: runs.get(runId) ?? null };
  });
  await configureAdmission(ctx, nativeAdmissionConfiguration(profile, company, randomUUID()));
  await reserveAdmission(ctx, { companyId: company, periodKey: profile.periodKey, missionId: mission, effectId: task.taskId,
    reservationId: task.reservationId, requestedUnits: 1000, attempt: { kind: "initial", ordinal: 0 }, expectedVersion: 1 });
  await settleOrdinaryRunUsage(ctx, { companyId: company, issueId: task.issueId, agentId: agent, runId: task.runId,
    commandId: task.settlementCommandId, periodKey: profile.periodKey, reservationId: task.reservationId, expectedVersion: 2 });
  effects.length = 0;
  const body: any = { command: "replace-missing-opinion", commandId: randomUUID(), expectedVersion: 37, taskId: task.taskId,
    runId: task.runId, submissionId, candidateCommit: subject.candidateCommit, reason: "Explicit one-time operator-error recovery", authorizeOneReplacement: true };
  const call = (b = body, user: string = owner) => handleMissionApi({ routeKey: "mission-command", method: "POST", companyId: company,
    params: { companyId: company, missionId: mission }, query: {}, headers: {}, path: "", actor: { actorType: "user", actorId: user, userId: user }, body: b }, ctx);
  return { ctx, call, body, task, run, runs, profile, effects, row: () => row, ledger: () => ledger };
}

async function councilFixture() {
  const f = await fixture();
  f.task.kind = "council";
  delete (f.task as any).slotId;
  delete (f.task as any).settledAt;
  const aggregate = f.row().aggregate;
  const lead = aggregate.responsibilities.integrationLeadAgentId;
  aggregate.responsibilities.finalReviewerAgentId = f.task.agentId;
  aggregate.mandate = { objective: "Approve the exact corrected candidate", acceptanceCriteria: ["Exact V2 is independently approved"],
    commitments: [], limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 } };
  const mandateHash = createHash("sha256").update(JSON.stringify(aggregate.mandate)).digest("hex");
  aggregate.n2.submissions[0].mandateHash = mandateHash; aggregate.n3.rounds[0].review.subject.mandateHash = mandateHash;
  aggregate.phase = "reviewing";
  aggregate.effectIntents = [];
  aggregate.n2.status = "reviewing";
  aggregate.n2.schemaVersion = 1;
  aggregate.n2.correctionLimit = 1;
  aggregate.n2.correctionsUsed = 1;
  aggregate.n2.correction = { requestedByOperationId: randomUUID(), criteria: ["Correct V1"], reasons: ["Historical objection"],
    executorAgentId: lead, runId: randomUUID(), usageSettledAt: new Date().toISOString(), preparedSubmission: aggregate.n2.submissions[0] };
  aggregate.n2.application = { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null };
  aggregate.n2.rounds = [{ round: 2, submissionId: f.task.submissionId, reviewerAgentId: f.task.agentId,
    handoff: { state: "confirmed", baselineRunIds: [], baselineTokenTotal: 0, reviewerRunId: f.task.runId,
      reservationId: f.task.reservationId, reason: null, observedAt: new Date().toISOString() }, verdict: null }];
  aggregate.n2.ordinary.tasks = [f.task];
  const developmentSlot = { slotId: randomUUID(), perspective: "development", specialistAgentId: randomUUID(), question: "Check V2", required: true };
  const qualitySlot = { slotId: randomUUID(), perspective: "quality", specialistAgentId: randomUUID(), question: "Check V2 evidence", required: true };
  const deferrableFindingId = randomUUID();
  aggregate.n3.rounds[0].review = { ...aggregate.n3.rounds[0].review, status: "ready_for_synthesis", synthesis: null,
    finalReviewerAgentId: f.task.agentId, authorAgentIds: [lead], slots: [developmentSlot, qualitySlot],
    opinions: [{ opinionId: randomUUID(), slotId: developmentSlot.slotId, perspective: "development",
      specialistAgentId: developmentSlot.specialistAgentId, specialistRunId: randomUUID(), subject: aggregate.n3.rounds[0].review.subject,
      outcome: "support", rationale: "Development supports V2", findings: [], unresolvedQuestions: [], recordedAt: new Date().toISOString() },
    { opinionId: randomUUID(), slotId: qualitySlot.slotId, perspective: "quality", specialistAgentId: qualitySlot.specialistAgentId,
      specialistRunId: randomUUID(), subject: aggregate.n3.rounds[0].review.subject, outcome: "support", rationale: "Quality supports V2",
      findings: [{ findingId: deferrableFindingId, classification: "deferrable_improvement", criterionOrRisk: "Stronger trace detail",
        evidenceRefs: ["current:test"], evidenceLimits: [], consequence: "No current material failure", recommendedAction: "Improve later" }],
      unresolvedQuestions: [], recordedAt: new Date().toISOString() }] };
  aggregate.n3.slots = [developmentSlot, qualitySlot];
  Object.assign(f.body, { command: "replace-missing-verdict" });
  return { ...f, deferrableFindingId };
}

async function acceptedCouncilFixtureWithoutHistoricalStamp() {
  const f = await councilFixture();
  expect((await f.call()).status).toBe(200);
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  const active = f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.replacementOf === f.task.taskId);
  const agentCall = (body: Record<string, unknown>) => handleN2AgentApi({ routeKey: "mission-agent-command", method: "POST",
    companyId: f.row().company_id, params: { issueId: active.issueId }, query: {}, headers: {}, path: "",
    actor: { actorType: "agent", actorId: active.agentId, agentId: active.agentId, runId: active.runId },
    body: { missionId: f.row().mission_id, ...body } }, f.ctx);
  const inspected = await agentCall({ command: "ordinary-inspect" });
  const prepared = await agentCall({ command: "ordinary-verdict", commandId: randomUUID(), expectedVersion: f.row().version,
    synthesis: { subject: (inspected.body as any).n3.review.subject, verdict: "approved",
      rationale: "The exact corrected candidate satisfies the current independent review.", dispositions: [] } });
  Object.assign(f.runs.get(active.runId), { status: "succeeded", finishedAt: new Date().toISOString(),
    usageJson: { usageSource: "per_run", inputTokens: 80, outputTokens: 20 },
    resultJson: { summary: JSON.stringify((prepared.body as any).finishReport) } });
  const oldReceipt = f.ledger().document.reservations[0].settlementReceipts[0];
  f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId).settledAt = oldReceipt.recordedAt;
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  delete f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId).settledAt;
  return f;
}

it("preserves the missing task and costs, reserves resume with a durable grant, and replays without duplicate wake", async () => {
  const f = await fixture(); const original = structuredClone(f.ledger().document.reservations[0]);
  expect((await f.call()).status).toBe(200); expect(f.effects).toEqual(["mission-cas"]);
  const tasks = f.row().aggregate.n2.ordinary.tasks; expect(tasks).toHaveLength(3); expect(tasks[0]).toMatchObject({ runId: f.task.runId, replacedBy: tasks[1].taskId });
  expect(tasks[1]).toMatchObject({ agentId: f.task.agentId, slotId: f.task.slotId, replacementOf: f.task.taskId });
  expect((await f.call()).status).toBe(200); expect(f.effects).toEqual(["mission-cas"]);
  delete f.row().aggregate.n2.ordinary.missingOpinionReplacement.missingOutput;
  delete f.row().aggregate.n2.ordinary.missingOpinionReplacement.taskKind;
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  expect(f.effects.indexOf("reserve-or-settle")).toBeLessThan(f.effects.indexOf("wake"));
  expect(f.ledger().document.limits.maxRetries).toBe(0);
  expect(f.ledger().document.reservations[1]).toMatchObject({ attempt: { kind: "resume", ordinal: 1 }, ownerReplacementCommandId: f.body.commandId });
  expect(f.ledger().document.reservations[0]).toEqual(original);
  expect((await f.call()).status).toBe(200); expect(f.effects.filter(x => x === "wake")).toHaveLength(1);
});
it.each(["owner", "candidate", "opinion", "active", "unknown", "second"])("refuses %s without replacement effects", async kind => {
  const f = await fixture(); let owner: string | undefined;
  if (kind === "owner") owner = randomUUID();
  if (kind === "candidate") f.body.candidateCommit = "d".repeat(40);
  if (kind === "opinion") f.row().aggregate.n3.rounds[0].review.opinions.push({ slotId: f.task.slotId });
  if (kind === "active") f.run.status = "running";
  if (kind === "unknown") f.run.usageJson = null;
  if (kind === "second") f.row().aggregate.n2.ordinary.missingOpinionReplacement = {};
  expect((await f.call(f.body, owner)).status).toBeGreaterThanOrEqual(400);expect(f.effects).toEqual([]);
});
it("does not accept a fabricated or cross-reservation exception", async () => {
  const f = await fixture();
  const input = { companyId: f.row().company_id, periodKey: f.profile.periodKey, missionId: f.row().mission_id,
    reservationId: randomUUID(), effectId: randomUUID(), requestedUnits: 1000, attempt: { kind: "resume" as const, ordinal: 1 },
    ownerReplacementCommandId: f.body.commandId, expectedVersion: f.ledger().version };
  await expect(reserveAdmission(f.ctx, input)).rejects.toMatchObject({ code: "owner_replacement_grant_required" });
  expect((await f.call()).status).toBe(200);
  await expect(reserveAdmission(f.ctx, input)).rejects.toMatchObject({ code: "owner_replacement_grant_required" });
  expect(f.ledger().document.reservations).toHaveLength(1);
});

it("rebinds one terminal Council task, then accepts only the replacement review and terminal readback", async () => {
  const f = await councilFixture();
  const originalReservation = structuredClone(f.ledger().document.reservations[0]);
  expect((await f.call()).status).toBe(200);
  expect(f.effects).toEqual(["mission-cas"]);
  const first = structuredClone(f.row().aggregate);
  const replacement = first.n2.ordinary.tasks[1];
  expect(first).toMatchObject({ phase: "review_handoff", n2: { status: "review_handoff", rounds: [{ handoff: {
    state: "awaiting_native", reviewerRunId: null, reservationId: replacement.reservationId } }] } });
  expect(first.n2.ordinary.tasks[0]).toMatchObject({ taskId: f.task.taskId, runId: f.task.runId, replacedBy: replacement.taskId });
  expect(first.n2.ordinary.tasks[0]).not.toHaveProperty("settledAt");
  expect(replacement).toMatchObject({ kind: "council", agentId: f.task.agentId, submissionId: f.task.submissionId,
    replacementOf: f.task.taskId, runId: null, wake: "pending" });

  expect((await f.call()).status).toBe(200);
  expect(f.effects).toEqual(["mission-cas"]);
  expect((await f.call({ ...f.body, commandId: randomUUID(), expectedVersion: f.row().version })).status).toBe(409);
  expect(f.effects).toEqual(["mission-cas"]);
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  expect(f.effects.filter((effect) => effect === "wake")).toHaveLength(1);
  expect(f.effects.indexOf("reserve-or-settle")).toBeLessThan(f.effects.indexOf("wake"));
  expect(f.ledger().document.reservations[0]).toEqual(originalReservation);
  expect(f.ledger().document.reservations[1]).toMatchObject({ effectId: replacement.taskId, reservationId: replacement.reservationId,
    attempt: { kind: "resume", ordinal: 1 }, ownerReplacementCommandId: f.body.commandId });
  expect(f.row().aggregate.n2.rounds[0].handoff).toMatchObject({ state: "awaiting_native", reviewerRunId: null,
    reservationId: replacement.reservationId });

  const active = f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.taskId === replacement.taskId);
  const agentCall = (body: Record<string, unknown>) => handleN2AgentApi({ routeKey: "mission-agent-command", method: "POST",
    companyId: f.row().company_id, params: { issueId: active.issueId }, query: {}, headers: {}, path: "",
    actor: { actorType: "agent", actorId: active.agentId, agentId: active.agentId, runId: active.runId },
    body: { missionId: f.row().mission_id, ...body } }, f.ctx);
  const inspected = await agentCall({ command: "ordinary-inspect" });
  expect(inspected).toMatchObject({ status: 200, body: { task: { taskId: replacement.taskId }, n3: { review: {
    status: "ready_for_synthesis" } } } });
  expect(f.row().aggregate.n2.rounds[0].handoff).toMatchObject({ state: "confirmed", reviewerRunId: active.runId,
    reservationId: replacement.reservationId });
  const review = (inspected.body as any).n3.review;
  const extra = await agentCall({ command: "ordinary-verdict", commandId: randomUUID(), expectedVersion: f.row().version,
    synthesis: { subject: review.subject, verdict: "approved", rationale: "V2 fixes the historical material objections.",
      dispositions: [{ findingId: f.deferrableFindingId, disposition: "resolved_by_evidence", reason: "Extra disposition",
        evidenceRefs: ["current:test"] }] } });
  expect(extra).toMatchObject({ status: 409, body: { code: "material_objection_undisposed",
    details: { requiredCurrentMaterialFindingIds: [], receivedDispositionCount: 1 } } });

  const prepared = await agentCall({ command: "ordinary-verdict", commandId: randomUUID(), expectedVersion: f.row().version,
    synthesis: { subject: review.subject, verdict: "approved",
      rationale: "V2 fixes the historical material objections; the current round has no material finding.", dispositions: [] } });
  expect(prepared).toMatchObject({ status: 200, body: { finishReport: { taskId: replacement.taskId, verdict: "approved" } } });
  const report = (prepared.body as any).finishReport;
  Object.assign(f.runs.get(active.runId), { status: "succeeded", finishedAt: new Date().toISOString(),
    usageJson: { usageSource: "per_run", inputTokens: 80, outputTokens: 20 }, resultJson: { summary: JSON.stringify(report) } });
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  expect(f.row().aggregate).toMatchObject({ phase: "accepted", n2: { status: "accepted", correctionsUsed: 1,
    rounds: [{ verdict: { verdict: "approved", operationId: replacement.taskId, runId: active.runId },
      handoff: { reservationId: replacement.reservationId, reviewerRunId: active.runId } }] } });
  expect(f.row().aggregate.effectIntents).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "n2_decision", operationId: replacement.taskId, actorRunId: active.runId }),
  ]));
  expect(f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.taskId === replacement.taskId)).toMatchObject({
    settledAt: expect.any(String), receiptRecordedAt: expect.any(String), closedAt: expect.any(String), report });
  const historical = f.row().aggregate.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId);
  const historicalReceipt = originalReservation.settlementReceipts.find((item: any) => item.commandId === f.task.settlementCommandId);
  expect(historical).toMatchObject({ settledAt: historicalReceipt.recordedAt, closedAt: expect.any(String),
    replacedBy: replacement.taskId });
  expect(historical).not.toHaveProperty("report"); expect(historical).not.toHaveProperty("receiptRecordedAt");
  expect(f.effects.filter((effect) => effect === "wake")).toHaveLength(1);

  // Mirror the already-accepted v82 shape from before the accounting-stamp repair.
  delete historical.settledAt;
  expect(inspectN2State(f.row())?.usage.complete).toBe(false);
  expect(() => acceptedN5Submission(f.row())).toThrowError(expect.objectContaining({ code: "n5_accepted_candidate_required" }));
  const before = structuredClone(f.row().aggregate); const ledgerBefore = structuredClone(f.ledger().document);
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  const after = f.row().aggregate; const repaired = after.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId);
  expect(repaired).toEqual({ ...before.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId),
    settledAt: historicalReceipt.recordedAt });
  const withoutRepair = structuredClone(after); delete withoutRepair.n2.ordinary.tasks.find((item: any) => item.taskId === f.task.taskId).settledAt;
  expect(withoutRepair).toEqual(before);
  expect(f.ledger().document).toEqual(ledgerBefore);
  expect(inspectN2State(f.row())?.usage.complete).toBe(true);
  expect(acceptedN5Submission(f.row())).toMatchObject({ submissionId: f.task.submissionId,
    candidateCommit: f.body.candidateCommit });
  const replayVersion = f.row().version; const replayAggregate = structuredClone(after);
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  expect(f.row().version).toBe(replayVersion); expect(f.row().aggregate).toEqual(replayAggregate);
  expect(f.ledger().document).toEqual(ledgerBefore);
});

it.each(["synthesis", "report", "receipt", "verdict", "application", "decision-intent", "already-used", "replaced"])(
  "refuses Council replacement when %s already exists without an external effect",
  async guard => {
    const f = await councilFixture(); const aggregate = f.row().aggregate;
    if (guard === "synthesis") aggregate.n3.rounds[0].review.synthesis = { verdict: "approved" };
    if (guard === "report") f.task.report = {} as never;
    if (guard === "receipt") f.task.receiptRecordedAt = new Date().toISOString();
    if (guard === "verdict") aggregate.n2.rounds[0].verdict = { verdict: "approved" };
    if (guard === "application") aggregate.n2.application = { state: "observed", submissionId: f.task.submissionId, operationId: f.task.taskId,
      receiptState: "native_observed", nativeStatus: 200 };
    if (guard === "decision-intent") aggregate.effectIntents.push({ kind: "n2_decision", submissionId: f.task.submissionId });
    if (guard === "already-used") aggregate.n2.ordinary.missingOpinionReplacement = {};
    if (guard === "replaced") f.task.replacedBy = randomUUID();
    expect((await f.call()).status).toBeGreaterThanOrEqual(400);
    expect(f.effects).toEqual([]);
  },
);

it.each(["unknown-usage", "cross-run"])("refuses historical settlement repair for %s without changing mission or costs", async kind => {
  const f = await acceptedCouncilFixtureWithoutHistoricalStamp();
  const oldRun = f.runs.get(f.task.runId)!;
  if (kind === "unknown-usage") oldRun.usageJson = null;
  else oldRun.agentId = randomUUID();
  const before = structuredClone(f.row().aggregate); const ledgerBefore = structuredClone(f.ledger().document);
  const wakeCount = f.effects.filter((item) => item === "wake").length;
  const response = await f.call({ command: "reconcile-ordinary-n2" });
  expect(response).toMatchObject({ status: 409, body: { code: kind === "unknown-usage"
    ? "g4_usage_unavailable" : "g4_run_identity_unqualified" } });
  expect(f.row().aggregate).toEqual(before); expect(f.ledger().document).toEqual(ledgerBefore);
  expect(f.effects.filter((item) => item === "wake")).toHaveLength(wakeCount);
});
