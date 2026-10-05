import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CouncilDecisionInput } from "../src/contracts.js";
import { recordCouncilOrdinaryReadback } from "../src/decision-receipts.js";
import { type MissionAggregate, type MissionRecord } from "../src/missions.js";
import { MODEL_CATALOGUE } from "../src/model-catalogue.js";
import { applyN2Decision, n2SubmissionResultReference, prepareN2Decision, recordN2Decision, type N2Submission } from "../src/n2-missions.js";
import { executeOrdinaryN2Agent } from "../src/n2-ordinary-agent.js";
import { ordinaryReceiptSubject, ordinaryTask, type OrdinaryReport } from "../src/n2-ordinary-state.js";
import { recordN3Opinion, startN3ReviewRound, type N3OpinionSlot } from "../src/n3-opinions.js";
import { n3Subject } from "../src/n3-runtime.js";

function harness() {
  const ids = Object.fromEntries(["company", "mission", "root", "project", "owner", "lead", "reviewer", "variant", "reviewIssue", "run", "submission"]
    .map(key => [key, randomUUID()])) as Record<"company" | "mission" | "root" | "project" | "owner" | "lead" | "reviewer" | "variant" | "reviewIssue" | "run" | "submission", string>;
  const now = new Date().toISOString();
  const submission: N2Submission = { submissionId: ids.submission, ordinal: 1, predecessorSubmissionId: null,
    attachmentId: randomUUID(), byteSize: 120, sha256: "b".repeat(64), baseCommit: "a".repeat(40), candidateCommit: "c".repeat(40),
    evidenceRevision: 1, mandateHash: "d".repeat(64), verifiedAt: now };
  const slots: N3OpinionSlot[] = ["quality", "security"].map(perspective => ({ slotId: randomUUID(), specialistAgentId: randomUUID(),
    perspective: perspective as "quality" | "security", question: `Review the ${perspective} evidence`, required: true }));
  let review = startN3ReviewRound({ subject: n3Subject(submission), authorAgentIds: [ids.lead], finalReviewerAgentId: ids.reviewer, slots });
  for (const slot of slots) review = recordN3Opinion(review, { subject: review.subject, slotId: slot.slotId,
    authenticatedAgentId: slot.specialistAgentId, authenticatedRunId: randomUUID(), opinionId: randomUUID(), outcome: "support",
    rationale: "The bounded candidate meets this perspective's criteria", findings: [], unresolvedQuestions: [] });
  const task = { ...ordinaryTask("council", ids.submission, ids.reviewer), issueId: ids.reviewIssue,
    creation: "confirmed" as const, wake: "claimed" as const, runId: ids.run };
  const roster = (kind: "team" | "council", agentIds: string[]) => ({ rosterId: randomUUID(), revision: randomUUID(), kind,
    name: kind, projectId: ids.project, members: agentIds.map(agentId => ({ agentId, responsibilities: [] })) });
  const aggregate: MissionAggregate = {
    schemaVersion: 1, companyId: ids.company, missionId: ids.mission, rootIssueId: ids.root, projectId: ids.project, ownerUserId: ids.owner,
    mandate: { objective: "Independently approve the bounded candidate", acceptanceCriteria: ["Independent reviewer approves exact candidate"],
      commitments: ["Keep native attribution"], limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 } },
    compositions: { status: "pinned", team: roster("team", [ids.lead]), council: roster("council", [ids.reviewer, ...slots.map(s => s.specialistAgentId)]) },
    responsibilities: { integrationLeadAgentId: ids.lead, finalReviewerAgentId: ids.reviewer, requiredPerspectives: ["quality", "security"] },
    phase: "reviewing", control: { status: "active" }, readiness: { mission: "recorded", compositions: "pinned", execution: "blocked", blockers: [] },
    journal: [], commandReceipts: [], effectIntents: [],
    n2: { schemaVersion: 1, correctionLimit: 1, correctionsUsed: 0, status: "reviewing", activeSubmissionId: ids.submission,
      submissions: [submission], correction: null, application: { state: "none", submissionId: null, operationId: null, receiptState: null, nativeStatus: null },
      ordinary: { protocol: "ordinary-cli-v1", tasks: [task] }, rounds: [{ round: 1, submissionId: ids.submission, reviewerAgentId: ids.reviewer,
        handoff: { state: "confirmed", baselineRunIds: [], baselineTokenTotal: 0, reviewerRunId: ids.run, reason: null, observedAt: now }, verdict: null }] },
    n3: { slots, rounds: [{ review, specialists: slots.map(slot => ({ slotId: slot.slotId, issueId: randomUUID(), creation: "claimed",
      reservationId: randomUUID(), settlementCommandId: randomUUID(), runId: randomUUID(), wake: "claimed", settledAt: now })) }] },
    modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: ids.root, mapping: MODEL_CATALOGUE, variantRevision: "catalogue-1",
      launches: [{ taskKey: ids.root, interventionKey: "reviewer", launchKey: task.reservationId, logicalAgentId: ids.reviewer, agentId: ids.variant,
        roleKey: "council", family: "review", profileId: "sol-medium", requestedProfileId: "sol-medium", authority: "default",
        rationale: "Initial review profile", mappingRevision: MODEL_CATALOGUE.revision, variantRevision: "catalogue-1", selectedAt: now,
        state: "bound", issueId: ids.reviewIssue, runId: ids.run, ascent: false }] }] },
  };
  let mission: MissionRecord = { companyId: ids.company, missionId: ids.mission, rootIssueId: ids.root, projectId: ids.project, ownerUserId: ids.owner,
    teamRosterId: aggregate.compositions.team.rosterId, teamRevision: aggregate.compositions.team.revision,
    councilRosterId: aggregate.compositions.council.rosterId, councilRevision: aggregate.compositions.council.revision,
    aggregate, version: 1, createdAt: now, updatedAt: now };
  const receiptRows: Record<string, unknown>[] = [];
  const execute = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes(".missions SET aggregate")) {
      if (mission.version !== params[3]) return { rowCount: 0 };
      mission = { ...mission, aggregate: JSON.parse(String(params[0])), version: mission.version + 1 };
      return { rowCount: 1 };
    }
    if (sql.includes("INSERT INTO") && sql.includes("decision_receipts")) {
      if (receiptRows.some(row => row.company_id === params[0] && row.operation_id === params[2])) return { rowCount: 0 };
      receiptRows.push({ company_id: params[0], issue_id: params[1], operation_id: params[2], content_sha256: params[3], verdict: params[4],
        target_url: params[5], request_body: JSON.parse(String(params[6])), actor_agent_id: params[7], run_id: params[8], attempt_id: params[9],
        state: "indeterminate", block_reason: "readback_record_pending", native_status: null, native_body: null, native_observed_at: null,
        human_decisions: [], claimed_at: now, updated_at: now });
      return { rowCount: 1 };
    }
    if (sql.includes("decision_receipts") && sql.includes("native_observed_at")) {
      const row = receiptRows.find(row => row.company_id === params[4] && row.issue_id === params[5]
        && row.operation_id === params[6] && row.attempt_id === params[7] && row.native_observed_at === null);
      if (!row) return { rowCount: 0 };
      Object.assign(row, { state: params[0], block_reason: params[1], native_status: params[2], native_body: JSON.parse(String(params[3])), native_observed_at: now });
      return { rowCount: 1 };
    }
    throw new Error(`Unexpected write: ${sql}`);
  });
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes(".missions")) return [{ company_id: mission.companyId, mission_id: mission.missionId, root_issue_id: mission.rootIssueId,
      project_id: mission.projectId, owner_user_id: mission.ownerUserId, team_roster_id: mission.teamRosterId, team_revision: mission.teamRevision,
      council_roster_id: mission.councilRosterId, council_revision: mission.councilRevision, version: mission.version,
      aggregate: structuredClone(mission.aggregate), created_at: now, updated_at: now }];
    if (sql.includes("operation_id = $3")) return receiptRows.filter(row => row.company_id === params[0] && row.issue_id === params[1] && row.operation_id === params[2]);
    if (sql.includes("operation_id = $2")) return receiptRows.filter(row => row.company_id === params[0] && row.operation_id === params[1]);
    throw new Error(`Unexpected read: ${sql}`);
  });
  const update = vi.fn();
  const ctx = { db: { namespace: "plugin_private_paperclip_council_270061461e", query, execute },
    config: { get: async () => ({ apiBaseUrl: "http://127.0.0.1:3100", councilAgentId: ids.reviewer,
      councilApiKey: { type: "secret_ref", secretId: "fixture-secret" } }) }, secrets: { resolve: vi.fn().mockResolvedValue("fixture-token") },
    issues: { update, listAttachments: vi.fn().mockResolvedValue([{ id: submission.attachmentId, companyId: ids.company, issueId: ids.root,
      sha256: submission.sha256, byteSize: submission.byteSize }]) } } as unknown as PluginContext;
  let run: Record<string, unknown> = { id: ids.run, companyId: ids.company, agentId: ids.variant, nativeIssueId: null,
    nativeReviewInteractionId: null, contextSnapshot: { issueId: ids.reviewIssue }, status: "running", startedAt: now, finishedAt: null };
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    expect(url).toBe(`http://127.0.0.1:3100/api/heartbeat-runs/${ids.run}`);
    expect(options?.method).toBe("GET");
    return new Response(JSON.stringify(run), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  const request = (agentId = ids.variant, runId = ids.run): PluginApiRequestInput => ({ method: "POST", path: "/agent-command", routeKey: "agent-command",
    params: { issueId: ids.reviewIssue }, query: {}, body: {}, actor: { actorType: "agent", actorId: agentId, agentId, runId }, companyId: ids.company, headers: {} });
  const verdictBody = () => ({ command: "ordinary-verdict", commandId: randomUUID(), expectedVersion: mission.version,
    synthesis: { subject: n3Subject(submission), verdict: "approved", rationale: "The exact candidate satisfies the independent review criteria", dispositions: [] } });
  return { ids, ctx, execute, fetch, update, request, verdictBody, task, submission, current: () => structuredClone(mission),
    addReplacedTaskHistory() {
      const active = mission.aggregate.n2!.ordinary!.tasks.find((item) => item.taskId === task.taskId)!;
      const prior = { ...active, taskId: randomUUID(), reservationId: randomUUID(), settlementCommandId: randomUUID(),
        runId: randomUUID(), issueId: randomUUID(), closedAt: now, replacedBy: active.taskId };
      active.replacementOf = prior.taskId;
      mission.aggregate.n2!.ordinary!.tasks = [prior, active];
    },
    finish(report: OrdinaryReport, agentId = ids.variant) {
      // Usage settlement is a separate gate; seed its durable result for the decision-authority test.
      mission.aggregate.n2!.ordinary!.tasks.find((item) => item.taskId === task.taskId)!.settledAt = now;
      run = { ...run, agentId, status: "succeeded", finishedAt: now, resultJson: { summary: JSON.stringify(report) },
        usageJson: { usageSource: "per_run", inputTokens: 12, outputTokens: 3 } };
    } };
}

afterEach(() => vi.unstubAllGlobals());

describe("ordinary N2 physical variant authority", () => {
  it("rejects the logical reviewer, another variant and another run before any effect", async () => {
    const h = harness();
    for (const [agentId, runId] of [[h.ids.reviewer, h.ids.run], [randomUUID(), h.ids.run], [h.ids.variant, randomUUID()]]) {
      await expect(executeOrdinaryN2Agent(h.ctx, h.current(), h.request(agentId, runId), h.verdictBody()))
        .rejects.toMatchObject({ status: 403, code: "ordinary_actor_binding" });
    }
    expect(h.execute).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  it("accepts the exact physical reviewer through native readback and decision receipt while retaining logical roles", async () => {
    const h = harness(); const roles = h.current().aggregate.responsibilities; const roster = h.current().aggregate.compositions;
    h.addReplacedTaskHistory();
    const result = await executeOrdinaryN2Agent(h.ctx, h.current(), h.request(), h.verdictBody());
    expect(result).toMatchObject({ outcome: "applied" });
    const report = h.current().aggregate.n2!.ordinary!.tasks.find((item) => item.taskId === h.task.taskId)!.report!;
    expect(report).toMatchObject({ taskId: h.task.taskId, subject: n3Subject(h.submission), verdict: "approved" });
    expect(h.current().aggregate.n3!.rounds[0]!.review.synthesis).toMatchObject({ finalReviewerAgentId: h.ids.reviewer, finalReviewerRunId: h.ids.run });
    h.finish(report);
    const decision: CouncilDecisionInput = { companyId: h.ids.company, issueId: h.ids.root, actorAgentId: h.ids.variant, runId: h.ids.run,
      operationId: h.task.taskId, verdict: "approved", approvedCommit: h.submission.candidateCommit, justification: report.rationale,
      resultReference: n2SubmissionResultReference(h.submission.submissionId) };
    await expect(prepareN2Decision(h.ctx, h.current(), { ...decision, actorAgentId: h.ids.reviewer }))
      .rejects.toMatchObject({ code: "n2_decision_target_mismatch" });
    await prepareN2Decision(h.ctx, h.current(), decision);
    const receipt = await recordCouncilOrdinaryReadback(h.ctx, decision, { issueId: h.ids.reviewIssue, report,
      requestBody: ordinaryReceiptSubject(h.submission, h.current().aggregate.n2!.ordinary!.tasks.find((item) => item.taskId === h.task.taskId)!) });
    expect(receipt).toMatchObject({ actorAgentId: h.ids.variant, runId: h.ids.run, state: "native_observed",
      nativeObservation: { usable: true, body: { agentId: h.ids.variant, issueId: h.ids.reviewIssue, runId: h.ids.run, report } } });
    expect(() => applyN2Decision(h.current().aggregate.n2!, h.current(), { submissionId: h.ids.submission, actorAgentId: h.ids.variant,
      runId: h.ids.run, operationId: decision.operationId, verdict: "approved", criteria: ["Exact candidate"], reasons: [report.rationale],
      receipt: { ...receipt, actorAgentId: h.ids.reviewer } })).toThrow(expect.objectContaining({ code: "decision_receipt_mismatch" }));
    const accepted = await recordN2Decision(h.ctx, h.ids.mission, decision, receipt);
    expect(accepted.aggregate.n2).toMatchObject({ status: "accepted", correctionsUsed: 0, rounds: [{ reviewerAgentId: h.ids.reviewer,
      verdict: { actorAgentId: h.ids.variant, runId: h.ids.run, receiptState: "native_observed" } }] });
    expect(accepted.aggregate.n2!.ordinary!.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ replacedBy: h.task.taskId }),
      expect.objectContaining({ agentId: h.ids.reviewer, reservationId: h.task.reservationId, taskId: h.task.taskId,
        replacementOf: expect.any(String) }),
    ]));
    expect(accepted.aggregate.responsibilities).toEqual(roles); expect(accepted.aggregate.compositions).toEqual(roster);
    expect(accepted.aggregate.modelSelection!.tasks[0]!.launches).toHaveLength(1);
    expect(accepted.aggregate.journal.at(-1)).toMatchObject({ actorAgentId: h.ids.variant, runId: h.ids.run });
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses terminal telemetry attributed to the logical reviewer instead of the selected physical run", async () => {
    const h = harness();
    await executeOrdinaryN2Agent(h.ctx, h.current(), h.request(), h.verdictBody());
    const task = h.current().aggregate.n2!.ordinary!.tasks[0]!; h.finish(task.report!, h.ids.reviewer);
    const writes = h.execute.mock.calls.length;
    await expect(recordCouncilOrdinaryReadback(h.ctx, { companyId: h.ids.company, issueId: h.ids.root,
      actorAgentId: h.ids.variant, runId: h.ids.run, operationId: task.taskId, verdict: "approved",
      approvedCommit: h.submission.candidateCommit, justification: task.report!.rationale,
      resultReference: n2SubmissionResultReference(h.ids.submission) }, { issueId: h.ids.reviewIssue, report: task.report!,
      requestBody: ordinaryReceiptSubject(h.submission, task) })).rejects.toMatchObject({ code: "g4_run_identity_unqualified" });
    expect(h.execute).toHaveBeenCalledTimes(writes);
    expect(h.current().aggregate.n2!.status).toBe("reviewing");
  });
});
