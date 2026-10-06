import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

vi.mock("../src/decision-adapter.js", async original => ({ ...await original(), councilNativeRequest: vi.fn() }));
vi.mock("../src/integration.js", async original => ({ ...await original(), verifyIntegratedCandidate: vi.fn() }));
import { configureAdmission, reserveAdmission } from "../src/admission.js";
import { councilNativeRequest } from "../src/decision-adapter.js";
import { nativeAdmissionConfiguration } from "../src/g4-native.js";
import { verifyIntegratedCandidate } from "../src/integration.js";
import type { MissionAggregate, MissionRecord } from "../src/missions.js";
import { executeN2BoardCommand, startN2Review } from "../src/n2-missions.js";
import { ordinaryTask } from "../src/n2-ordinary-state.js";
import type { N3OpinionSlot } from "../src/n3-opinions.js";

const profile = {
  kind: "paperclip-orchestration-tokens-v1" as const,
  periodKey: "terminal-resubmission-recovery",
  periodStart: "2026-10-05T00:00:00.000Z",
  periodEnd: "2026-10-06T00:00:00.000Z",
  periodAllowanceUnits: 48_000_000,
  runReservationUnits: 4_000_000,
  initialKnownUsageUnits: 22_235_154,
  initialExposureUnits: 0,
  initialTokenAccountingSource: "terminal-resubmission-fixture",
  maxCorrections: 1 as const,
};

function candidate(companyId: string, issueId: string, commit: string, sha256: string, attachmentId: string = randomUUID()) {
  return {
    outcome: "verified" as const, publicationEligible: true as const, subject: { companyId, issueId },
    candidate: { attachmentId, byteSize: 1024, sha256, baseCommit: "a".repeat(40), candidateCommit: commit },
    contributions: [
      { contributionId: randomUUID(), commit: "1".repeat(40), ownedPaths: ["server", "drizzle", "tests/runtime"], changedPaths: ["server/original.ts"] },
      { contributionId: randomUUID(), commit: "2".repeat(40), ownedPaths: ["app"], changedPaths: ["app/original.tsx"] },
    ],
    integrationAdjustedPaths: ["README.md"],
    checks: [{ name: "fixture", status: "passed" as const, detail: "verified" }],
  };
}

async function fixture(variant = false) {
  type IdKey = "company" | "mission" | "root" | "project" | "owner" | "lead" | "physicalLead" | "reviewer" | "specialist" | "specialist2" | "contributor"
    | "correctionRun" | "correctionTask" | "correctionReservation" | "correctionSettlement" | "submission1" | "submission2" | "attachment2" | "reviewRun";
  const ids = Object.fromEntries(["company", "mission", "root", "project", "owner", "lead", "physicalLead", "reviewer", "specialist", "specialist2", "contributor",
    "correctionRun", "correctionTask", "correctionReservation", "correctionSettlement", "submission1", "submission2", "attachment2", "reviewRun"]
    .map(key => [key, randomUUID()])) as Record<IdKey, string>;
  const v1 = candidate(ids.company, ids.root, "c".repeat(40), "d".repeat(64));
  const v2 = candidate(ids.company, ids.root, "e".repeat(40), "f".repeat(64), ids.attachment2);
  v2.contributions = v1.contributions;
  const roster = (kind: "team" | "council", agentIds: string[]) => ({ rosterId: randomUUID(), revision: randomUUID(), kind,
    name: kind, projectId: ids.project, members: agentIds.map(agentId => ({ agentId, responsibilities: [] })) });
  const aggregate: MissionAggregate = {
    schemaVersion: 1, missionId: ids.mission, companyId: ids.company, rootIssueId: ids.root, projectId: ids.project, ownerUserId: ids.owner,
    mandate: { objective: "Correct one candidate", acceptanceCriteria: ["V2 is independently reviewed"], commitments: ["Preserve history"],
      limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 } },
    compositions: { status: "pinned", team: roster("team", [ids.lead]) as never, council: roster("council", [ids.reviewer]) as never },
    responsibilities: { integrationLeadAgentId: ids.lead, finalReviewerAgentId: ids.reviewer, requiredPerspectives: ["quality"] },
    phase: "ready_for_review", control: { status: "inactive", reason: "candidate_ready_for_review" },
    readiness: { mission: "recorded", compositions: "pinned", execution: "blocked", blockers: [] }, journal: [], commandReceipts: [], effectIntents: [],
    n1: { candidate: v1, contributions: v1.contributions.map((entry) => ({ ...entry, assigneeAgentId: ids.contributor, authorRunId: randomUUID() })) },
  };
  let mission = { companyId: ids.company, missionId: ids.mission, rootIssueId: ids.root, projectId: ids.project, ownerUserId: ids.owner,
    teamRosterId: aggregate.compositions.team.rosterId, teamRevision: aggregate.compositions.team.revision,
    councilRosterId: aggregate.compositions.council.rosterId, councilRevision: aggregate.compositions.council.revision,
    version: 48, aggregate, createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString() } as MissionRecord;
  const state = startN2Review(mission, { baselineRunIds: [], baselineTokenTotal: 0, submissionId: ids.submission1 });
  const correction = { ...ordinaryTask("correction", ids.submission1, ids.lead), taskId: ids.correctionTask, issueId: ids.root,
    creation: "confirmed" as const, wake: "claimed" as const, runId: ids.correctionRun, reservationId: ids.correctionReservation,
    settlementCommandId: ids.correctionSettlement, settledAt: "2026-10-05T19:07:02.829Z" };
  const slots: N3OpinionSlot[] = [
    { slotId: randomUUID(), specialistAgentId: ids.specialist, perspective: "quality", question: "Does V2 satisfy the correction?", required: true },
    { slotId: randomUUID(), specialistAgentId: ids.specialist2, perspective: "development", question: "Is V2 technically sound?", required: true },
  ];
  mission.aggregate = { ...mission.aggregate, phase: "correcting", control: { status: "active" },
    n2: { ...state, status: "correcting", correctionsUsed: 1, ordinary: { protocol: "ordinary-cli-v1", tasks: [correction] },
      correction: { requestedByOperationId: randomUUID(), criteria: ["correct"], reasons: ["V1 incomplete"], executorAgentId: ids.lead,
        runId: ids.correctionRun, reservationId: ids.correctionReservation, usageSettledAt: correction.settledAt, wakeState: "requested" } },
    n3: { slots, rounds: [{ preserved: "v1-review" } as never] },
    ...(variant ? { modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: ids.root, mapping: {} as never,
      variantRevision: "1", launches: [{ taskKey: ids.root, interventionKey: "lead", launchKey: ids.correctionReservation,
        logicalAgentId: ids.lead, agentId: ids.physicalLead, roleKey: "lead", profileId: "sol-high", requestedProfileId: "sol-high",
        family: "diagnosis", rationale: "pinned", authority: "default", mappingRevision: "1", variantRevision: "1",
        selectedAt: new Date().toISOString(), state: "bound", issueId: ids.root, runId: ids.correctionRun, ascent: false }] }] } } : {}),
  };

  let row = { company_id: ids.company, mission_id: ids.mission, root_issue_id: ids.root, project_id: ids.project,
    owner_user_id: ids.owner, team_roster_id: mission.teamRosterId, team_revision: mission.teamRevision,
    council_roster_id: mission.councilRosterId, council_revision: mission.councilRevision, version: mission.version,
    aggregate: structuredClone(mission.aggregate), created_at: mission.createdAt, updated_at: mission.updatedAt };
  let ledger: any;
  const effects: string[] = [];
  const query = async (sql: string, params: unknown[]) => sql.includes(".admission_envelopes")
    ? ledger && params[0] === ids.company ? [structuredClone(ledger)] : []
    : params[0] === ids.company && (params[1] === ids.mission || params[1] === ids.root) ? [structuredClone(row)] : [];
  const execute = async (sql: string, params: any[]) => {
    if (sql.includes(".admission_envelopes")) {
      if (sql.startsWith("INSERT")) ledger = { company_id: ids.company, period_key: profile.periodKey, version: 1,
        document: JSON.parse(params[2]), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      else { if (ledger.version !== params[3]) return { rowCount: 0 }; ledger.document = JSON.parse(params[2]); ledger.version++; effects.push("admission-cas"); }
    } else {
      if (row.version !== params[3]) return { rowCount: 0 };
      row = { ...row, aggregate: JSON.parse(params[0]), version: row.version + 1, updated_at: new Date().toISOString() };
      effects.push("mission-cas");
    }
    return { rowCount: 1 };
  };
  const ctx = { db: { namespace: "plugin_terminal_recovery", query, execute }, config: { get: async () => ({ n1OperatingProfile: profile }) },
    companies: { get: async () => ({ defaultResponsibleUserId: ids.owner }) },
    agents: { get: async () => ({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    issues: { create: async () => { effects.push("issue-create"); return { id: randomUUID() }; },
      update: async () => { effects.push("issue-update"); return {}; },
      requestWakeup: async () => { effects.push("wake"); return { queued: true, runId: ids.reviewRun }; } } } as unknown as PluginContext;
  await configureAdmission(ctx, nativeAdmissionConfiguration(profile, ids.company, randomUUID()));
  effects.length = 0;
  vi.mocked(verifyIntegratedCandidate).mockResolvedValue(v2);
  vi.mocked(councilNativeRequest).mockImplementation(async (_ctx, _companyId, path) => {
    const runId = String(path).split("/").at(-1);
    const correctionRun = { id: ids.correctionRun, companyId: ids.company, agentId: variant ? ids.physicalLead : ids.lead, nativeIssueId: null,
      contextSnapshot: { issueId: ids.root }, status: "succeeded", startedAt: "2026-10-05T18:52:00.000Z", finishedAt: "2026-10-05T19:07:00.000Z",
      usageJson: { usageSource: "per_run", inputTokens: 100, outputTokens: 10 } };
    return { status: 200, body: runId === ids.correctionRun ? correctionRun : { ...correctionRun, id: ids.reviewRun, agentId: ids.specialist,
      status: "running", startedAt: "2026-10-05T20:00:00.000Z", finishedAt: null } };
  });
  const body = { command: "recover-terminal-resubmission", commandId: randomUUID(), expectedVersion: row.version, authorizeTerminalRecovery: true,
    taskId: ids.correctionTask, runId: ids.correctionRun, reservationId: ids.correctionReservation, settlementCommandId: ids.correctionSettlement,
    attachmentId: ids.attachment2, baseCommit: "a".repeat(40), candidateCommit: "e".repeat(40), expectedSha256: "f".repeat(64),
    submissionId: ids.submission2, correctedPaths: ["server/existing.ts", "drizzle/0001.sql"] };
  const recover = (next = body) => executeN2BoardCommand(ctx, { companyId: ids.company, missionId: ids.mission, actorUserId: ids.owner, body: next });
  return { ids, ctx, body, recover, effects, row: () => row, ledger: () => ledger, v1, v2 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T21:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

async function undispatchedFixture() {
  const f = await fixture();
  const state = f.row().aggregate.n2!;
  f.row().aggregate.phase = "correction_requested";
  state.status = "correction_requested";
  state.correction!.runId = null;
  delete state.correction!.usageSettledAt;
  delete state.correction!.wakeState;
  delete state.ordinary!.tasks[0]!.settledAt;
  await reserveAdmission(f.ctx, { companyId: f.ids.company, periodKey: profile.periodKey,
    missionId: f.ids.mission, effectId: f.ids.correctionTask, reservationId: f.ids.correctionReservation,
    requestedUnits: profile.runReservationUnits, attempt: { kind: "correction", ordinal: 1 }, expectedVersion: 1 });
  const run = { id: f.ids.correctionRun, companyId: f.ids.company, agentId: f.ids.lead, nativeIssueId: null,
    contextSnapshot: { issueId: f.ids.root, wakeReason: "issue_disposition_repair" }, status: "cancelled",
    startedAt: "2026-10-05T19:00:00.000Z", finishedAt: "2026-10-05T19:00:01.000Z",
    errorCode: "legacy_disposition_repair_suppressed", executionStage: "dispatching",
    processPid: null, processStartedAt: null, sessionIdAfter: null, usageJson: null, resultJson: null };
  vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: run });
  const body = { command: "replace-undispatched-correction", commandId: randomUUID(), expectedVersion: f.row().version,
    authorizePreExecutionReplacement: true, taskId: f.ids.correctionTask, runId: f.ids.correctionRun,
    reservationId: f.ids.correctionReservation, candidateCommit: f.v1.candidate.candidateCommit };
  f.effects.length = 0;
  return { ...f, run, replacementBody: body };
}

it("retains a suppressed correction and its zero-cost receipt, with one owner-authorized new task and no wake", async () => {
  const f = await undispatchedFixture();
  const history = structuredClone(f.row().aggregate.n3);
  const mandate = structuredClone(f.row().aggregate.mandate);
  await f.recover(f.replacementBody as never);
  const tasks = f.row().aggregate.n2!.ordinary!.tasks;
  expect(tasks).toHaveLength(2);
  expect(tasks[0]).toMatchObject({ runId: f.ids.correctionRun, reservationId: f.ids.correctionReservation,
    settledAt: expect.any(String), closedAt: expect.any(String), replacedBy: tasks[1]!.taskId });
  expect(tasks[1]).toMatchObject({ kind: "correction", runId: null, issueId: null, creation: "pending", wake: "pending",
    preExecutionReplacementOf: f.ids.correctionTask });
  expect(f.ledger().document).toMatchObject({ allowance: { knownUsageUnits: profile.initialKnownUsageUnits },
    reservations: [{ status: "settled", usage: { status: "known", units: 0 }, remainingExposure: { units: 0 } }] });
  expect(f.row().aggregate.n2!.correctionsUsed).toBe(1);
  expect(f.row().aggregate.n3).toEqual(history);
  expect(f.row().aggregate.mandate).toEqual(mandate);
  expect(f.effects).toEqual(["admission-cas", "mission-cas"]);
  expect((await f.recover(f.replacementBody as never)).outcome).toBe("replayed");
  await expect(f.recover({ ...f.replacementBody, commandId: randomUUID(), expectedVersion: f.row().version } as never))
    .rejects.toMatchObject({ code: "undispatched_correction_binding" });

  const issueId = randomUUID();
  f.ctx.issues.create = vi.fn().mockResolvedValue({ id: issueId });
  f.ctx.issues.get = vi.fn().mockResolvedValue({ id: issueId, description: "correction" });
  f.ctx.issues.update = vi.fn().mockResolvedValue({ id: issueId });
  await executeN2BoardCommand(f.ctx, { companyId: f.ids.company, missionId: f.ids.mission, actorUserId: f.ids.owner,
    body: { command: "reconcile-ordinary-n2" } });
  expect(f.ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ inheritExecutionWorkspaceFromIssueId: f.ids.root }));
  expect(f.ctx.issues.update).not.toHaveBeenCalledWith(f.ids.root, expect.anything(), expect.anything());
  expect(f.row().aggregate.n2!.ordinary!.tasks[1]).toMatchObject({ issueId, runId: f.ids.reviewRun, wake: "claimed" });
  expect(f.ledger().document.reservations).toHaveLength(2);
});

it.each([
  { status: "running", finishedAt: null }, { errorCode: "timeout" }, { executionStage: "executing" },
  { processPid: 12 }, { processStartedAt: "2026-10-05T19:00:00.100Z" }, { sessionIdAfter: "session" },
  { usageJson: { usageSource: "per_run", inputTokens: 5, outputTokens: 0 } }, { resultJson: { summary: "work" } },
])("does not infer zero usage from an unqualified run: %j", async change => {
  const f = await undispatchedFixture();
  vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: { ...f.run, ...change } });
  await expect(f.recover(f.replacementBody as never)).rejects.toMatchObject({ code: "correction_execution_not_excluded" });
  expect(f.effects).toEqual([]);
  expect(f.ledger().document.reservations[0].remainingExposure.units).toBe(4_000_000);
});

it("requires the owner and explicit authority on the exact candidate before any recovery write", async () => {
  const f = await undispatchedFixture();
  await expect(executeN2BoardCommand(f.ctx, { companyId: f.ids.company, missionId: f.ids.mission,
    actorUserId: randomUUID(), body: f.replacementBody })).rejects.toMatchObject({ code: "owner_required" });
  for (const change of [{ authorizePreExecutionReplacement: false }, { candidateCommit: "0".repeat(40) },
    { runId: randomUUID() }, { reservationId: randomUUID() }, { expectedVersion: 0 }]) {
    await expect(f.recover({ ...f.replacementBody, ...change } as never)).rejects.toMatchObject({ code: "undispatched_correction_binding" });
  }
  expect(f.effects).toEqual([]);
});

it("transfers one exact terminal correction, preserves history/accounting, then lets ordinary reconciliation start V2 review", async () => {
  const f = await fixture();
  const before = structuredClone({ tasks: f.row().aggregate.n2!.ordinary!.tasks, n3: f.row().aggregate.n3,
    correctionsUsed: f.row().aggregate.n2!.correctionsUsed, ledger: f.ledger().document });

  const recovered = await f.recover();

  expect(recovered).toMatchObject({ outcome: "applied", mission: { aggregate: { n2: { status: "resubmission_prepared",
    correction: { runId: f.ids.correctionRun, reservationId: f.ids.correctionReservation, preparedSubmission: { submissionId: f.ids.submission2 } } } } } });
  expect(f.effects).toEqual(["mission-cas"]);
  expect(f.row().aggregate.n2!.ordinary!.tasks).toEqual(before.tasks);
  expect(f.row().aggregate.n3).toEqual(before.n3);
  expect(f.row().aggregate.n2!.correctionsUsed).toBe(before.correctionsUsed);
  expect(f.ledger().document).toEqual(before.ledger);
  expect(verifyIntegratedCandidate).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ correctedPaths: f.body.correctedPaths,
    integrationAdjustedPaths: ["README.md"], contributions: f.v1.contributions.map(({ contributionId, commit, ownedPaths }) => ({ contributionId, commit, ownedPaths })) }));

  const replayed = await f.recover();
  expect(replayed.outcome).toBe("replayed");
  expect(f.effects).toEqual(["mission-cas"]);

  await executeN2BoardCommand(f.ctx, { companyId: f.ids.company, missionId: f.ids.mission, actorUserId: f.ids.owner,
    body: { command: "reconcile-ordinary-n2" } });
  expect(f.row().aggregate.n2).toMatchObject({ status: "review_handoff", activeSubmissionId: f.ids.submission2,
    submissions: [{ ordinal: 1 }, { ordinal: 2 }], correctionsUsed: 1 });
  expect(f.row().aggregate.n2!.ordinary!.tasks.filter((task: any) => task.kind === "correction")).toEqual([
    expect.objectContaining({ taskId: f.ids.correctionTask, runId: f.ids.correctionRun, reservationId: f.ids.correctionReservation,
      settlementCommandId: f.ids.correctionSettlement, closedAt: expect.any(String) }),
  ]);
  expect(f.row().aggregate.n2!.ordinary!.tasks).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "specialist", runId: f.ids.reviewRun, wake: "claimed" }),
  ]));
  expect(f.effects.filter(effect => effect === "wake")).toHaveLength(1);
  expect(f.ledger().document.reservations).toHaveLength(1);
  expect(f.ledger().document.reservations[0]).toMatchObject({ attempt: { kind: "initial", ordinal: 0 } });
});

it("uses the exact physical variant for terminal readback without rewriting logical attribution", async () => {
  const f = await fixture(true);

  await expect(f.recover()).resolves.toMatchObject({ outcome: "applied" });

  expect(f.row().aggregate.journal.at(-1)).toMatchObject({ action: "owner_recovered_terminal_resubmission",
    actorUserId: f.ids.owner, executorAgentId: f.ids.physicalLead, logicalExecutorAgentId: f.ids.lead, runId: f.ids.correctionRun });
});

it.each(["active", "identity", "prepared", "payload"])("refuses %s recovery without a second effect", async failure => {
  const f = await fixture();
  if (failure === "active") vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: { id: f.ids.correctionRun,
    companyId: f.ids.company, agentId: f.ids.lead, nativeIssueId: null, contextSnapshot: { issueId: f.ids.root }, status: "running",
    startedAt: new Date().toISOString(), finishedAt: null } });
  if (failure === "identity") f.body.reservationId = randomUUID();
  if (failure === "prepared") f.row().aggregate.n2!.correction!.preparedSubmission = f.row().aggregate.n2!.submissions[0];
  if (failure === "payload") f.body.authorizeTerminalRecovery = false;

  await expect(f.recover()).rejects.toBeDefined();
  expect(f.effects).toEqual([]);
  expect(f.ledger().document.reservations).toEqual([]);
});
