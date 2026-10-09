import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admission.js")>();
  return {
    ...actual,
    readAdmission: vi.fn(),
    reserveAdmission: vi.fn(),
    settleAdmission: vi.fn(),
  };
});

vi.mock("../src/integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integration.js")>();
  return { ...actual, verifyIntegratedCandidate: vi.fn(), verifyContributionBundle: vi.fn() };
});
vi.mock("../src/model-variants.js", () => ({ inspectVariant: vi.fn() }));

import { AdmissionError, readAdmission, reserveAdmission, settleAdmission } from "../src/admission.js";
import { verifyIntegratedCandidate, verifyContributionBundle } from "../src/integration.js";
import { executeN1BoardCommand, handleN1AgentApi, inspectN1State } from "../src/n1-missions.js";
import { getMission, handleMissionApi, canonicalPayloadHash, MissionError, type MissionAggregate, type MissionRecord } from "../src/missions.js";
import { reconcileTerminalN1Usage } from "./functional/n1-live.js";
import { inspectVariant } from "../src/model-variants.js";
import { MODEL_CATALOGUE } from "../src/model-catalogue.js";
import { n1ResumeAdmissionFailure, type N1Resume } from "../src/n1-resume-state.js";
import type { N1State } from "../src/n1-missions.js";
import * as nativeAdapter from "../src/decision-adapter.js";
import { advanceContinuity } from "../src/continuity-runtime.js";
import { chooseModelProfile } from "../src/model-api.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { assertHierarchySources } from "../src/hierarchy-runtime.js";

const id = {
  company: randomUUID(),
  mission: randomUUID(),
  root: randomUUID(),
  project: randomUUID(),
  owner: randomUUID(),
  lead: randomUUID(),
  leadRun: randomUUID(),
  reviewer: randomUUID(),
  contributorA: randomUUID(),
  contributorB: randomUUID(),
  contributorRun: randomUUID(),
  contributionA: randomUUID(),
  contributionB: randomUUID(),
  childA: randomUUID(),
  childB: randomUUID(),
  team: randomUUID(),
  teamRevision: randomUUID(),
  council: randomUUID(),
  councilRevision: randomUUID(),
};

type StoredRow = {
  company_id: string;
  mission_id: string;
  root_issue_id: string;
  project_id: string;
  owner_user_id: string;
  team_roster_id: string;
  team_revision: string;
  council_roster_id: string;
  council_revision: string;
  version: number;
  aggregate: MissionAggregate;
  created_at: string;
  updated_at: string;
};

function aggregate(): MissionAggregate {
  return {
    schemaVersion: 1,
    missionId: id.mission,
    companyId: id.company,
    rootIssueId: id.root,
    projectId: id.project,
    ownerUserId: id.owner,
    mandate: {
      objective: "Integrate two bounded contributions",
      acceptanceCriteria: ["The candidate contains both contributions"],
      commitments: ["Do not publish an unverified candidate"],
      limits: { taskPolicy: "fixture", periodPolicy: "fixture", correctionLimit: 2, elapsedMinutes: 30 },
    },
    compositions: {
      status: "pinned",
      team: {
        rosterId: id.team,
        revision: id.teamRevision,
        kind: "team",
        name: "N1 delivery team",
        projectId: id.project,
        members: [id.lead, id.contributorA, id.contributorB].map((agentId) => ({ agentId, responsibilities: [] })),
      },
      council: {
        rosterId: id.council,
        revision: id.councilRevision,
        kind: "council",
        name: "N1 review council",
        projectId: id.project,
        members: [{ agentId: id.reviewer, responsibilities: ["final_reviewer"] }],
      },
    },
    responsibilities: {
      integrationLeadAgentId: id.lead,
      finalReviewerAgentId: id.reviewer,
      requiredPerspectives: ["quality"],
    },
    phase: "draft",
    control: { status: "inactive", reason: "mission_not_enabled" },
    readiness: {
      mission: "recorded",
      compositions: "pinned",
      execution: "blocked",
      blockers: [],
    },
    journal: [],
    commandReceipts: [],
    effectIntents: [],
  };
}

function storedRow(value = aggregate()): StoredRow {
  const now = new Date(0).toISOString();
  return {
    company_id: id.company,
    mission_id: id.mission,
    root_issue_id: id.root,
    project_id: id.project,
    owner_user_id: id.owner,
    team_roster_id: id.team,
    team_revision: id.teamRevision,
    council_roster_id: id.council,
    council_revision: id.councilRevision,
    version: 1,
    aggregate: value,
    created_at: now,
    updated_at: now,
  };
}

function nativeIssue(input: {
  id: string;
  parentId: string | null;
  assigneeAgentId: string;
  status: "backlog" | "in_progress" | "done";
  originKind?: string;
  originId?: string;
}) {
  return {
    ...input,
    companyId: id.company,
    projectId: id.project,
    originKind: input.originKind ?? null,
    originId: input.originId ?? null,
  };
}

function harness(initial = aggregate(), initialVersion = 1) {
  let row = storedRow(initial);
  row.version = initialVersion;
  const issues = new Map<string, ReturnType<typeof nativeIssue>>([
    [id.root, nativeIssue({
      id: id.root,
      parentId: null,
      assigneeAgentId: id.lead,
      status: initial.control.status === "active" ? "in_progress" : "backlog",
    })],
  ]);
  const query = vi.fn(async () => [structuredClone(row)]);
  const execute = vi.fn(async (_sql: string, params: unknown[]) => {
    const expectedVersion = params[3] as number;
    if (row.version !== expectedVersion) return { rowCount: 0 };
    row = {
      ...row,
      aggregate: JSON.parse(params[0] as string) as MissionAggregate,
      owner_user_id: (JSON.parse(params[0] as string) as MissionAggregate).ownerUserId,
      version: row.version + 1,
      updated_at: new Date().toISOString(),
    };
    return { rowCount: 1 };
  });
  const assertCheckoutOwner = vi.fn(async () => undefined);
  const list = vi.fn(async () => []);
  const create = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => {
    throw new Error("native issue create response was lost");
  });
  const documentGet = vi.fn(async () => null as Record<string, unknown> | null);
  const update = vi.fn(async () => undefined);
  const requestWakeup = vi.fn(async (): Promise<{ queued: boolean; runId: string | null }> => ({ queued: true, runId: null }));
  const configGet = vi.fn(async () => ({ n1FixtureMode: "ephemeral-local-sandbox" }));
  const getOrchestration = vi.fn(async () => ({
    issueId: id.root,
    companyId: id.company,
    subtreeIssueIds: [id.root],
    relations: {},
    approvals: [],
    runs: [],
    costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, billingCode: null },
    openBudgetIncidents: [],
    invocationBlocks: [],
  }));
  const agentGet = vi.fn(async (agentId: string) => new Set<string>([id.lead, id.contributorA, id.contributorB, id.reviewer]).has(agentId)
    ? {
        id: agentId,
        companyId: id.company,
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { engine: "cli" },
      }
    : null);
  const advanceMission = (mutate: (aggregate: MissionAggregate) => MissionAggregate) => {
    row = {
      ...row,
      aggregate: mutate(structuredClone(row.aggregate)),
      version: row.version + 1,
      updated_at: new Date().toISOString(),
    };
  };
  const ctx = {
    db: { namespace: "plugin_private_council_test", query, execute },
    config: { get: configGet },
    companies: { get: vi.fn(async () => ({ id: id.company, defaultResponsibleUserId: id.owner })) },
    projects: { get: vi.fn(async () => ({ id: id.project, companyId: id.company, archivedAt: null })) },
    agents: { get: agentGet },
    issues: {
      get: vi.fn(async (issueId: string) => issues.get(issueId) ?? null),
      assertCheckoutOwner,
      list,
      create,
      documents: { get: documentGet },
      update,
      requestWakeup,
      summaries: { getOrchestration },
    },
  } as unknown as PluginContext;
  return {
    ctx,
    issues,
    query,
    execute,
    assertCheckoutOwner,
    list,
    create,
    documentGet,
    update,
    requestWakeup,
    configGet,
    agentGet,
    getOrchestration,
    advanceMission,
    row: () => structuredClone(row),
  };
}

function activeAggregate() {
  const value = aggregate();
  value.phase = "executing";
  value.control = { status: "active" };
  value.n1 = {
    periodKey: "fixture-2026-09",
    activationReservationId: randomUUID(),
    activatedAt: new Date().toISOString(),
    rootDispatchState: "requested",
    rootDispatchRunId: id.leadRun,
    contributions: [],
  };
  return value;
}

function withBoundLead(value: MissionAggregate) {
  value.modelSelection = { protocol: "native-variants-v1", choices: [], tasks: [{
      taskKey: id.root, mapping: structuredClone(MODEL_CATALOGUE), variantRevision: "1", launches: [{
      taskKey: id.root, interventionKey: "lead", launchKey: String(value.n1!.activationReservationId),
      logicalAgentId: id.lead, agentId: id.lead, roleKey: "lead", profileId: "sol-medium",
      requestedProfileId: "sol-medium", family: "orchestration", rationale: "Initial lead profile",
      authority: "default", mappingRevision: "1", variantRevision: "1", selectedAt: new Date(0).toISOString(),
      state: "bound", issueId: id.root, runId: id.leadRun, ascent: false,
    }],
  }] };
  return value;
}

function agentRequest(body: Record<string, unknown>, actor: { agentId: string; runId: string }, issueId: string): PluginApiRequestInput {
  return {
    routeKey: "n1-agent",
    method: "POST",
    path: "",
    params: { issueId },
    query: {},
    body: { missionId: id.mission, ...body },
    actor: { actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId },
    companyId: id.company,
    headers: {},
  };
}

const plan = [
  { contributionId: id.contributionA, assigneeAgentId: id.contributorA, title: "Contribution A", ownedPaths: ["src/a/"] },
  { contributionId: id.contributionB, assigneeAgentId: id.contributorB, title: "Contribution B", ownedPaths: ["src/b/"] },
];

describe("explicit interrupted N1 resume", () => {
  function interrupted() {
    const value = activeAggregate(); const rootReservation = String(value.n1!.activationReservationId);
    const childReservation = randomUUID(); const priorJournal = { action: "original_work", runId: id.contributorRun };
    value.journal = [priorJournal];
    value.n1 = { ...value.n1, rootDispatchMode: "native", rootUsageBaselineUnits: 0, contributions: [
      { ...plan[0], issueState: "confirmed", childIssueId: id.childA, dispatchState: "requested",
        dispatchRunId: id.contributorRun, dispatchReservationId: childReservation, dispatchUsageBaselineUnits: 0 },
      { ...plan[1], issueState: "confirmed", childIssueId: id.childB },
    ] };
    const h = harness(value);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    for (const [issueId, agentId, parentId] of [[id.root, id.lead, null], [id.childA, id.contributorA, id.root]] as const) {
      h.issues.set(issueId, { ...nativeIssue({ id: issueId, assigneeAgentId: agentId, parentId, status: "backlog" }), status: "blocked" } as never);
    }
    h.getOrchestration.mockImplementation(async (...args: unknown[]) => {
      const issueId = (args[0] as { issueId: string }).issueId;
      return { issueId, companyId: id.company, runs: [{ id: issueId === id.root ? id.leadRun : id.contributorRun,
        issueId, status: "succeeded", startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }],
        costs: { inputTokens: 90, cachedInputTokens: 70, outputTokens: 10, costCents: 0 },
        invocationBlocks: [], openBudgetIncidents: [] } as never;
    });
    const envelope = { ...nativeEnvelope([rootReservation, childReservation].map(reservationId => ({
      reservationId, missionId: id.mission, status: "settled", usage: { status: "known", units: 100 },
      remainingExposure: { status: "known", units: 0 }, settlementReceipts: [],
    }))), companyId: id.company };
    vi.mocked(readAdmission).mockResolvedValue(envelope as never);
    const body = { command: "prepare-n1-resume", commandId: randomUUID(), expectedVersion: 1,
      authorizeOneResume: true, previousOwnerUserId: id.owner, reason: "Git permission repaired; retain the existing diff" };
    const apply = (actorUserId = id.owner) => executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId, body });
    return { ...h, value, envelope, body, apply, rootReservation, childReservation, priorJournal };
  }

  it("preserves history and costs, then admits one exact lead and contributor through existing dispatch", async () => {
    const h = interrupted(); await h.apply();
    const state = h.row().aggregate.n1 as N1State; const grant = state.resume!;
    expect(state.rootDispatchState).toBeUndefined();
    expect(state.contributions[0].dispatchRunId).toBeUndefined();
    expect(grant.lead).toMatchObject({ priorRunId: id.leadRun, priorReservationId: h.rootReservation });
    expect(grant.contributions[0]).toMatchObject({ priorRunId: id.contributorRun, priorReservationId: h.childReservation });
    expect(h.row().aggregate.journal[0]).toEqual(h.priorJournal);
    expect(h.row().aggregate.mandate).toEqual(h.value.mandate);
    expect(reserveAdmission).not.toHaveBeenCalled(); expect(h.requestWakeup).not.toHaveBeenCalled();
    expect((await h.apply()).outcome).toBe("replayed");
    vi.mocked(reserveAdmission).mockImplementation(async (_ctx, input) => {
      expect(n1ResumeAdmissionFailure(h.row().aggregate, h.envelope as never, input, id.owner, id.owner)).toBeNull();
      const reservation = { reservationId: input.reservationId, missionId: id.mission, status: "reserved" };
      return { reservation, envelope: { ...h.envelope, reservations: [...h.envelope.reservations, reservation] } } as never;
    });
    const nextLead = randomUUID(); const nextChild = randomUUID();
    h.requestWakeup.mockResolvedValueOnce({ queued: true, runId: nextLead }).mockResolvedValueOnce({ queued: true, runId: nextChild });
    const start = await executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: h.row().version } });
    expect(start.outcome).toBe("requested");
    h.issues.get(id.root)!.status = "in_progress";
    const resumed = grant.contributions[0];
    const command = { command: "dispatch", commandId: randomUUID(), expectedVersion: h.row().version,
      contributionId: id.contributionA, requestedUnits: nativeProfile.runReservationUnits, reservationId: resumed.reservationId };
    const wrong = await handleN1AgentApi(agentRequest({ ...command, reservationId: randomUUID() }, { agentId: id.lead, runId: nextLead }, id.root), h.ctx);
    expect(wrong).toMatchObject({ status: 409, body: { code: "n1_resume_reservation_mismatch" } });
    const child = await handleN1AgentApi(agentRequest(command, { agentId: id.lead, runId: nextLead }, id.root), h.ctx);
    expect(child).toMatchObject({ status: 200, body: { outcome: "requested" } });
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
    expect(h.row().aggregate.n1).toMatchObject({ rootDispatchRunId: nextLead,
      contributions: [expect.objectContaining({ dispatchRunId: nextChild }), expect.anything()] });
    const old = await handleN1AgentApi(agentRequest({ command: "record-contribution", commandId: randomUUID(), expectedVersion: h.row().version,
      contributionId: id.contributionA, commit: "a".repeat(40) }, { agentId: id.contributorA, runId: id.contributorRun }, id.childA), h.ctx);
    expect(old).toMatchObject({ status: 409, body: { code: "dispatch_run_mismatch" } });
    const spy = vi.spyOn(nativeAdapter, "councilNativeRequest").mockResolvedValue({ status: 200, body: {
      id: nextChild, companyId: id.company, agentId: id.contributorA, nativeIssueId: null, contextSnapshot: { issueId: id.childA },
      status: "succeeded", startedAt: new Date(2).toISOString(), finishedAt: new Date(3).toISOString(),
      usageJson: { usageSource: "per_run", inputTokens: 60, cachedInputTokens: 40, outputTokens: 10 },
    } });
    try {
      await executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
        body: { command: "reconcile-contribution-usage", commandId: randomUUID(), contributionId: id.contributionA } });
      expect(settleAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ reservationId: resumed.reservationId,
        usage: expect.objectContaining({ units: 70 }), remainingExposure: expect.objectContaining({ units: 0 }) }));
    } finally { spy.mockRestore(); }
  });

  it("records a configured owner handover without rewriting historical attribution", async () => {
    const h = interrupted(); const nextOwner = randomUUID();
    vi.mocked(h.ctx.companies.get).mockResolvedValue({ id: id.company, defaultResponsibleUserId: nextOwner } as never);
    await expect(h.apply()).rejects.toMatchObject({ code: "owner_required" });
    await h.apply(nextOwner);
    expect(h.row()).toMatchObject({ owner_user_id: nextOwner, aggregate: { ownerUserId: nextOwner,
      n1: { resume: { previousOwnerUserId: id.owner, authorizedBy: nextOwner } } } });
    expect(h.row().aggregate.journal[0]).toEqual(h.priorJournal);
    expect((await h.apply(nextOwner)).outcome).toBe("replayed");
  });

  it("binds only the single observed resumed lead run without creating another wake", async () => {
    const h = interrupted(); await h.apply(); const runId = randomUUID();
    const state = h.row().aggregate.n1 as N1State;
    h.advanceMission(a => ({ ...a, n1: { ...a.n1, rootDispatchState: "unknown", rootDispatchRunId: null } }));
    vi.mocked(readAdmission).mockResolvedValue({ ...h.envelope, reservations: [...h.envelope.reservations,
      { reservationId: state.activationReservationId, missionId: id.mission, status: "reserved", ownerReplacementCommandId: state.resume!.commandId }] } as never);
    h.getOrchestration.mockResolvedValue({ runs: [{ id: id.leadRun }, { id: runId }] } as never);
    const spy = vi.spyOn(nativeAdapter, "councilNativeRequest").mockResolvedValue({ status: 200, body: {
      id: runId, companyId: id.company, agentId: id.lead, nativeIssueId: null, contextSnapshot: { issueId: id.root },
      status: "running", startedAt: new Date().toISOString(), finishedAt: null,
    } });
    const body = { command: "bind-resumed-lead-run", commandId: randomUUID(), expectedVersion: h.row().version, runId };
    const bind = () => executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner, body });
    try {
      h.getOrchestration.mockResolvedValueOnce({ runs: [{ id: id.leadRun }, { id: runId }, { id: randomUUID() }] } as never);
      await expect(bind()).rejects.toMatchObject({ code: "n1_resume_run_mismatch" });
      expect((await bind()).outcome).toBe("applied");
      expect((await bind()).outcome).toBe("replayed");
      expect(h.row().aggregate.n1).toMatchObject({ rootDispatchState: "requested", rootDispatchRunId: runId });
      expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it.each(["unknown dispatch", "unsettled cost", "active run", "already resumed", "candidate"])("refuses %s without a wake or reservation", async kind => {
    const h = interrupted();
    if (kind === "unsettled cost") h.envelope.reservations[0].status = "reserved";
    else if (kind === "active run") h.getOrchestration.mockResolvedValue({ companyId: id.company, issueId: id.root,
      runs: [{ id: id.leadRun, issueId: id.root, status: "running", finishedAt: null }], invocationBlocks: [], openBudgetIncidents: [] } as never);
    else {
      h.advanceMission(a => { const state = a.n1 as N1State;
        if (kind === "unknown dispatch") state.contributions[0].dispatchState = "unknown";
        if (kind === "already resumed") state.resume = {} as never;
        if (kind === "candidate") state.candidate = {} as never;
        return a;
      }); h.body.expectedVersion = h.row().version;
    }
    await expect(h.apply()).rejects.toThrow();
    expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
  });

  it("rejects forged, consumed and cross-target admission grants", async () => {
    const h = interrupted(); await h.apply(); const aggregate = h.row().aggregate; const grant = (aggregate.n1 as N1State).resume!;
    const binding = { missionId: id.mission, effectId: grant.commandId, reservationId: grant.lead.reservationId,
      attempt: { kind: "resume" as const, ordinal: 1 }, ownerReplacementCommandId: grant.commandId };
    expect(n1ResumeAdmissionFailure(aggregate, h.envelope as never, binding, id.owner, id.owner)).toBeNull();
    for (const patch of [{ reservationId: randomUUID() }, { effectId: id.contributionB }, { ownerReplacementCommandId: randomUUID() },
      { attempt: { kind: "resume" as const, ordinal: 2 } }]) {
      expect(n1ResumeAdmissionFailure(aggregate, h.envelope as never, { ...binding, ...patch }, id.owner, id.owner)).not.toBeNull();
    }
    (aggregate.n1 as N1State).rootDispatchState = "claimed";
    expect(n1ResumeAdmissionFailure(aggregate, h.envelope as never, binding, id.owner, id.owner)).not.toBeNull();
  });
});

const nativeProfile = {
  kind: "paperclip-orchestration-tokens-v1",
  periodKey: "fixture-2026-09",
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2099-10-01T00:00:00.000Z",
  periodAllowanceUnits: 100_000,
  runReservationUnits: 20_000,
  initialKnownUsageUnits: 0,
  initialExposureUnits: 0,
  initialTokenAccountingSource: "fixture:fresh-company-and-period",
};

function nativeEnvelope(reservations: Array<Record<string, unknown>>) {
  return {
    version: 4,
    periodKey: nativeProfile.periodKey,
    periodStart: nativeProfile.periodStart,
    periodEnd: nativeProfile.periodEnd,
    measurement: {
      status: "known", source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger", unit: "tokens",
    },
    allowance: {
      status: "known", source: "plugin-config:n1OperatingProfile:initial-token-accounting:fixture:fresh-company-and-period",
      periodUnits: nativeProfile.periodAllowanceUnits, taskUnits: nativeProfile.runReservationUnits, knownUsageUnits: 0,
    },
    exposure: {
      status: "known", source: "plugin-config:n1OperatingProfile:initial-token-accounting:fixture:fresh-company-and-period", units: 0,
    },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
    reservations,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("PAPERCLIP_HOME", "/tmp/paperclip-council-package-n1-tests");
  vi.mocked(readAdmission).mockResolvedValue({
    companyId: id.company,
    periodKey: "fixture-2026-09",
    version: 4,
    measurement: { status: "known", source: "fixture:local-sandbox", usedUnits: 0 },
    allowance: { status: "known", source: "fixture:local-sandbox", limitUnits: 10 },
    exposure: { status: "known", source: "fixture:local-sandbox", reservedUnits: 0 },
  } as never);
  vi.mocked(reserveAdmission).mockResolvedValue({ reservation: { status: "reserved" } } as never);
  vi.mocked(settleAdmission).mockResolvedValue({ outcome: "settled" } as never);
});

describe("N1 mission transitions", () => {
  it("launches physical lead and contributor variants and accepts only their exact return identities", async () => {
    const leadVariant = randomUUID(), contributorVariant = randomUUID();
    const value = activeAggregate();
    value.modelSelection = { protocol: "native-variants-v1", choices: [], tasks: [] };
    value.n1 = { ...value.n1, rootDispatchState: undefined, rootDispatchRunId: undefined };
    const reservationId = value.n1.activationReservationId as string;
    const h = harness(value);
    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }));
    vi.mocked(readAdmission).mockResolvedValue({ version: 4,
      periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString(),
      reservations: [{ reservationId, missionId: id.mission, status: "reserved" }] } as never);
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalAgentId, profileId, revision) => ({
      logicalAgentId, agentId: logicalAgentId === id.lead ? leadVariant : contributorVariant,
      roleKey: logicalAgentId === id.lead ? "lead" : "contributor-1", profileId, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [],
    }));
    h.update.mockImplementation(async (...args: unknown[]) => {
      const issue = h.issues.get(String(args[0])); const patch = args[1] as { assigneeAgentId?: string; description?: string };
      if (issue && patch.assigneeAgentId) issue.assigneeAgentId = patch.assigneeAgentId;
      if (issue && patch.description) Object.assign(issue, { description: patch.description });
    });
    h.requestWakeup.mockImplementation(async (...args: unknown[]) => {
      const issueId = String(args[0]); const issue = h.issues.get(issueId)!;
      const launch = h.row().aggregate.modelSelection!.tasks.flatMap(task => task.launches).find(item => item.issueId === issueId)!;
      expect(launch).toMatchObject({ state: "wake_claimed", agentId: issue.assigneeAgentId });
      expect(issue.assigneeAgentId).toBe(issueId === id.root ? leadVariant : contributorVariant);
      issue.status = "in_progress";
      return { queued: true, runId: issueId === id.root ? id.leadRun : id.contributorRun };
    });
    await executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 } });
    expect(h.row().aggregate.responsibilities.integrationLeadAgentId).toBe(id.lead);
    expect(h.row().aggregate.modelSelection!.tasks[0]!.launches[0]).toMatchObject({ logicalAgentId: id.lead, agentId: leadVariant, runId: id.leadRun, state: "bound" });
    expect(await handleN1AgentApi(agentRequest({ command: "inspect" }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx))
      .toMatchObject({ status: 403, body: { code: "integration_lead_required" } });
    expect(await handleN1AgentApi(agentRequest({ command: "inspect" }, { agentId: leadVariant, runId: id.leadRun }, id.root), h.ctx))
      .toMatchObject({ status: 200 });
    const planned = await handleN1AgentApi(agentRequest({ command: "plan", commandId: randomUUID(), expectedVersion: h.row().version, contributions: plan },
      { agentId: leadVariant, runId: id.leadRun }, id.root), h.ctx);
    expect(planned).toMatchObject({ status: 200, body: { outcome: "applied" } });
    h.advanceMission(current => ({ ...current, n1: { ...current.n1,
      contributions: plan.map((slot, index) => ({ ...slot, issueState: "confirmed", childIssueId: index ? id.childB : id.childA })) } }));
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog" }));
    const childReservationId = randomUUID();
    expect(await handleN1AgentApi(agentRequest({ command: "dispatch", commandId: randomUUID(), expectedVersion: h.row().version,
      contributionId: id.contributionA, reservationId: childReservationId, requestedUnits: 1 }, { agentId: leadVariant, runId: id.leadRun }, id.root), h.ctx))
      .toMatchObject({ status: 200, body: { outcome: "requested" } });
    const record = { command: "record-contribution", commandId: randomUUID(), expectedVersion: h.row().version,
      contributionId: id.contributionA, commit: "a".repeat(40) };
    for (const actor of [{ agentId: id.contributorA, runId: id.contributorRun }, { agentId: contributorVariant, runId: randomUUID() }]) {
      expect(await handleN1AgentApi(agentRequest(record, actor, id.childA), h.ctx)).toMatchObject({ status: 403 });
    }
    expect(await handleN1AgentApi(agentRequest(record, { agentId: contributorVariant, runId: id.contributorRun }, id.childA), h.ctx))
      .toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(h.assertCheckoutOwner).toHaveBeenLastCalledWith({ companyId: id.company, issueId: id.childA,
      actorAgentId: contributorVariant, actorRunId: id.contributorRun });
    expect(h.row().aggregate.n1!.contributions).toEqual(expect.arrayContaining([expect.objectContaining({
      contributionId: id.contributionA, assigneeAgentId: id.contributorA, dispatchReservationId: childReservationId, authorRunId: id.contributorRun, commit: "a".repeat(40) })]));
    expect(h.row().aggregate.commandReceipts.at(-1)?.actorId).toBe(contributorVariant);
    expect(h.row().aggregate.compositions).toEqual(value.compositions);
    expect(h.requestWakeup).toHaveBeenCalledTimes(2);
  });

  it("never repeats an ambiguous root wake and blocks a new start command until reconciliation", async () => {
    const value = activeAggregate();
    const state = value.n1 as { activationReservationId: string; rootDispatchState?: string; rootDispatchRunId?: string };
    delete state.rootDispatchState;
    delete state.rootDispatchRunId;
    const h = harness(value);
    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }));
    vi.mocked(readAdmission).mockResolvedValue({
      companyId: id.company,
      periodKey: "fixture-2026-09",
      version: 4,
      periodStart: new Date(Date.now() - 60_000).toISOString(),
      periodEnd: new Date(Date.now() + 60_000).toISOString(),
      reservations: [{
        reservationId: state.activationReservationId,
        missionId: id.mission,
        status: "reserved",
      }],
    } as never);
    h.requestWakeup.mockResolvedValue({ queued: true, runId: null });
    const body = { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 };

    const first = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body,
    });
    expect(first.outcome).toBe("unknown");
    expect(h.row().aggregate.n1).toMatchObject({ rootDispatchState: "unknown", rootDispatchRunId: null });
    expect(h.row().aggregate.effectIntents).toContainEqual(expect.objectContaining({
      kind: "root_wakeup",
      state: "unknown",
      reservationId: state.activationReservationId,
    }));
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(reserveAdmission).not.toHaveBeenCalled();

    const replay = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body,
    });
    expect(replay.outcome).toBe("replayed");
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: { ...body, commandId: randomUUID(), expectedVersion: 3 },
    })).rejects.toMatchObject({ status: 409, code: "root_dispatch_unavailable" });
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps the root model launch ready when the atomic workflow claim loses its CAS", async () => {
    const value = activeAggregate();
    value.modelSelection = { protocol: "native-variants-v1", choices: [], tasks: [] };
    const state = value.n1!;
    state.rootDispatchState = undefined; state.rootDispatchRunId = undefined;
    const h = harness(value);
    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }));
    vi.mocked(readAdmission).mockResolvedValue({ version: 4,
      periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString(),
      reservations: [{ reservationId: state.activationReservationId, missionId: id.mission, status: "reserved" }] } as never);
    vi.mocked(inspectVariant).mockResolvedValue({ logicalAgentId: id.lead, agentId: id.lead, roleKey: "lead",
      profileId: "sol-medium", revision: "1", ready: true, expected: {}, observed: {}, gaps: [] });
    h.update.mockImplementation(async (...args: unknown[]) => {
      const issue = h.issues.get(String(args[0])); const patch = args[1] as { description?: string };
      if (issue && patch.description) Object.assign(issue, { description: patch.description });
    });
    const persist = h.execute.getMockImplementation()!;
    h.execute.mockImplementationOnce(persist).mockImplementationOnce(persist).mockResolvedValueOnce({ rowCount: 0 });

    await expect(executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 } }))
      .rejects.toMatchObject({ status: 409, code: "version_conflict" });

    expect(h.row().aggregate.modelSelection!.tasks[0]!.launches[0]).toMatchObject({ state: "ready", runId: null });
    expect(h.row().aggregate.n1).not.toHaveProperty("rootDispatchState");
    expect(h.row().aggregate.effectIntents).not.toContainEqual(expect.objectContaining({ kind: "root_wakeup" }));
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("commits neither the bound model run nor requested workflow state when their shared CAS loses", async () => {
    const value = activeAggregate();
    value.modelSelection = { protocol: "native-variants-v1", choices: [], tasks: [] };
    const state = value.n1!;
    state.rootDispatchState = undefined; state.rootDispatchRunId = undefined;
    const h = harness(value);
    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }));
    vi.mocked(readAdmission).mockResolvedValue({ version: 4,
      periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 60_000).toISOString(),
      reservations: [{ reservationId: state.activationReservationId, missionId: id.mission, status: "reserved" }] } as never);
    vi.mocked(inspectVariant).mockResolvedValue({ logicalAgentId: id.lead, agentId: id.lead, roleKey: "lead",
      profileId: "sol-medium", revision: "1", ready: true, expected: {}, observed: {}, gaps: [] });
    h.update.mockImplementation(async (...args: unknown[]) => {
      const issue = h.issues.get(String(args[0])); const patch = args[1] as { description?: string };
      if (issue && patch.description) Object.assign(issue, { description: patch.description });
    });
    h.requestWakeup.mockResolvedValue({ queued: true, runId: id.leadRun });
    const persist = h.execute.getMockImplementation()!;
    let rejectedCombinedWake = false;
    h.execute.mockImplementation(async (...args: Parameters<typeof persist>) => {
      const aggregate = JSON.parse(String(args[1][0])) as MissionAggregate;
      const launch = aggregate.modelSelection?.tasks.flatMap(task => task.launches)
        .find(item => item.launchKey === state.activationReservationId);
      if (launch?.state === "bound" && aggregate.n1?.rootDispatchState === "requested") {
        rejectedCombinedWake = true;
        return { rowCount: 0 };
      }
      return persist(...args);
    });

    await expect(executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 } }))
      .rejects.toMatchObject({ status: 409, code: "version_conflict" });

    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(rejectedCombinedWake).toBe(true);
    expect(h.row().aggregate.modelSelection!.tasks[0]!.launches[0]).toMatchObject({ state: "wake_claimed", runId: null });
    expect(h.row().aggregate.n1).toMatchObject({ rootDispatchState: "claimed" });
    expect(h.row().aggregate.n1).not.toHaveProperty("rootDispatchRunId");
    expect(h.row().aggregate.effectIntents).toContainEqual(expect.objectContaining({ kind: "root_wakeup", state: "claimed" }));
  });

  it("requires the configured owner and eligible pinned agents before activation, while preserving exact roster revisions", async () => {
    const h = harness();
    const body = {
      command: "activate",
      commandId: randomUUID(),
      expectedVersion: 1,
      periodKey: "fixture-2026-09",
      reservationId: randomUUID(),
      requestedUnits: 3,
    };

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: randomUUID(),
      body,
    })).rejects.toMatchObject({ status: 403, code: "owner_required" });
    expect(reserveAdmission).not.toHaveBeenCalled();

    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "in_progress" }));
    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body,
    })).rejects.toMatchObject({ status: 409, code: "root_ownership_changed" });
    expect(reserveAdmission).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();

    h.issues.set(id.root, nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }));

    const result = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body,
    });

    expect(result.outcome).toBe("applied");
    expect(h.row().aggregate).toMatchObject({
      phase: "executing",
      control: { status: "active" },
      compositions: {
        status: "pinned",
        team: { rosterId: id.team, revision: id.teamRevision },
        council: { rosterId: id.council, revision: id.councilRevision },
      },
    });
    expect(reserveAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      companyId: id.company,
      missionId: id.mission,
      requestedUnits: 3,
      expectedVersion: 4,
    }));
  });

  it("rejects a stale activation before reserving and conservatively retains a reservation after a CAS race", async () => {
    const h = harness();
    const body = {
      command: "activate", commandId: randomUUID(), expectedVersion: 2,
      periodKey: "fixture-2026-09", reservationId: randomUUID(), requestedUnits: 3,
    };
    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body,
    })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(reserveAdmission).not.toHaveBeenCalled();

    vi.mocked(readAdmission).mockResolvedValueOnce({
      version: 4,
      measurement: { status: "known", source: "fixture:local-sandbox" },
      allowance: { status: "known", source: "fixture:local-sandbox" },
      exposure: { status: "known", source: "fixture:local-sandbox" },
    } as never).mockResolvedValueOnce({
      version: 5, reservations: [{ reservationId: body.reservationId, status: "reserved" }],
    } as never);
    h.execute.mockResolvedValueOnce({ rowCount: 0 });
    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner,
      body: { ...body, expectedVersion: 1 },
    })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("does not release a shared reservation when identical activations race", async () => {
    const h = harness();
    const body = {
      command: "activate", commandId: randomUUID(), expectedVersion: 1,
      periodKey: "fixture-2026-09", reservationId: randomUUID(), requestedUnits: 3,
    };
    const results = await Promise.allSettled([0, 1].map(() => executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body,
    })));
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(h.row().aggregate.n1).toMatchObject({ activationReservationId: body.reservationId });
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("refuses a manually started lead run without a confirmed dispatch identity", async () => {
    const value = activeAggregate();
    value.n1 = { ...(value.n1 as object), rootDispatchState: undefined, rootDispatchRunId: undefined };
    const h = harness(value);
    const refused = await handleN1AgentApi(agentRequest({
      command: "plan", commandId: randomUUID(), expectedVersion: 1, contributions: plan,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(refused).toMatchObject({ status: 409, body: { code: "root_dispatch_run_mismatch" } });
    expect(h.assertCheckoutOwner).not.toHaveBeenCalled();
  });

  it("binds a fixture contribution through the public owner command without a native wake", async () => {
    const reservationId = randomUUID();
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: [{
        ...plan[0],
        issueState: "confirmed",
        childIssueId: id.childA,
      }],
    };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({
      id: id.childA,
      parentId: id.root,
      assigneeAgentId: id.contributorA,
      status: "in_progress",
    }));

    const result = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "fixture-bind-contribution-run",
        fixtureSource: "fixture:local-sandbox",
        commandId: randomUUID(),
        expectedVersion: 1,
        contributionId: id.contributionA,
        reservationId,
        requestedUnits: 1,
        runId: id.contributorRun,
      },
    });

    expect(result.outcome).toBe("applied");
    expect(h.row().aggregate.n1).toMatchObject({
      contributions: [{
        contributionId: id.contributionA,
        dispatchState: "requested",
        dispatchReservationId: reservationId,
        dispatchRunId: id.contributorRun,
      }],
    });
    expect(reserveAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      reservationId,
      effectId: id.contributionA,
      requestedUnits: 1,
      expectedVersion: 4,
    }));
    expect(h.assertCheckoutOwner).toHaveBeenCalledWith(expect.objectContaining({
      issueId: id.childA,
      actorAgentId: id.contributorA,
      actorRunId: id.contributorRun,
    }));
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("keeps fixture contribution binding unavailable outside the owned test runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }],
    };
    const h = harness(value);

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "fixture-bind-contribution-run",
        fixtureSource: "fixture:local-sandbox",
        commandId: randomUUID(),
        expectedVersion: 1,
        contributionId: id.contributionA,
        reservationId: randomUUID(),
        requestedUnits: 1,
        runId: id.contributorRun,
      },
    })).rejects.toMatchObject({ status: 403, code: "fixture_only" });
    expect(reserveAdmission).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("rejects a command UUID whose variant group is invalid", async () => {
    const h = harness(activeAggregate());
    const result = await handleN1AgentApi(agentRequest({
      command: "plan",
      commandId: "20f1c266-ef9e-453b-ea8d-b9e5f93d9fa7",
      expectedVersion: 1,
      contributions: plan,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(result).toMatchObject({
      status: 400,
      body: { code: "malformed_request", error: "commandId must be a UUID" },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("exposes the current mission version only to the admitted lead or mapped contribution run", async () => {
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: [{
        ...plan[0], issueState: "confirmed", childIssueId: id.childA,
        dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: id.contributorRun,
      }],
    };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({
      id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "in_progress",
    }));

    const leadInspection = await handleN1AgentApi(agentRequest(
      { command: "inspect" }, { agentId: id.lead, runId: id.leadRun }, id.root,
    ), h.ctx);
    expect(leadInspection).toMatchObject({ status: 200, body: { missionId: id.mission, version: 1, phase: "executing" } });

    const contributorInspection = await handleN1AgentApi(agentRequest(
      { command: "inspect" }, { agentId: id.contributorA, runId: id.contributorRun }, id.childA,
    ), h.ctx);
    expect(contributorInspection).toMatchObject({ status: 200, body: { version: 1 } });
    expect(h.assertCheckoutOwner).toHaveBeenCalledWith({
      issueId: id.childA,
      companyId: id.company,
      actorAgentId: id.contributorA,
      actorRunId: id.contributorRun,
    });

    const wrongRun = await handleN1AgentApi(agentRequest(
      { command: "inspect" }, { agentId: id.contributorA, runId: randomUUID() }, id.childA,
    ), h.ctx);
    expect(wrongRun).toMatchObject({ status: 409, body: { code: "dispatch_run_mismatch" } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not reserve for stale child dispatch and retains a reservation after a pre-effect CAS race", async () => {
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }],
    };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({
      id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog",
    }));
    const body = {
      command: "dispatch", commandId: randomUUID(), expectedVersion: 2,
      contributionId: id.contributionA, reservationId: randomUUID(), requestedUnits: 3,
    };
    const stale = await handleN1AgentApi(agentRequest(body, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(stale).toMatchObject({ status: 409, body: { code: "version_conflict" } });
    expect(reserveAdmission).not.toHaveBeenCalled();

    vi.mocked(readAdmission).mockResolvedValueOnce({ version: 4 } as never).mockResolvedValueOnce({
      version: 5, reservations: [{ reservationId: body.reservationId, status: "reserved" }],
    } as never);
    h.execute.mockResolvedValueOnce({ rowCount: 0 });
    const raced = await handleN1AgentApi(agentRequest({ ...body, expectedVersion: 1 },
      { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(raced).toMatchObject({ status: 409, body: { code: "version_conflict" } });
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("returns structured admission refusals from child dispatch without claiming an effect", async () => {
    const value = activeAggregate();
    value.n1 = { ...(value.n1 as object), contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }] };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog" }));
    for (const [status, code] of [[422, "admission_blocked"], [409, "version_conflict"]] as const) {
      vi.mocked(reserveAdmission).mockRejectedValueOnce(new AdmissionError(status, code, "Admission refused", { currentVersion: 7 }));
      const result = await handleN1AgentApi(agentRequest({
        command: "dispatch", commandId: randomUUID(), expectedVersion: 1,
        contributionId: id.contributionA, reservationId: randomUUID(), requestedUnits: 3,
      }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
      expect(result).toMatchObject({ status, body: { code, details: { currentVersion: 7 } } });
    }
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("rejects an unavailable child variant before reserving admission", async () => {
    const value = withBoundLead(activeAggregate());
    value.n1 = { ...value.n1!, contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }] };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog" }));
    vi.mocked(inspectVariant).mockResolvedValue({ logicalAgentId: id.contributorA, agentId: id.contributorA,
      roleKey: "contributor-1", profileId: "sol-medium", revision: "1", ready: false,
      expected: {}, observed: { availability: "blocked" }, gaps: ["instructions_drift"] });

    await expect(handleN1AgentApi(agentRequest({ command: "dispatch", commandId: randomUUID(), expectedVersion: 1,
      contributionId: id.contributionA, reservationId: randomUUID(), requestedUnits: 3 },
    { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx))
      .rejects.toMatchObject({ code: "model_variant_unavailable" });
    expect(reserveAdmission).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("keeps the exact child launch ready when its atomic workflow claim loses the CAS", async () => {
    const value = withBoundLead(activeAggregate());
    value.n1 = { ...value.n1!, contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }] };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog" }));
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalAgentId, profileId, revision) => ({
      logicalAgentId, agentId: logicalAgentId, roleKey: logicalAgentId === id.lead ? "lead" : "contributor-1",
      profileId, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [],
    }));
    h.update.mockImplementation(async (...args: unknown[]) => {
      const issue = h.issues.get(String(args[0])); const patch = args[1] as { description?: string };
      if (issue && patch.description) Object.assign(issue, { description: patch.description });
    });
    const persist = h.execute.getMockImplementation()!;
    h.execute.mockImplementationOnce(persist).mockImplementationOnce(persist).mockResolvedValueOnce({ rowCount: 0 });
    const reservationId = randomUUID();

    const raced = await handleN1AgentApi(agentRequest({ command: "dispatch", commandId: randomUUID(), expectedVersion: 1,
      contributionId: id.contributionA, reservationId, requestedUnits: 3 },
    { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(raced).toMatchObject({ status: 409, body: { code: "version_conflict" } });
    expect(reserveAdmission).toHaveBeenCalledTimes(1);
    expect(h.row().aggregate.modelSelection!.tasks.find(task => task.taskKey === id.contributionA)?.launches[0])
      .toMatchObject({ launchKey: reservationId, state: "ready", runId: null });
    expect((h.row().aggregate.n1 as { contributions: Array<Record<string, unknown>> }).contributions[0]).not.toHaveProperty("dispatchState");
    expect(h.row().aggregate.effectIntents).not.toContainEqual(expect.objectContaining({ kind: "child_wakeup" }));
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("retains the selected child launch after reservation refusal and blocks a replacement reservation key", async () => {
    const value = withBoundLead(activeAggregate());
    value.n1 = { ...value.n1!, contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }] };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog" }));
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalAgentId, profileId, revision) => ({
      logicalAgentId, agentId: logicalAgentId, roleKey: logicalAgentId === id.lead ? "lead" : "contributor-1",
      profileId, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [],
    }));
    const reservationId = randomUUID();
    vi.mocked(reserveAdmission).mockRejectedValueOnce(new AdmissionError(409, "version_conflict", "Admission changed"));
    const first = await handleN1AgentApi(agentRequest({ command: "dispatch", commandId: randomUUID(), expectedVersion: 1,
      contributionId: id.contributionA, reservationId, requestedUnits: 3 },
    { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(first).toMatchObject({ status: 409, body: { code: "version_conflict" } });
    expect(h.row().aggregate.modelSelection!.tasks.find(task => task.taskKey === id.contributionA)?.launches[0])
      .toMatchObject({ launchKey: reservationId, state: "selected" });

    await expect(handleN1AgentApi(agentRequest({ command: "dispatch", commandId: randomUUID(), expectedVersion: h.row().version,
      contributionId: id.contributionA, reservationId: randomUUID(), requestedUnits: 3 },
    { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx))
      .rejects.toMatchObject({ code: "model_previous_unknown" });
    expect(reserveAdmission).toHaveBeenCalledTimes(1);
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("accepts a two-owner plan only from the checked-out integration lead and rejects overlapping ownership", async () => {
    const h = harness(activeAggregate());
    const commandId = randomUUID();
    const runId = id.leadRun;

    const unauthorized = await handleN1AgentApi(
      agentRequest({ command: "plan", commandId, expectedVersion: 1, contributions: plan }, { agentId: id.reviewer, runId }, id.root),
      h.ctx,
    );
    expect(unauthorized).toMatchObject({ status: 403, body: { code: "integration_lead_required" } });
    expect(h.assertCheckoutOwner).not.toHaveBeenCalled();

    const overlap = await handleN1AgentApi(agentRequest({
      command: "plan",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributions: [plan[0], { ...plan[1], ownedPaths: ["src/a/"] }],
    }, { agentId: id.lead, runId }, id.root), h.ctx);
    expect(overlap).toMatchObject({ status: 422, body: { code: "ownership_overlap" } });

    const accepted = await handleN1AgentApi(
      agentRequest({ command: "plan", commandId, expectedVersion: 1, contributions: plan }, { agentId: id.lead, runId }, id.root),
      h.ctx,
    );
    expect(accepted).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(h.assertCheckoutOwner).toHaveBeenCalledWith({
      issueId: id.root,
      companyId: id.company,
      actorAgentId: id.lead,
      actorRunId: runId,
    });
    expect((h.row().aggregate.n1 as { contributions: unknown[] }).contributions).toEqual([
      expect.objectContaining({ contributionId: id.contributionA, assigneeAgentId: id.contributorA, ownedPaths: ["src/a/"] }),
      expect.objectContaining({ contributionId: id.contributionB, assigneeAgentId: id.contributorB, ownedPaths: ["src/b/"] }),
    ]);
  });

  it("carries the native plan and mandate into both child issues and their durable intents", async () => {
    const value = activeAggregate();
    value.mandate.objective = "Persist the public form through a shared SiteBinding service";
    value.mandate.acceptanceCriteria = ["SSR and Hono read the same durable SiteBinding"];
    value.mandate.commitments = ["Close the database connection after each invocation"];
    const h = harness(value);
    const nativePlan = {
      id: randomUUID(), issueId: id.root, latestRevisionId: randomUUID(),
      body: JSON.stringify({
        work: plan.map(slot => ({ ...slot,
          instruction: `Complete ${slot.title} with its tests`,
          interface: "One async read/write service shared by SSR and Hono",
          sourceRefs: ["AGENTS.md", "docs/implementation-plan.md"],
        })),
        integrationNotes: "Backend finishes before frontend consumes its contract",
      }),
    };
    h.documentGet.mockResolvedValue(nativePlan);
    const planned = await handleN1AgentApi(agentRequest({
      command: "plan", commandId: randomUUID(), expectedVersion: 1, contributions: plan,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(planned.status).toBe(200);
    h.create.mockImplementation(async () => {
      const intent = h.row().aggregate.effectIntents.at(-1)!;
      expect(intent.description).toContain(value.mandate.objective);
      expect(intent.description).toContain(value.mandate.acceptanceCriteria[0]);
      expect(intent.description).toContain(value.mandate.commitments[0]);
      expect(intent.description).toContain(nativePlan.body);
      expect(intent.description).toContain(nativePlan.latestRevisionId);
      expect(intent.description).toContain(`/api/issues/${id.root}/documents/plan`);
      return nativeIssue({ id: randomUUID(), parentId: id.root,
        assigneeAgentId: intent.assigneeAgentId as string, status: "backlog",
        originKind: "plugin:private.paperclip-council:contribution",
        originId: `mission:${id.mission}:contribution:${intent.contributionId}`,
      });
    });
    for (const slot of plan) {
      const request = agentRequest({ command: "materialize", commandId: randomUUID(),
        expectedVersion: h.row().version, contributionId: slot.contributionId,
      }, { agentId: id.lead, runId: id.leadRun }, id.root);
      expect(await handleN1AgentApi(request, h.ctx)).toMatchObject({ status: 200, body: { outcome: "confirmed" } });
      const description = h.row().aggregate.effectIntents.at(-1)!.description;
      expect(h.create).toHaveBeenLastCalledWith(expect.objectContaining({ description, parentId: id.root }));
      expect(await handleN1AgentApi(request, h.ctx)).toMatchObject({ status: 200, body: { outcome: "replayed" } });
    }
    expect(h.documentGet).toHaveBeenCalledWith(id.root, "plan", id.company);
    expect(h.documentGet).toHaveBeenCalledTimes(2);
    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("retains the mandate and an explicit parent reference for legacy missions without a plan document", async () => {
    const value = activeAggregate();
    value.n1 = { ...value.n1, contributions: plan.map(slot => ({ ...slot, issueState: "planned" })) };
    const h = harness(value);
    await handleN1AgentApi(agentRequest({ command: "materialize", commandId: randomUUID(),
      expectedVersion: 1, contributionId: id.contributionA,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    const description = h.row().aggregate.effectIntents[0]!.description as string;
    expect(description).toContain(value.mandate.objective);
    expect(description).toContain(`/api/issues/${id.root}`);
    expect(description).toContain("No native plan document exists");
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it("does not create an incomplete child or claim an effect when the native plan read fails", async () => {
    const value = activeAggregate();
    value.n1 = { ...value.n1, contributions: plan.map(slot => ({ ...slot, issueState: "planned" })) };
    const h = harness(value);
    h.documentGet.mockRejectedValue(new Error("native read unavailable"));
    const result = await handleN1AgentApi(agentRequest({ command: "materialize", commandId: randomUUID(),
      expectedVersion: 1, contributionId: id.contributionA,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(result).toMatchObject({ status: 409, body: { code: "contribution_context_unavailable" } });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("persists the creation claim before the native effect and replays an uncertain command without a second create", async () => {
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: plan.map((slot) => ({ ...slot, issueState: "planned" })),
    };
    const h = harness(value);
    h.create.mockImplementation(async () => {
      const persisted = h.row().aggregate;
      const slot = (persisted.n1 as { contributions: Array<{ issueState: string }> }).contributions[0];
      expect(slot.issueState).toBe("creation_claimed");
      expect(persisted.effectIntents).toEqual([
        expect.objectContaining({ kind: "child_issue_create", state: "creation_claimed", contributionId: id.contributionA }),
      ]);
      throw new Error("native response lost");
    });
    const body = { command: "materialize", commandId: randomUUID(), expectedVersion: 1, contributionId: id.contributionA };
    const request = agentRequest(body, { agentId: id.lead, runId: id.leadRun }, id.root);

    const first = await handleN1AgentApi(request, h.ctx);
    expect(first).toMatchObject({ status: 202, body: { outcome: "unknown", effect: { retryAllowed: false } } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect((h.row().aggregate.n1 as { contributions: Array<{ issueState: string; issueUnknown?: string }> }).contributions[0])
      .toMatchObject({ issueState: "unknown", issueUnknown: "create_failed_no_match" });

    const replay = await handleN1AgentApi(request, h.ctx);
    expect(replay).toMatchObject({ status: 200, body: { outcome: "replayed" } });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("requires contributor checkout ownership and records an integration failure without publishing a candidate", async () => {
    const unreserved = activeAggregate();
    unreserved.n1 = {
      ...(unreserved.n1 as object),
      contributions: [
        { ...plan[0], issueState: "confirmed", childIssueId: id.childA },
        { ...plan[1], issueState: "confirmed", childIssueId: id.childB, commit: "b".repeat(40), authorRunId: randomUUID() },
      ],
    };
    const failClosed = harness(unreserved);
    failClosed.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "in_progress" }));
    const blockedRecord = await handleN1AgentApi(agentRequest({
      command: "record-contribution",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributionId: id.contributionA,
      commit: "a".repeat(40),
    }, { agentId: id.contributorA, runId: randomUUID() }, id.childA), failClosed.ctx);
    expect(blockedRecord).toMatchObject({ status: 409, body: { code: "dispatch_not_confirmed" } });
    expect(failClosed.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(failClosed.execute).not.toHaveBeenCalled();

    const publishWithoutDispatch = activeAggregate();
    publishWithoutDispatch.n1 = {
      ...(publishWithoutDispatch.n1 as object),
      contributions: [
        { ...plan[0], issueState: "confirmed", childIssueId: id.childA, commit: "a".repeat(40), authorRunId: randomUUID() },
        { ...plan[1], issueState: "confirmed", childIssueId: id.childB, commit: "b".repeat(40), authorRunId: randomUUID() },
      ],
    };
    const blockedPublishHarness = harness(publishWithoutDispatch);
    const blockedPublish = await handleN1AgentApi(agentRequest({
      command: "publish",
      commandId: randomUUID(),
      expectedVersion: 1,
      attachmentId: randomUUID(),
      baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40),
      expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), blockedPublishHarness.ctx);
    expect(blockedPublish).toMatchObject({ status: 409, body: { code: "contributions_incomplete" } });
    expect(verifyIntegratedCandidate).not.toHaveBeenCalled();
    expect(blockedPublishHarness.execute).not.toHaveBeenCalled();

    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      contributions: [
        {
          ...plan[0], issueState: "confirmed", childIssueId: id.childA,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: id.contributorRun,
        },
        {
          ...plan[1], issueState: "confirmed", childIssueId: id.childB,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: randomUUID(),
          commit: "b".repeat(40), authorRunId: randomUUID(),
        },
      ],
    };
    const h = harness(value);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "in_progress" }));
    h.issues.set(id.childB, nativeIssue({ id: id.childB, parentId: id.root, assigneeAgentId: id.contributorB, status: "done" }));
    const contributorRun = id.contributorRun;

    const wrongRun = await handleN1AgentApi(agentRequest({
      command: "record-contribution", commandId: randomUUID(), expectedVersion: 1,
      contributionId: id.contributionA, commit: "a".repeat(40),
    }, { agentId: id.contributorA, runId: randomUUID() }, id.childA), h.ctx);
    expect(wrongRun).toMatchObject({ status: 409, body: { code: "dispatch_run_mismatch" } });

    const impersonated = await handleN1AgentApi(agentRequest({
      command: "record-contribution",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributionId: id.contributionA,
      commit: "a".repeat(40),
    }, { agentId: id.contributorB, runId: contributorRun }, id.childA), h.ctx);
    expect(impersonated).toMatchObject({ status: 403, body: { code: "contributor_required" } });

    const recorded = await handleN1AgentApi(agentRequest({
      command: "record-contribution",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributionId: id.contributionA,
      commit: "a".repeat(40),
    }, { agentId: id.contributorA, runId: contributorRun }, id.childA), h.ctx);
    expect(recorded).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(h.assertCheckoutOwner).toHaveBeenLastCalledWith({
      issueId: id.childA,
      companyId: id.company,
      actorAgentId: id.contributorA,
      actorRunId: contributorRun,
    });

    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "done" }));
    const beforeStalePublish = h.row();
    const stalePublish = await handleN1AgentApi(agentRequest({
      command: "publish", commandId: randomUUID(), expectedVersion: 1,
      attachmentId: randomUUID(), baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40), expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(stalePublish).toMatchObject({ status: 409, body: { code: "version_conflict" } });
    expect(h.row()).toEqual(beforeStalePublish);
    expect(verifyIntegratedCandidate).not.toHaveBeenCalled();
    vi.mocked(verifyIntegratedCandidate).mockRejectedValueOnce(new Error("candidate omits contribution B"));
    const publish = await handleN1AgentApi(agentRequest({
      command: "publish",
      commandId: randomUUID(),
      expectedVersion: 2,
      attachmentId: randomUUID(),
      baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40),
      expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(publish).toMatchObject({ status: 422, body: { code: "integration_failed", details: { currentVersion: 3 } } });
    expect(h.row().aggregate.phase).toBe("integrating");
    expect(h.row().aggregate.n1).toMatchObject({ lastIntegrationFailure: "candidate omits contribution B" });
    expect((h.row().aggregate.n1 as { candidate?: unknown }).candidate).toBeUndefined();
    expect(h.row().aggregate.commandReceipts).toHaveLength(1);

    vi.mocked(verifyIntegratedCandidate).mockResolvedValueOnce({
      outcome: "verified",
      publicationEligible: true,
      subject: { companyId: id.company, issueId: id.root },
      candidate: {
        attachmentId: id.root,
        byteSize: 100,
        sha256: "d".repeat(64),
        baseCommit: "0".repeat(40),
        candidateCommit: "c".repeat(40),
      },
      contributions: [],
      checks: [{ name: "fixture", status: "passed", detail: "checked" }],
    });
    const published = await handleN1AgentApi(agentRequest({
      command: "publish",
      commandId: randomUUID(),
      expectedVersion: 3,
      attachmentId: id.root,
      baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40),
      expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(published).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(h.row().aggregate).toMatchObject({
      phase: "ready_for_review",
      control: { status: "inactive", reason: "candidate_ready_for_review" },
      n1: { candidate: { outcome: "verified", publicationEligible: true } },
    });
  });

  it("requires the native profile to remain present while publishing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 10,
      contributions: [
        {
          ...plan[0], issueState: "confirmed", childIssueId: id.childA,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: randomUUID(),
          dispatchUsageBaselineUnits: 0, commit: "a".repeat(40), authorRunId: randomUUID(),
        },
        {
          ...plan[1], issueState: "confirmed", childIssueId: id.childB,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: randomUUID(),
          dispatchUsageBaselineUnits: 0, commit: "b".repeat(40), authorRunId: randomUUID(),
        },
      ],
    };
    const h = harness(value);
    h.configGet.mockResolvedValue({} as never);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "done" }));
    h.issues.set(id.childB, nativeIssue({ id: id.childB, parentId: id.root, assigneeAgentId: id.contributorB, status: "done" }));

    const result = await handleN1AgentApi(agentRequest({
      command: "publish", commandId: randomUUID(), expectedVersion: 1,
      attachmentId: id.root, baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40), expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(result).toMatchObject({ status: 409, body: { code: "g4_measurement_unqualified" } });
    expect(verifyIntegratedCandidate).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("persists the native lead usage baseline before requesting its wakeup", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchState: undefined,
      rootDispatchRunId: undefined,
      rootDispatchMode: undefined,
    };
    const activationReservationId = (value.n1 as { activationReservationId: string }).activationReservationId;
    const h = harness(value);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    h.issues.set(id.root, nativeIssue({
      id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog",
    }));
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId: activationReservationId,
      missionId: id.mission,
      status: "reserved",
    }]) as never);
    h.getOrchestration.mockResolvedValue({
      issueId: id.root,
      companyId: id.company,
      subtreeIssueIds: [id.root],
      relations: {},
      approvals: [],
      runs: [],
      costs: { costCents: 0, inputTokens: 20, cachedInputTokens: 3, outputTokens: 2, billingCode: null },
      openBudgetIncidents: [],
      invocationBlocks: [],
    } as never);
    h.requestWakeup.mockImplementation(async () => {
      expect(h.row().aggregate.n1).toMatchObject({
        rootDispatchState: "claimed",
        rootUsageBaselineUnits: 22,
      });
      return { queued: true, runId: id.leadRun };
    });

    const result = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 },
    });

    expect(result.outcome).toBe("requested");
    expect(h.row().aggregate.n1).toMatchObject({
      rootDispatchState: "requested",
      rootDispatchRunId: id.leadRun,
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 22,
    });
  });

  it("rejects native lead and child wakeups for agents outside codex_local cli", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const leadValue = activeAggregate();
    leadValue.n1 = {
      ...(leadValue.n1 as object),
      rootDispatchState: undefined,
      rootDispatchRunId: undefined,
      rootDispatchMode: undefined,
    };
    const activationReservationId = (leadValue.n1 as { activationReservationId: string }).activationReservationId;
    const leadHarness = harness(leadValue);
    leadHarness.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    leadHarness.issues.set(id.root, nativeIssue({
      id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog",
    }));
    leadHarness.agentGet.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: id.company,
      status: "active",
      adapterType: "process",
      adapterConfig: { engine: "cli" },
    }) as never);
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId: activationReservationId,
      missionId: id.mission,
      status: "reserved",
    }]) as never);

    await expect(executeN1BoardCommand(leadHarness.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: { command: "start-lead", commandId: randomUUID(), expectedVersion: 1 },
    })).rejects.toMatchObject({ status: 409, code: "native_agent_adapter_required" });
    expect(leadHarness.update).not.toHaveBeenCalled();
    expect(leadHarness.requestWakeup).not.toHaveBeenCalled();

    const childValue = activeAggregate();
    childValue.n1 = {
      ...(childValue.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 0,
      contributions: [{ ...plan[0], issueState: "confirmed", childIssueId: id.childA }],
    };
    const childHarness = harness(childValue);
    childHarness.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    childHarness.issues.set(id.childA, nativeIssue({
      id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "backlog",
    }));
    childHarness.agentGet.mockImplementation(async (agentId: string) => ({
      id: agentId,
      companyId: id.company,
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { engine: agentId === id.contributorA ? "app_server" : "cli" },
    }) as never);
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([]) as never);

    const refused = await handleN1AgentApi(agentRequest({
      command: "dispatch",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributionId: id.contributionA,
      reservationId: randomUUID(),
      requestedUnits: nativeProfile.runReservationUnits,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), childHarness.ctx);
    expect(refused).toMatchObject({ status: 409, body: { code: "native_agent_adapter_required" } });
    expect(reserveAdmission).not.toHaveBeenCalled();
    expect(childHarness.update).not.toHaveBeenCalled();
    expect(childHarness.requestWakeup).not.toHaveBeenCalled();
  });

  it("refuses native Beta after failed terminal Alpha settlement without reserving or waking", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const alphaReservationId = randomUUID();
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 0,
      contributions: [
        {
          ...plan[0],
          issueState: "confirmed",
          childIssueId: id.childA,
          dispatchState: "requested",
          dispatchReservationId: alphaReservationId,
          dispatchRunId: id.contributorRun,
          dispatchUsageBaselineUnits: 0,
        },
        { ...plan[1], issueState: "confirmed", childIssueId: id.childB },
      ],
    };
    const h = harness(value);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    h.issues.set(id.childA, nativeIssue({
      id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "in_progress",
    }));
    h.issues.set(id.childB, nativeIssue({
      id: id.childB, parentId: id.root, assigneeAgentId: id.contributorB, status: "backlog",
    }));
    h.getOrchestration.mockResolvedValue({
      issueId: id.childA,
      companyId: id.company,
      subtreeIssueIds: [id.childA],
      relations: {},
      approvals: [],
      runs: [{
        id: id.contributorRun,
        issueId: id.childA,
        agentId: id.contributorA,
        status: "failed",
        invocationSource: "on_demand",
        triggerDetail: null,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        error: "contribution not recorded",
        createdAt: new Date(0).toISOString(),
      }],
      costs: { costCents: 0, inputTokens: 80, cachedInputTokens: 30, outputTokens: 10, billingCode: null },
      openBudgetIncidents: [],
      invocationBlocks: [],
    } as never);
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId: alphaReservationId,
      missionId: id.mission,
      status: "reserved",
      settlementReceipts: [],
    }]) as never);
    vi.mocked(settleAdmission).mockResolvedValue({
      outcome: "settled",
      reservation: { reservationId: alphaReservationId, status: "settled" },
    } as never);

    const alphaSettlement = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "reconcile-contribution-usage",
        commandId: randomUUID(),
        contributionId: id.contributionA,
      },
    });
    expect(alphaSettlement).toMatchObject({ outcome: "settled" });
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId: alphaReservationId,
      missionId: id.mission,
      status: "settled",
    }]) as never);

    const refused = await handleN1AgentApi(agentRequest({
      command: "dispatch",
      commandId: randomUUID(),
      expectedVersion: 1,
      contributionId: id.contributionB,
      reservationId: randomUUID(),
      requestedUnits: nativeProfile.runReservationUnits,
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(refused).toMatchObject({ status: 409, body: { code: "prior_contribution_incomplete" } });
    expect(reserveAdmission).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("settles a terminal child without recording a contribution or dispatching the next child", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const reservationId = randomUUID();
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 0,
      contributions: [
        {
          ...plan[0],
          issueState: "confirmed",
          childIssueId: id.childA,
          dispatchState: "requested",
          dispatchReservationId: reservationId,
          dispatchRunId: id.contributorRun,
          dispatchUsageBaselineUnits: 10,
        },
        { ...plan[1], issueState: "confirmed", childIssueId: id.childB },
      ],
    };
    const h = harness(value);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId,
      missionId: id.mission,
      status: "reserved",
      settlementReceipts: [],
    }]) as never);
    h.getOrchestration.mockResolvedValue({
      issueId: id.childA,
      companyId: id.company,
      subtreeIssueIds: [id.childA],
      relations: {},
      approvals: [],
      runs: [{
        id: id.contributorRun,
        issueId: id.childA,
        agentId: id.contributorA,
        status: "failed",
        invocationSource: "on_demand",
        triggerDetail: null,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        error: "contribution not recorded",
        createdAt: new Date(0).toISOString(),
      }],
      costs: { costCents: 0, inputTokens: 180, cachedInputTokens: 90, outputTokens: 20, billingCode: null },
      openBudgetIncidents: [],
      invocationBlocks: [],
    } as never);
    vi.mocked(settleAdmission)
      .mockResolvedValueOnce({
        outcome: "settled",
        reservation: { reservationId, status: "settled" },
      } as never)
      .mockResolvedValueOnce({
        outcome: "replayed",
        reservation: { reservationId, status: "settled" },
      } as never);
    const before = h.row();
    const reconciliation = {
      command: "reconcile-contribution-usage",
      commandId: randomUUID(),
      contributionId: id.contributionA,
    };

    const result = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: reconciliation,
    });

    expect(result).toMatchObject({ outcome: "settled", mission: { aggregate: { phase: "executing" } } });
    expect(settleAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      reservationId,
      usage: expect.objectContaining({ units: 190 }),
      remainingExposure: expect.objectContaining({ units: 0 }),
    }));
    expect(h.row()).toEqual(before);
    expect((h.row().aggregate.n1 as { contributions: Array<Record<string, unknown>> }).contributions).toEqual([
      expect.not.objectContaining({ commit: expect.anything() }),
      expect.not.objectContaining({ dispatchRunId: expect.anything() }),
    ]);
    expect(h.requestWakeup).not.toHaveBeenCalled();

    const replayed = await executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: reconciliation,
    });
    expect(replayed).toMatchObject({ outcome: "replayed" });
    expect(settleAdmission).toHaveBeenCalledTimes(2);
    expect(vi.mocked(settleAdmission).mock.calls[0][1]).toEqual(vi.mocked(settleAdmission).mock.calls[1][1]);
  });

  it("keeps a native verified candidate integrating until terminal lead usage settles", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const contributionReservations = [randomUUID(), randomUUID()];
    const value = activeAggregate();
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 50,
      contributions: [
        {
          ...plan[0], issueState: "confirmed", childIssueId: id.childA,
          dispatchState: "requested", dispatchReservationId: contributionReservations[0], dispatchRunId: randomUUID(),
          dispatchUsageBaselineUnits: 0, commit: "a".repeat(40), authorRunId: randomUUID(),
        },
        {
          ...plan[1], issueState: "confirmed", childIssueId: id.childB,
          dispatchState: "requested", dispatchReservationId: contributionReservations[1], dispatchRunId: randomUUID(),
          dispatchUsageBaselineUnits: 0, commit: "b".repeat(40), authorRunId: randomUUID(),
        },
      ],
    };
    const h = harness(value);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: id.root, assigneeAgentId: id.contributorA, status: "done" }));
    h.issues.set(id.childB, nativeIssue({ id: id.childB, parentId: id.root, assigneeAgentId: id.contributorB, status: "done" }));
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope(contributionReservations.map((reservationId) => ({
      reservationId,
      status: "settled",
    }))) as never);
    vi.mocked(verifyIntegratedCandidate).mockResolvedValue({
      outcome: "verified",
      publicationEligible: true,
      subject: { companyId: id.company, issueId: id.root },
      candidate: {
        attachmentId: id.root, byteSize: 100, sha256: "d".repeat(64),
        baseCommit: "0".repeat(40), candidateCommit: "c".repeat(40),
      },
      contributions: [],
      checks: [{ name: "native", status: "passed", detail: "checked" }],
    });

    const published = await handleN1AgentApi(agentRequest({
      command: "publish", commandId: randomUUID(), expectedVersion: 1,
      attachmentId: id.root, baseCommit: "0".repeat(40),
      candidateCommit: "c".repeat(40), expectedSha256: "d".repeat(64),
    }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);

    expect(published).toMatchObject({ status: 200, body: { outcome: "applied" } });
    expect(h.row().aggregate).toMatchObject({
      phase: "integrating",
      control: { status: "active" },
      n1: { candidate: { outcome: "verified", publicationEligible: true }, candidateRecordedVersion: 2 },
    });

    h.getOrchestration.mockResolvedValue({
      issueId: id.root,
      companyId: id.company,
      subtreeIssueIds: [id.root],
      relations: {},
      approvals: [],
      runs: [{
        id: id.leadRun, issueId: id.root, agentId: id.lead, status: "succeeded",
        invocationSource: "on_demand", triggerDetail: null,
        startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
        error: null, createdAt: new Date(0).toISOString(),
      }],
      costs: { costCents: 0, inputTokens: 120, cachedInputTokens: 30, outputTokens: 50, billingCode: null },
      openBudgetIncidents: [],
      invocationBlocks: [],
    } as never);
    const reconcile = {
      command: "reconcile-lead-usage",
      commandId: randomUUID(),
      expectedVersion: 2,
    };
    const settlementReceipt = {
      commandId: reconcile.commandId,
      command: "settle",
      payloadHash: "a".repeat(64),
      appliedVersion: 5,
      recordedAt: new Date().toISOString(),
    };
    const rootReservation = (settlementReceipts: unknown[]) => ({
      reservationId: (value.n1 as { activationReservationId: string }).activationReservationId,
      status: settlementReceipts.length === 0 ? "reserved" : "settled",
      settlementReceipts,
      ...(settlementReceipts.length === 0 ? {} : {
        usage: {
          status: "known",
          source: `paperclip:issues.summaries.getOrchestration:terminal-token-ledger;run=${id.leadRun};issue-baseline=50;monetary-cost=unpriced`,
          units: 120,
        },
        remainingExposure: {
          status: "known",
          source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger;terminal=succeeded",
          units: 0,
        },
      }),
    });
    vi.mocked(readAdmission)
      .mockResolvedValueOnce(nativeEnvelope([...contributionReservations.map((reservationId) => ({
        reservationId,
        status: "settled",
      })), rootReservation([])]) as never)
      .mockResolvedValue(nativeEnvelope([...contributionReservations.map((reservationId) => ({
        reservationId,
        status: "settled",
      })), rootReservation([settlementReceipt])]) as never);
    vi.mocked(settleAdmission)
      .mockResolvedValueOnce({ outcome: "settled" } as never)
      .mockResolvedValue({ outcome: "replayed" } as never);
    h.execute.mockImplementationOnce(async () => {
      h.advanceMission((current) => ({
        ...current,
        journal: [...current.journal, { action: "concurrent_audit", at: new Date().toISOString() }],
      }));
      return { rowCount: 0 };
    });
    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body: reconcile,
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(h.row().aggregate.phase).toBe("integrating");

    const settled = await executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body: reconcile,
    });
    expect(settled).toMatchObject({ outcome: "replayed", mission: { aggregate: { phase: "ready_for_review" } } });
    expect(settleAdmission).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({
      usage: expect.objectContaining({ units: 120 }),
    }));
    expect(h.row().aggregate.control).toEqual({ status: "inactive", reason: "candidate_ready_for_review" });

    const settlementCallsAfterSuccess = vi.mocked(settleAdmission).mock.calls.length;
    const replayed = await executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body: reconcile,
    });
    expect(replayed).toMatchObject({
      outcome: "replayed",
      mission: { aggregate: { phase: "ready_for_review" } },
      receipt: { commandId: reconcile.commandId, command: "reconcile-lead-usage", appliedVersion: 4 },
    });
    expect(settleAdmission).toHaveBeenCalledTimes(settlementCallsAfterSuccess);

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: { ...reconcile, expectedVersion: 3 },
    })).rejects.toMatchObject({ status: 409, code: "command_identity_conflict" });
    expect(settleAdmission).toHaveBeenCalledTimes(settlementCallsAfterSuccess);
  });

  it("refuses settled-command recovery after an incompatible concurrent lifecycle change", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const value = activeAggregate();
    value.phase = "integrating";
    value.control = { status: "active" };
    value.n1 = {
      ...(value.n1 as object),
      rootDispatchMode: "native",
      rootUsageBaselineUnits: 50,
      candidateRecordedVersion: 2,
      candidate: {
        outcome: "verified",
        publicationEligible: true,
        candidate: {
          attachmentId: id.root, byteSize: 100, sha256: "d".repeat(64),
          baseCommit: "0".repeat(40), candidateCommit: "c".repeat(40),
        },
        contributions: [],
        checks: [{ name: "native", status: "passed", detail: "checked" }],
      },
    };
    const h = harness(value, 2);
    h.configGet.mockResolvedValue({ n1OperatingProfile: nativeProfile } as never);
    h.getOrchestration.mockResolvedValue({
      issueId: id.root,
      companyId: id.company,
      subtreeIssueIds: [id.root],
      relations: {},
      approvals: [],
      runs: [{
        id: id.leadRun, issueId: id.root, agentId: id.lead, status: "succeeded",
        invocationSource: "on_demand", triggerDetail: null,
        startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
        error: null, createdAt: new Date(0).toISOString(),
      }],
      costs: { costCents: 0, inputTokens: 120, cachedInputTokens: 30, outputTokens: 50, billingCode: null },
      openBudgetIncidents: [],
      invocationBlocks: [],
    } as never);
    const reconcile = {
      command: "reconcile-lead-usage",
      commandId: randomUUID(),
      expectedVersion: 2,
    };
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope([{
      reservationId: (value.n1 as { activationReservationId: string }).activationReservationId,
      status: "reserved",
      settlementReceipts: [],
    }]) as never);
    vi.mocked(settleAdmission).mockResolvedValueOnce({ outcome: "settled" } as never);
    h.execute.mockImplementationOnce(async () => {
      h.advanceMission((current) => ({
        ...current,
        phase: "blocked",
        control: { status: "blocked", reason: "concurrent_operator_block" },
        journal: [...current.journal, { action: "concurrent_operator_block", at: new Date().toISOString() }],
      }));
      return { rowCount: 0 };
    });

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body: reconcile,
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(h.row()).toMatchObject({ version: 3, aggregate: { phase: "blocked" } });

    await expect(executeN1BoardCommand(h.ctx, {
      companyId: id.company, missionId: id.mission, actorUserId: id.owner, body: reconcile,
    })).rejects.toMatchObject({ code: "candidate_not_integrating" });
    expect(settleAdmission).toHaveBeenCalledTimes(1);
  });

  it("retries terminal usage reconciliation with one stable command body per settlement", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const attempts = new Map<string, number>();
    const request = vi.fn(async (_actor: string, _method: string, _path: string, body?: unknown) => {
      const command = body as Record<string, unknown>;
      requests.push(structuredClone(command));
      const key = String(command.command);
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      return count === 1
        ? { status: 409, body: { code: "g4_usage_unavailable" }, headers: new Headers() }
        : { status: 200, body: { outcome: "settled" }, headers: new Headers() };
    });

    const result = await reconcileTerminalN1Usage({
      request,
      getRun: async (runId) => ({
        id: runId,
        agentId: id.contributorA,
        status: "succeeded",
        startedAt: new Date(0),
        finishedAt: new Date(1),
        error: null,
        usageJson: {},
      }),
      commandPath: "/n1/commands",
      companyId: id.company,
      leadRun: {
        id: id.leadRun,
        agentId: id.lead,
        status: "succeeded",
        startedAt: new Date(0),
        finishedAt: new Date(1),
        error: null,
        usageJson: {},
      },
      missionBeforeLeadReconciliation: {
        mission: {
          version: 7,
          aggregate: {
            n1: { contributions: [{ contributionId: id.contributionA, dispatchRunId: id.contributorRun }] },
          },
        },
      },
      observationOptions: {
        settlementMaxObservations: 2,
        settlementDelayMs: 0,
        terminalTimeoutMs: 10,
        terminalPollIntervalMs: 0,
      },
    });

    expect(result.leadSettlement.status).toBe(200);
    expect(result.contributionSettlements).toEqual([
      expect.objectContaining({ contributionId: id.contributionA, response: { status: 200, body: { outcome: "settled" } } }),
    ]);
    expect(requests.map((body) => body.command)).toEqual([
      "reconcile-lead-usage",
      "reconcile-lead-usage",
      "reconcile-contribution-usage",
      "reconcile-contribution-usage",
    ]);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[2]).toEqual(requests[3]);
    expect(requests[0].commandId).not.toBe(requests[2].commandId);
  });

  it("isolates child observation failures and still settles other terminal runs", async () => {
    const requestedCommands: string[] = [];
    const result = await reconcileTerminalN1Usage({
      request: async (_actor, _method, _path, body) => {
        requestedCommands.push(String((body as Record<string, unknown>).command));
        return { status: 200, body: { outcome: "settled" }, headers: new Headers() };
      },
      getRun: async (runId) => {
        if (runId === "alpha-run") throw new Error("alpha observation unavailable");
        return {
          id: runId,
          agentId: id.contributorB,
          status: "failed",
          startedAt: new Date(0),
          finishedAt: new Date(1),
          error: "beta failed after terminal usage was recorded",
          usageJson: {},
        };
      },
      commandPath: "/n1/commands",
      companyId: id.company,
      leadRun: {
        id: id.leadRun,
        agentId: id.lead,
        status: "failed",
        startedAt: new Date(0),
        finishedAt: new Date(1),
        error: "lead failed",
        usageJson: {},
      },
      missionBeforeLeadReconciliation: {
        mission: {
          version: 9,
          aggregate: {
            n1: { contributions: [
              { contributionId: id.contributionA, dispatchRunId: "alpha-run" },
              { contributionId: id.contributionB, dispatchRunId: "beta-run" },
            ] },
          },
        },
      },
      observationOptions: {
        settlementMaxObservations: 1,
        settlementDelayMs: 0,
        terminalTimeoutMs: 10,
        terminalPollIntervalMs: 0,
      },
    });

    expect(requestedCommands).toEqual(["reconcile-lead-usage", "reconcile-contribution-usage"]);
    expect(result.contributionSettlements).toEqual([
      expect.objectContaining({ contributionId: id.contributionA, response: { status: 0, body: expect.objectContaining({ code: "usage_observation_failed" }) } }),
      expect.objectContaining({ contributionId: id.contributionB, response: { status: 200, body: { outcome: "settled" } } }),
    ]);
    expect(result.runs.map((run) => run.id)).toEqual([id.leadRun, "beta-run"]);
  });
});

describe.each(["recover-integration", "recover-candidate"])("owner recovery: %s", (command) => {
  function recovery() {
    const initial = aggregate();
    initial.phase = "executing";
    initial.control = { status: "active" };
    const slots = plan.map((entry, i) => ({ ...entry, commit: (i ? "b" : "a").repeat(40),
      childIssueId: i ? id.childB : id.childA, authorRunId: i ? id.reviewer : id.contributorRun,
      dispatchRunId: i ? id.reviewer : id.contributorRun, dispatchState: "requested", issueState: "confirmed",
      dispatchReservationId: randomUUID(),
    }));
    const activationReservationId = randomUUID();
    initial.n1 = { periodKey: nativeProfile.periodKey, activationReservationId, rootDispatchRunId: id.leadRun,
      rootDispatchState: "requested", rootDispatchMode: "native", contributions: slots };
    initial.commandReceipts = [{ commandId: randomUUID(), command: "record-contribution", actorType: "agent", actorId: id.contributorA,
      payloadHash: "historical-payload", appliedVersion: 2, result: { missionId: id.mission, version: 2 }, recordedAt: new Date(0).toISOString() }];
    const h = harness(initial, 5);
    slots.forEach(slot => h.issues.set(slot.childIssueId, nativeIssue({ id: slot.childIssueId, parentId: id.root, assigneeAgentId: slot.assigneeAgentId, status: "done" })));
    const bindings = [{ issueId: id.root, runId: id.leadRun }, ...slots.map(slot => ({ issueId: slot.childIssueId, runId: slot.dispatchRunId }))];
    h.getOrchestration.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { issueId: string };
      const binding = bindings.find(item => item.issueId === input.issueId)!;
      return { runs: [{ id: binding.runId, status: "succeeded", issueId: input.issueId }] } as never;
    });
    const reservations = [activationReservationId, ...slots.map(slot => slot.dispatchReservationId)].map(reservationId => ({
      reservationId, missionId: id.mission, status: "settled", usage: { status: "known", units: 123 }, remainingExposure: { status: "known", units: 0 },
    }));
    vi.mocked(readAdmission).mockResolvedValue(nativeEnvelope(reservations) as never);
    vi.mocked(verifyIntegratedCandidate).mockResolvedValue({ outcome: "verified", publicationEligible: true,
      subject: { companyId: id.company, issueId: id.root }, candidate: { attachmentId: id.root, byteSize: 123,
        sha256: "d".repeat(64), baseCommit: "0".repeat(40), candidateCommit: "c".repeat(40) }, contributions: [], checks: [],
    });
    const body = { command, commandId: randomUUID(), expectedVersion: 5,
      contributionId: id.contributionA, previousCommit: "a".repeat(40), replacementCommit: "d".repeat(40),
      reason: "Recorded SHA was expanded incorrectly; owner verified the original Git object and run log",
      attachmentId: id.root, expectedSha256: "d".repeat(64), baseCommit: "0".repeat(40), candidateCommit: "c".repeat(40) };
    const apply = () => executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner, body });
    return { ...h, initial, body, apply, reservations };
  }

  it("routes owner recovery to review-ready with original receipts/attribution and no wake or acceptance", async () => {
    const h = recovery();
    const response = await handleMissionApi({ ...agentRequest({}, { agentId: id.lead, runId: id.leadRun }, id.root),
      routeKey: "mission-command", params: { companyId: id.company, missionId: id.mission }, body: h.body,
      actor: { actorType: "user", actorId: id.owner, userId: id.owner },
    }, h.ctx);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const state = h.row().aggregate;
    expect(state.phase).toBe("ready_for_review");
    expect(state.commandReceipts[0]).toEqual(h.initial.commandReceipts[0]);
    expect(state.commandReceipts[1]).toMatchObject({ command, actorType: "user", actorId: id.owner });
    const slots = state.n1!.contributions as Array<Record<string, any>>;
    if (command === "recover-integration") {
      expect(slots[0]).toMatchObject({ commit: h.body.replacementCommit, authorRunId: id.contributorRun, referenceRecovery: { previousCommit: h.body.previousCommit, actorUserId: id.owner } });
      expect(state.journal.at(-1)).toMatchObject({ action: "owner_recovered_integration", previousCommit: h.body.previousCommit, actorUserId: id.owner });
      expect(verifyIntegratedCandidate).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ missingReference: h.body.previousCommit }));
    } else {
      expect(slots).toEqual(h.initial.n1!.contributions);
      expect(state.journal.at(-1)).toMatchObject({ action: "owner_recovered_candidate", originalLeadRunId: id.leadRun, actorUserId: id.owner });
      expect(vi.mocked(verifyIntegratedCandidate).mock.calls[0][1]).not.toHaveProperty("missingReference");
    }
    expect(state.n2).toBeUndefined();
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(settleAdmission).not.toHaveBeenCalled();
    expect((await h.apply()).outcome).toBe("replayed");
    expect(h.execute).toHaveBeenCalledTimes(1);
    h.body.candidateCommit = "e".repeat(40);
    await expect(h.apply()).rejects.toMatchObject({ code: "command_identity_conflict" });
  });

  it("requires the configured owner and never allows the lead to repair its own record", async () => {
    const h = recovery();
    await expect(executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.lead, body: h.body }))
      .rejects.toMatchObject({ code: "owner_required" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("refuses unsettled usage or an extra/active native run", async () => {
    const h = recovery();
    h.reservations[0].remainingExposure.units = 1;
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_usage_unsettled" });
    h.reservations[0].remainingExposure.units = 0;
    h.getOrchestration.mockResolvedValue({ runs: [{ id: id.leadRun, status: "running" }] } as never);
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_run_not_terminal" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("recovers an explicitly resumed lead and child, retaining both settled histories", async () => {
    const h = resumedRecovery();
    await h.apply();
    expect(h.row().aggregate.phase).toBe("ready_for_review");
    expect(h.row().aggregate.n1!.resume).toEqual(h.resume);
    expect(h.requestWakeup).not.toHaveBeenCalled();
    expect(settleAdmission).not.toHaveBeenCalled();
  });

  it("rejects a third run or a still exposed historical reservation after resume", async () => {
    const h = resumedRecovery();
    h.extraRuns.push({ id: randomUUID(), status: "succeeded" });
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_run_not_terminal" });
    h.extraRuns.pop();
    h.reservations.at(-1)!.remainingExposure.units = 1;
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_usage_unsettled" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  function resumedRecovery() {
    const h = recovery();
    const state = h.initial.n1 as N1State;
    const targets = [{ issueId: id.root, reservationId: state.activationReservationId },
      { issueId: id.childA, reservationId: state.contributions[0].dispatchReservationId!, contributionId: id.contributionA }]
      .map(target => ({ ...target, priorRunId: randomUUID(), priorReservationId: randomUUID(), priorUsageBaselineUnits: 0 }));
    const resume = { commandId: randomUUID(), authorizedBy: id.owner, previousOwnerUserId: id.owner,
      authorizedAt: new Date().toISOString(), reason: "Explicit terminal resume", lead: targets[0], contributions: [targets[1]] };
    h.advanceMission(a => ({ ...a, n1: { ...a.n1, resume } }));
    h.body.expectedVersion = 6;
    h.reservations.push(...targets.map(target => ({ reservationId: target.priorReservationId, missionId: id.mission,
      status: "settled", usage: { status: "known", units: 123 }, remainingExposure: { status: "known", units: 0 } })));
    const extraRuns: Array<{ id: string; status: string }> = [];
    h.getOrchestration.mockImplementation(async (...args: unknown[]) => {
      const { issueId } = args[0] as { issueId: string };
      const runId = issueId === id.root ? id.leadRun : state.contributions.find(slot => slot.childIssueId === issueId)!.dispatchRunId;
      const prior = targets.find(target => target.issueId === issueId);
      return { runs: [{ id: runId, status: "succeeded" }, ...(prior ? [{ id: prior.priorRunId, status: "succeeded" }] : []),
        ...(issueId === id.root ? extraRuns : [])] } as never;
    });
    return { ...h, resume, extraRuns };
  }

  it("refuses stale versions, changed references and an existing candidate", async () => {
    const h = recovery();
    h.body.expectedVersion = 4;
    await expect(h.apply()).rejects.toMatchObject({ code: "version_conflict" });
    h.body.expectedVersion = 5;
    if (command === "recover-integration") {
      h.body.previousCommit = "e".repeat(40);
      await expect(h.apply()).rejects.toMatchObject({ code: "recovery_reference_mismatch" });
      h.body.previousCommit = "a".repeat(40);
    }
    h.advanceMission(a => ({ ...a, n1: { ...a.n1, candidate: {} } }));
    h.body.expectedVersion = 6;
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_unavailable" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("retains A as the dependency base and leaves all state unchanged on failed Git proof", async () => {
    const h = recovery();
    h.advanceMission(a => ({ ...a, n6: { expectedResult: { candidateCommit: "f".repeat(40) } } as never }));
    h.body.expectedVersion = 6;
    await expect(h.apply()).rejects.toMatchObject({ code: "recovery_source_mismatch" });
    h.body.baseCommit = "f".repeat(40);
    vi.mocked(verifyIntegratedCandidate).mockRejectedValueOnce(new Error("Unowned path"));
    await expect(h.apply()).rejects.toThrow("Unowned path");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("records explicit integration adjustments in the owner receipt and keeps the contribution identities", async () => {
    if (command !== "recover-candidate") return;
    const h = recovery();
    const body = { ...h.body, integrationAdjustedPaths: ["alpha.txt"] };
    await executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner, body });
    expect(verifyIntegratedCandidate).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ integrationAdjustedPaths: ["alpha.txt"] }));
    expect(h.row().aggregate.n1!.contributions).toEqual(h.initial.n1!.contributions);
    expect(h.row().aggregate.journal.at(-1)).toMatchObject({ integrationAdjustedPaths: ["alpha.txt"] });
  });
});

describe("existing hierarchy N1 identity", () => {
  it("uses the admitted coordinator and materializes guidance without replacing an existing nested leaf", async () => {
    const value = activeAggregate(), coordinator = randomUUID(), group = randomUUID();
    value.hierarchy = { protocol: "council-hierarchy-v1", maxContributions: 3, execution: "sequential", adoptExistingChildren: true,
      leaves: [{ contributionId: id.contributionA, issueId: id.childA, parentId: group, assigneeAgentId: id.contributorA,
        title: "Existing alpha", ownedPaths: ["alpha.txt"], descriptionHash: "pinned", documentRevisionId: "v1", blockedByIssueIds: [], pendingBlockerIds: [] }] };
    value.n1 = { ...(value.n1 as N1State), coordination: { issueId: coordinator, intentId: randomUUID(), state: "confirmed",
      commandId: randomUUID(), commandHash: "pinned", ownerUserId: id.owner, preparedVersion: 1 } };
    const h = harness(value);
    h.issues.set(coordinator, nativeIssue({ id: coordinator, parentId: null, assigneeAgentId: id.lead, status: "in_progress" }));
    h.issues.set(id.childA, nativeIssue({ id: id.childA, parentId: group, assigneeAgentId: id.contributorA, status: "backlog" }));
    const contributions = [{ contributionId: id.contributionA, assigneeAgentId: id.contributorA, title: "Existing alpha", ownedPaths: ["alpha.txt"] }];
    const wrong = await handleN1AgentApi(agentRequest({ command: "plan", commandId: randomUUID(), expectedVersion: 1, contributions }, { agentId: id.lead, runId: id.leadRun }, id.root), h.ctx);
    expect(wrong.status).toBe(404);
    const plan = await handleN1AgentApi(agentRequest({ command: "plan", commandId: randomUUID(), expectedVersion: 1, contributions }, { agentId: id.lead, runId: id.leadRun }, coordinator), h.ctx);
    expect(plan.status).toBe(200);
    const slot = (h.row().aggregate.n1 as N1State).contributions[0]!;
    expect(slot).toMatchObject({ childIssueId: id.childA, parentIssueId: group, issueState: "planned" });
    let doc: any = null;
    h.documentGet.mockImplementation(async () => doc);
    const upsert = vi.fn(async (body: any) => { doc = { ...body, latestRevisionId: "execution-v1" }; });
    (h.ctx.issues.documents as any).upsert = upsert;
    const before = structuredClone(h.issues.get(id.childA));
    const body = { command: "materialize", commandId: randomUUID(), expectedVersion: h.row().version, contributionId: id.contributionA };
    const materialized = await handleN1AgentApi(agentRequest(body, { agentId: id.lead, runId: id.leadRun }, coordinator), h.ctx);
    expect(materialized.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1); expect(doc.key).toBe(`council-execution-${id.mission}`);
    expect(doc.body).toContain("record-contribution"); expect(h.issues.get(id.childA)).toEqual(before);
    expect(h.create).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
    expect((h.row().aggregate.n1 as N1State).contributions[0]!.issueState).toBe("confirmed");
    expect((await handleN1AgentApi(agentRequest(body, { agentId: id.lead, runId: id.leadRun }, coordinator), h.ctx)).status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("one initial hierarchy lead resume", () => {
  afterEach(() => vi.restoreAllMocks());

  function stoppedHierarchy() {
    const value = withBoundLead(activeAggregate()), coordinator = randomUUID(), physicalLead = randomUUID();
    const oldReservation = String(value.n1!.activationReservationId), nextRun = randomUUID();
    value.nativeWakePolicy = { protocol: "council-native-wake-v2", rootBaseline: [], runLimit: 8 };
    value.hierarchy = { protocol: "council-hierarchy-v1", maxContributions: 2, execution: "sequential", adoptExistingChildren: true,
      leaves: plan.map((slot, i) => ({ ...slot, issueId: i ? id.childB : id.childA, parentId: id.root,
        descriptionHash: "pinned", documentRevisionId: "work-v1", blockedByIssueIds: [], pendingBlockerIds: [] })) };
    value.n1 = { ...value.n1!, rootDispatchMode: "native", rootUsageBaselineUnits: 0,
      coordination: { issueId: coordinator, intentId: randomUUID(), state: "confirmed", commandId: randomUUID(),
        commandHash: "original-creation-hash", ownerUserId: id.owner, preparedVersion: 3 },
      contributions: plan.map((slot, i) => ({ ...slot, issueState: "confirmed", childIssueId: i ? id.childB : id.childA, parentIssueId: id.root })) };
    Object.assign(value.modelSelection!.tasks[0]!.launches[0]!, { issueId: coordinator, agentId: physicalLead });
    value.continuity = { protocol: "council-continuity-v1", enabled: false, authorizedBy: id.owner,
      authorizedAt: new Date(0).toISOString(), deadline: new Date(Date.now() + 600_000).toISOString(),
      mandateHash: canonicalPayloadHash(value.mandate), n3Slots: [], commands: {
        "start-lead": { command: "start-lead", commandId: (value.n1 as N1State).coordination!.commandId, expectedVersion: 3 },
        "reconcile-lead-usage": { command: "reconcile-lead-usage", commandId: randomUUID() },
      } };
    value.commandReceipts = [{ commandId: (value.n1 as N1State).coordination!.commandId, command: "start-lead",
      actorType: "user", actorId: id.owner, payloadHash: canonicalPayloadHash(value.continuity.commands["start-lead"]),
      appliedVersion: 4, result: { missionId: id.mission, version: 4 }, recordedAt: new Date(0).toISOString() }];
    const h = harness(value, 17);
    h.configGet.mockResolvedValue({ n1OperatingProfile: { ...nativeProfile, maxCorrections: 1 } } as never);
    h.issues.set(coordinator, { ...nativeIssue({ id: coordinator, parentId: null, assigneeAgentId: physicalLead, status: "backlog" }), status: "blocked" } as never);
    for (const [issueId, assigneeAgentId] of [[id.childA, id.contributorA], [id.childB, id.contributorB]]) {
      h.issues.set(issueId!, nativeIssue({ id: issueId!, parentId: id.root, assigneeAgentId: assigneeAgentId!, status: "backlog" }));
    }
    const runs = [{ id: id.leadRun, issueId: coordinator, agentId: physicalLead, status: "succeeded",
      startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() }];
    const childRuns: typeof runs = [];
    h.getOrchestration.mockImplementation(async (...args: unknown[]) => {
      const issueId = (args[0] as { issueId: string }).issueId;
      return { issueId, companyId: id.company, runs: issueId === coordinator ? runs : issueId === id.childA ? childRuns : [],
        costs: { inputTokens: 90, cachedInputTokens: 70, outputTokens: 10, costCents: 0 },
        relations: {}, invocationBlocks: [], openBudgetIncidents: [] } as never;
    });
    const old = { reservationId: oldReservation, missionId: id.mission, status: "settled",
      usage: { status: "known", units: 100 }, remainingExposure: { status: "known", units: 0 }, settlementReceipts: [{ commandId: randomUUID() }] };
    const envelope = { ...nativeEnvelope([old]), companyId: id.company };
    envelope.limits.maxCorrections = 1;
    vi.mocked(readAdmission).mockImplementation(async () => envelope as never);
    vi.mocked(reserveAdmission).mockImplementation(async (_ctx, input) => {
      expect(n1ResumeAdmissionFailure(h.row().aggregate, envelope as never, input, id.owner, id.owner)).toBeNull();
      let reservation = envelope.reservations.find(r => r.reservationId === input.reservationId);
      if (!reservation) {
        reservation = { reservationId: input.reservationId, missionId: id.mission, status: "reserved",
          ownerReplacementCommandId: input.ownerReplacementCommandId };
        envelope.reservations.push(reservation);
      }
      return { reservation, envelope } as never;
    });
    vi.mocked(inspectVariant).mockResolvedValue({ logicalAgentId: id.lead, agentId: physicalLead, roleKey: "lead",
      profileId: "sol-medium", revision: "1", ready: true, expected: {}, observed: {}, gaps: [] });
    h.update.mockImplementation(async (...args: unknown[]) => { Object.assign(h.issues.get(String(args[0]))!, args[1]); });
    h.requestWakeup.mockImplementation(async () => {
      runs.push({ ...runs[0]!, id: nextRun, status: "running", finishedAt: null as never });
      return { queued: true, runId: nextRun };
    });
    vi.spyOn(nativeAdapter, "councilNativeRequest").mockImplementation(async (_ctx, _company, path) => {
      const run = runs.find(item => path.endsWith(item.id))!;
      return { status: 200, body: { ...run, companyId: id.company, nativeIssueId: null,
        contextSnapshot: { issueId: coordinator }, usageJson: { usageSource: "per_run", inputTokens: 90, cachedInputTokens: 70, outputTokens: 10 } } };
    });
    const body: Record<string, unknown> = { command: "prepare-n1-resume", commandId: randomUUID(), expectedVersion: 17,
      authorizeOneResume: true, authorizeContinuityResume: true, previousOwnerUserId: id.owner, reason: "Initial hierarchy lead profile binding repaired" };
    const apply = () => executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner, body });
    const job = { jobKey: "mission-continuity", runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString() } as PluginJobContext;
    const advance = async () => advanceContinuity(h.ctx, (await getMission(h.ctx, id.company, id.mission))!, job);
    return { ...h, value, coordinator, physicalLead, nextRun, old, envelope, body, apply, advance, runs, childRuns };
  }

  it("retains creation, leaves and costs, then schedules one new bound lead that can select a child profile", async () => {
    const h = stoppedHierarchy();
    expect((await h.advance()).code).toBe("continuity_disabled");
    await h.apply();
    const prepared = h.row().aggregate, grant = (prepared.n1 as N1State).resume!;
    expect(grant.lead).toMatchObject({ issueId: h.coordinator, priorRunId: id.leadRun, priorReservationId: h.old.reservationId });
    expect(grant.contributions).toEqual([]);
    expect(prepared.n1!.coordination).toEqual(h.value.n1!.coordination);
    expect(prepared.n1!.contributions).toEqual(h.value.n1!.contributions);
    expect(prepared.continuity).toEqual({ ...h.value.continuity, enabled: true, commands: {} });
    expect(prepared.journal).toContainEqual(expect.objectContaining({ action: "n1_resume_continuity_authorized", priorCommands: h.value.continuity!.commands }));
    expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
    expect((await h.apply()).outcome).toBe("replayed");
    expect((await h.advance()).code).toBe("start-lead");
    const started = h.row().aggregate, launches = started.modelSelection!.tasks[0]!.launches;
    expect(h.requestWakeup).toHaveBeenCalledExactlyOnceWith(h.coordinator, id.company,
      expect.objectContaining({ idempotencyKey: `council:n1:${grant.lead.reservationId}` }));
    expect(h.create).not.toHaveBeenCalled();
    expect(started.n1!.coordination).toEqual(h.value.n1!.coordination);
    expect(started.commandReceipts[0]).toEqual(h.value.commandReceipts[0]);
    expect(started.continuity!.commands["start-lead"]!.commandId).not.toBe(h.value.continuity!.commands["start-lead"]!.commandId);
    expect(started.hierarchy).toEqual(h.value.hierarchy); expect(started.mandate).toEqual(h.value.mandate);
    expect(started.nativeWakePolicy).toEqual(h.value.nativeWakePolicy);
    expect(started.n1!.activatedAt).toBe(h.value.n1!.activatedAt); expect(started.n1!.periodKey).toBe(h.value.n1!.periodKey);
    expect(h.envelope.reservations[0]).toEqual(h.old); expect(h.envelope.reservations).toHaveLength(2);
    expect(launches).toHaveLength(2); expect(launches[0]).toMatchObject(h.value.modelSelection!.tasks[0]!.launches[0]!);
    expect(launches[1]).toMatchObject({ previousLaunchKey: h.old.reservationId, launchKey: grant.lead.reservationId,
      issueId: h.coordinator, runId: h.nextRun, agentId: h.physicalLead, state: "bound", profileId: "sol-medium" });
    const input = agentRequest({ command: "select-model-profile", expectedVersion: h.row().version, taskKey: id.contributionA,
      interventionKey: id.contributionA, family: "implementation", profileId: "sol-medium", rationale: "Bounded first contribution" },
      { agentId: h.physicalLead, runId: h.nextRun }, h.coordinator);
    expect((await chooseModelProfile(h.ctx, input)).body.choice.authority).toBe("lead");
    expect(h.assertCheckoutOwner).toHaveBeenLastCalledWith({ companyId: id.company, issueId: h.coordinator,
      actorAgentId: h.physicalLead, actorRunId: h.nextRun });
    expect((await h.advance()).code).toBe("native_lead_running"); expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    await expect(chooseModelProfile(h.ctx, { ...input, actor: { ...input.actor, runId: id.leadRun } })).rejects.toThrow();
    Object.assign(h.runs[1]!, { status: "succeeded", finishedAt: new Date().toISOString() });
    await expect(h.advance()).rejects.toMatchObject({ code: "continuity_candidate_missing" });
    expect(settleAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ reservationId: grant.lead.reservationId,
      usage: expect.objectContaining({ units: 100 }), periodKey: h.value.n1!.periodKey }));
    expect(h.row().aggregate.continuity!.commands["reconcile-lead-usage"]!.commandId)
      .not.toBe(h.value.continuity!.commands["reconcile-lead-usage"]!.commandId);
    expect(h.envelope.reservations[0]).toEqual(h.old); expect(h.requestWakeup).toHaveBeenCalledTimes(1);
  });

  it("resumes the same coordinator before any plan without erasing settled usage, source or deadline", async () => {
    const h = stoppedHierarchy(); h.advanceMission(a => { a.n1!.contributions = []; return a; });
    h.body.expectedVersion = h.row().version;
    const before = h.row().aggregate;
    await h.apply();
    const prepared = h.row().aggregate;
    expect(prepared.n1!.contributions).toEqual([]);
    expect(prepared.hierarchy).toEqual(before.hierarchy);
    expect(prepared.mandate).toEqual(before.mandate);
    expect(prepared.continuity!.deadline).toBe(before.continuity!.deadline);
    expect(prepared.n1!.coordination).toEqual(before.n1!.coordination);
    expect(h.envelope.reservations[0]).toEqual(h.old);
    expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
    expect((await h.apply()).outcome).toBe("replayed");
    expect((await h.advance()).code).toBe("start-lead");
    expect(h.requestWakeup).toHaveBeenCalledExactlyOnceWith(h.coordinator, id.company, expect.anything());
    expect(h.create).not.toHaveBeenCalled();
    expect(inspectN1State({ ...h.row(), aggregate: h.row().aggregate } as unknown as MissionRecord)?.leadCommands?.protocol).toBe("council-lead-commands-v1");
  });

  it.each(["plan receipt", "plan journal", "child run"])("rejects cleared pre-plan state with %s", async kind => {
    const h = stoppedHierarchy(); h.advanceMission(a => {
      a.n1!.contributions = [];
      if (kind === "plan receipt") a.commandReceipts.push({ ...a.commandReceipts[0]!, command: "plan" });
      if (kind === "plan journal") a.journal.push({ action: "contribution_plan_recorded" });
      return a;
    });
    if (kind === "child run") h.childRuns.push({ ...h.runs[0]!, id: id.contributorRun, issueId: id.childA, agentId: id.contributorA });
    h.body.expectedVersion = h.row().version; const before = h.row();
    await expect(h.apply()).rejects.toThrow(); expect(h.row()).toEqual(before);
    expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
  });

  const invalidCases: Array<[string, (h: ReturnType<typeof stoppedHierarchy>) => void]> = [
    ["child dispatched", h => h.advanceMission(a => { (a.n1 as N1State).contributions[0]!.dispatchState = "requested"; return a; })],
    ["child run", h => { h.childRuns.push({ ...h.runs[0]!, id: id.contributorRun, issueId: id.childA, agentId: id.contributorA }); }],
    ["unknown cost", h => { h.old.usage.status = "unknown"; }],
    ["unknown lead", h => h.advanceMission(a => { a.n1!.rootDispatchState = "unknown"; return a; })],
    ["active lead", h => { h.runs[0]!.status = "running"; }],
    ["unknown coordinator", h => h.advanceMission(a => { (a.n1 as N1State).coordination!.state = "claimed"; return a; })],
    ["candidate", h => h.advanceMission(a => { a.n1!.candidate = {}; return a; })],
    ["second resume", h => h.advanceMission(a => { a.n1!.resume = {}; return a; })],
    ["continuity flag", h => { delete h.body.authorizeContinuityResume; }],
    ["already enabled", h => h.advanceMission(a => { a.continuity!.enabled = true; return a; })],
    ["deadline", h => h.advanceMission(a => { a.continuity!.deadline = new Date(0).toISOString(); return a; })],
    ["mandate", h => h.advanceMission(a => { a.continuity!.mandateHash = "changed"; return a; })],
    ["owner", h => h.advanceMission(a => { a.continuity!.authorizedBy = randomUUID(); return a; })],
    ["review command", h => h.advanceMission(a => { a.continuity!.commands["start-review"] = { commandId: randomUUID() }; return a; })],
    ["run limit", h => h.advanceMission(a => { a.nativeWakePolicy = { protocol: "council-native-wake-v2", rootBaseline: [], runLimit: 1 }; return a; })],
  ];
  it.each(invalidCases)("refuses %s without issuing a grant, reservation or wake", async (_kind, change) => {
    const h = stoppedHierarchy(); change(h); h.body.expectedVersion = h.row().version;
    const before = h.row();
    await expect(h.apply()).rejects.toThrow();
    expect(h.row()).toEqual(before); expect(h.create).not.toHaveBeenCalled();
    expect(reserveAdmission).not.toHaveBeenCalled(); expect(h.requestWakeup).not.toHaveBeenCalled();
  });

  it("retains an uncertain resumed wake without another reservation, identity or departure", async () => {
    const h = stoppedHierarchy(); await h.apply();
    h.requestWakeup.mockRejectedValueOnce(new Error("lost wake response"));
    await h.advance();
    const claimed = h.row().aggregate;
    expect(claimed.n1!.rootDispatchState).toBe("unknown");
    await expect(h.advance()).rejects.toMatchObject({ code: "continuity_lead_effect_unknown" });
    expect(h.row().aggregate).toEqual(claimed);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1); expect(reserveAdmission).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled();
  });

  it.each(["coordinator identity", "coordinator state", "stale start", "elapsed deadline"])(
    "rechecks %s before the new reservation or wake", async kind => {
      const h = stoppedHierarchy(); await h.apply();
      const expectedVersion = h.row().version;
      h.advanceMission(a => {
        const state = a.n1 as N1State;
        if (kind === "coordinator identity") state.coordination!.issueId = randomUUID();
        if (kind === "coordinator state") state.coordination!.state = "claimed";
        if (kind === "elapsed deadline") state.activatedAt = new Date(0).toISOString();
        return a;
      });
      await expect(executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner,
        body: { command: "start-lead", commandId: randomUUID(), expectedVersion: kind === "stale start" ? expectedVersion : h.row().version } })).rejects.toThrow();
      expect(reserveAdmission).not.toHaveBeenCalled(); expect(h.requestWakeup).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
    });
});

describe("hierarchy source integrity through two physical contribution dispatches", () => {
  afterEach(() => vi.restoreAllMocks());

  function composedHierarchy(profile = nativeProfile) {
    const value = withBoundLead(activeAggregate()), coordinator = randomUUID();
    const physical = [randomUUID(), randomUUID()], childRuns = [randomUUID(), randomUUID()];
    const config = { n1OperatingProfile: { ...profile, maxCorrections: 1 }, modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1" };
    const hierarchy = { protocol: "council-hierarchy-v1" as const, maxContributions: 2, execution: "sequential" as const, adoptExistingChildren: true };
    const product = [nativeIssue({ id: id.root, parentId: null, assigneeAgentId: id.lead, status: "backlog" }),
      ...[id.childA, id.childB].map((issueId, i) => nativeIssue({ id: issueId, parentId: id.root, assigneeAgentId: plan[i]!.assigneeAgentId, status: "backlog" }))]
      .map((issue, i) => ({ ...issue, title: `Product ${i}`, description: `Immutable product requirements ${i}.` }));
    const nodes = product.map((issue, i) => ({ issueId: issue.id, parentId: issue.parentId, title: issue.title,
      descriptionHash: canonicalPayloadHash(issue.description), assigneeAgentId: issue.assigneeAgentId, blockedByIssueIds: i === 2 ? [id.childA] : [] }));
    value.hierarchy = { ...hierarchy, nodes, leaves: plan.map((slot, i) => ({ ...slot, ...nodes[i + 1]!, parentId: id.root,
      assigneeAgentId: slot.assigneeAgentId, documentRevisionId: "work-v1", pendingBlockerIds: i ? [id.childA] : [] })) };
    value.n1 = { ...value.n1!, sourceBaseCommit: "b".repeat(40), rootDispatchMode: "native", rootUsageBaselineUnits: 0,
      coordination: { issueId: coordinator, intentId: randomUUID(), state: "confirmed", commandId: randomUUID(),
        commandHash: "original", ownerUserId: id.owner, preparedVersion: 1 },
      contributions: plan.map((slot, i) => ({ ...slot, issueState: "confirmed", childIssueId: i ? id.childB : id.childA, parentIssueId: id.root })) };
    value.modelSelection!.tasks[0]!.launches[0]!.issueId = coordinator;
    value.nativeWakePolicy = { protocol: "council-native-wake-v2", rootBaseline: [], runLimit: 8 };
    value.projectMandate = { projectId: id.project, revisionId: randomUUID(), version: 1, authorizedBy: id.owner,
      operatingProfileHash: operatingProfileHash(config), mandateHash: canonicalPayloadHash(value.mandate), allowedPaths: ["src"], publication: null,
      completion: { protocol: "council-proof-close-v1", result: "accepted-candidate" },
      source: { rootIssueId: id.root, title: product[0]!.title, descriptionHash: nodes[0]!.descriptionHash, taskDocumentRevisionId: null } };
    const h = harness(value);
    for (const issue of product) h.issues.set(issue.id, issue);
    h.issues.set(coordinator, nativeIssue({ id: coordinator, parentId: null, assigneeAgentId: id.lead, status: "in_progress" }));
    h.configGet.mockResolvedValue(config as never);
    h.query.mockImplementation(async (...args: unknown[]) => String(args[0]).includes("project_mandates") ? [{
      company_id: id.company, project_id: id.project, version: 1, revision_id: value.projectMandate!.revisionId, authorized_by: id.owner,
      content: { enabled: true, hierarchy, completion: value.projectMandate!.completion },
    }] as never : [h.row()]);
    h.list.mockImplementation(async (...args: unknown[]) => {
      const filter = args[0] as { originKind?: string; originId?: string };
      return [...h.issues.values()].filter(issue => !filter.originId || issue.originId === filter.originId && issue.originKind === filter.originKind) as never;
    });
    h.create.mockImplementation(async (...args: unknown[]) => {
      const issue = { ...args[0] as object, id: randomUUID(), parentId: null } as ReturnType<typeof nativeIssue>;
      h.issues.set(issue.id, issue); return issue;
    });
    h.documentGet.mockImplementation(async (...args: unknown[]) => args[1] === `council-execution-${id.mission}`
      ? { latestRevisionId: "execution-v1", body: "Council contribution reporting command" }
      : { latestRevisionId: "work-v1" });
    const technicalBlockers = new Map<string, string[]>();
    const relations = vi.fn(async (issueId: string) => ({ blockedBy: [
      ...(issueId === id.childB ? [{ id: id.childA, status: h.issues.get(id.childA)!.status }] : []),
      ...(technicalBlockers.get(issueId) ?? []).map(id => ({ id, status: h.issues.get(id)!.status })),
    ], blocks: [] }));
    h.ctx.issues.relations = { get: relations,
      addBlockers: async (issueId: string, ids: string[]) => { technicalBlockers.set(issueId, [...new Set([...(technicalBlockers.get(issueId) ?? []), ...ids])]); },
      removeBlockers: async (issueId: string, ids: string[]) => { technicalBlockers.set(issueId, (technicalBlockers.get(issueId) ?? []).filter(id => !ids.includes(id))); },
    } as never;
    const runs: Array<{ id: string; issueId: string; agentId: string; status: string; startedAt: string; finishedAt: string | null }> = [{ id: id.leadRun, issueId: coordinator, agentId: id.lead, status: "running",
      startedAt: new Date(0).toISOString(), finishedAt: null as string | null }];
    h.getOrchestration.mockImplementation(async (...args: unknown[]) => {
      const issueId = (args[0] as { issueId: string }).issueId;
      const observed = runs.filter(run => run.issueId === issueId);
      return { issueId, companyId: id.company, runs: observed,
        costs: { inputTokens: observed.length * 90, cachedInputTokens: observed.length * 70, outputTokens: observed.length * 10, costCents: 0 }, relations: {}, invocationBlocks: [], openBudgetIncidents: [] } as never;
    });
    const envelope = { ...nativeEnvelope([{ reservationId: value.n1!.activationReservationId, missionId: id.mission, status: "reserved" }]), companyId: id.company };
    envelope.limits.maxCorrections = 1;
    vi.mocked(readAdmission).mockImplementation(async () => envelope as never);
    vi.mocked(reserveAdmission).mockImplementation(async (_ctx, input) => {
      let reservation = envelope.reservations.find(item => item.reservationId === input.reservationId);
      if (input.ownerReplacementCommandId) expect(n1ResumeAdmissionFailure(h.row().aggregate, envelope as never, input, id.owner, id.owner)).toBeNull();
      if (!reservation) { reservation = { ...input, status: "reserved", usage: null, lastKnownUsageUnits: 0,
        remainingExposure: { status: "known", units: input.requestedUnits }, settlementReceipts: [] }; envelope.reservations.push(reservation); }
      return { reservation, envelope } as never;
    });
    vi.mocked(settleAdmission).mockImplementation(async (_ctx, input) => {
      Object.assign(envelope.reservations.find(item => item.reservationId === input.reservationId)!, { status: "settled", usage: input.usage, remainingExposure: input.remainingExposure });
      return { envelope, outcome: "settled" } as never;
    });
    vi.mocked(inspectVariant).mockImplementation(async (_ctx, _company, logicalAgentId, profileId, revision) => ({
      logicalAgentId, agentId: logicalAgentId === id.lead ? id.lead : physical[logicalAgentId === id.contributorA ? 0 : 1]!,
      roleKey: logicalAgentId === id.lead ? "lead" : "contributor-1",
      profileId, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [],
    }));
    h.update.mockImplementation(async (...args: unknown[]) => { Object.assign(h.issues.get(String(args[0]))!, args[1]); });
    h.requestWakeup.mockImplementation(async (...args: unknown[]) => {
      const issueId = String(args[0]), i = issueId === id.childA ? 0 : 1;
      const runId = issueId === coordinator ? randomUUID() : childRuns[i]!;
      h.issues.get(issueId)!.status = "in_progress";
      runs.push({ id: runId, issueId, agentId: issueId === coordinator ? id.lead : physical[i]!, status: "running", startedAt: new Date().toISOString(), finishedAt: null });
      return { queued: true, runId };
    });
    vi.spyOn(nativeAdapter, "councilNativeRequest").mockImplementation(async (_ctx, _company, path) => {
      const run = runs.find(item => path.endsWith(item.id))!;
      return { status: 200, body: { ...run, companyId: id.company, nativeIssueId: null, contextSnapshot: { issueId: run.issueId },
        usageJson: { usageSource: "per_run", inputTokens: 90, cachedInputTokens: 70, outputTokens: 10 } } };
    });
    vi.mocked(verifyContributionBundle).mockImplementation(async (_ctx, input) => ({ protocol: "council-contribution-proof-v1",
      attachmentId: input.attachmentId, sha256: input.expectedSha256, byteSize: 100, segmentRootCommit: input.baseCommit, commit: input.candidateCommit,
      changedPaths: input.ownedPaths, checks: [], verifiedAt: new Date().toISOString() }));
    const request = (body: Record<string, unknown>) => agentRequest({ commandId: randomUUID(), expectedVersion: h.row().version, ...body }, { agentId: id.lead, runId: String(h.row().aggregate.n1!.rootDispatchRunId) }, coordinator);
    const choose = (i: number) => chooseModelProfile(h.ctx, request({ command: "select-model-profile", taskKey: plan[i]!.contributionId,
      interventionKey: plan[i]!.contributionId, family: "implementation", profileId: "sol-medium", rationale: "Bounded product contribution" }));
    const dispatch = (i: number, reservationId = randomUUID()) => handleN1AgentApi(request({ command: "dispatch", contributionId: plan[i]!.contributionId,
      reservationId, requestedUnits: profile.runReservationUnits }), h.ctx);
    const read = async () => (await getMission(h.ctx, id.company, id.mission))!;
    const deliverFirst = async () => {
      const reported = await handleN1AgentApi(agentRequest({ command: "record-contribution", commandId: randomUUID(), expectedVersion: h.row().version,
        contributionId: id.contributionA, commit: "c".repeat(40), proof: { attachmentId: randomUUID(), expectedSha256: "d".repeat(64), segmentRootCommit: "b".repeat(40) } },
        { agentId: physical[0]!, runId: childRuns[0]! }, id.childA), h.ctx);
      expect(reported.status).toBe(200); expect(h.issues.get(id.childA)!.status).toBe("blocked");
      Object.assign(runs.find(run => run.id === childRuns[0])!, { status: "succeeded", finishedAt: new Date().toISOString() });
      expect((await handleN1AgentApi(request({ command: "reconcile-usage", contributionId: id.contributionA }), h.ctx)).status).toBe(200);
      expect(h.issues.get(id.childA)!.status).toBe("done");
    };
    return { ...h, value, product, coordinator, physical, runs, childRuns, envelope, choose, dispatch, read, deliverFirst };
  }

  async function secondStoppedHierarchy() {
    const h = composedHierarchy({ ...nativeProfile, periodAllowanceUnits: 64_000_000, runReservationUnits: 4_000_000 });
    const childReservation = randomUUID(), secondRun = randomUUID(), secondReservation = randomUUID(), firstGrantId = randomUUID();
    Object.assign(h.envelope.allowance, { periodUnits: 64_000_000, taskUnits: 4_000_000, knownUsageUnits: 9_664_122 });
    await h.choose(0);
    h.documentGet.mockImplementation(async () => ({ latestRevisionId: h.product[1]!.description.includes("Council profile launch") ? "unavailable" : "work-v1", body: "Council contribution reporting command" }));
    expect(await h.dispatch(0, childReservation)).toMatchObject({ status: 409, body: { code: "hierarchy_source_changed" } });
    h.documentGet.mockResolvedValue({ latestRevisionId: "work-v1", body: "Council contribution reporting command" });
    Object.assign(h.runs[0]!, { status: "succeeded", finishedAt: new Date(1).toISOString() });
    h.runs.push({ ...h.runs[0]!, id: secondRun });
    Object.assign(h.envelope.reservations[0]!, { status: "settled", usage: { status: "known", units: 3_689_328 }, remainingExposure: { status: "known", units: 0 } });
    h.envelope.reservations.push({ reservationId: secondReservation, missionId: id.mission, effectId: firstGrantId, ownerReplacementCommandId: firstGrantId,
      status: "settled", attempt: { kind: "resume", ordinal: 1 }, usage: { status: "known", units: 5_974_794 }, remainingExposure: { status: "known", units: 0 } });
    const firstGrant: N1Resume = { commandId: firstGrantId, authorizedBy: id.owner, previousOwnerUserId: id.owner,
      authorizedAt: new Date(0).toISOString(), reason: "First explicit operator restart after binding repair", contributions: [],
      lead: { issueId: h.coordinator, priorRunId: id.leadRun, priorReservationId: String(h.value.n1!.activationReservationId),
        priorUsageBaselineUnits: 0, reservationId: secondReservation } };
    h.advanceMission(a => {
      const state = a.n1 as N1State;
      Object.assign(state, { resume: firstGrant, activationReservationId: secondReservation, rootDispatchRunId: secondRun, rootUsageBaselineUnits: 3_689_328 });
      Object.assign(a.nativeWakePolicy!, { runLimit: 16 }); a.mandate.limits.correctionLimit = 1;
      a.projectMandate!.mandateHash = canonicalPayloadHash(a.mandate);
      a.continuity = { protocol: "council-continuity-v1", enabled: false, authorizedBy: id.owner, authorizedAt: state.activatedAt,
        deadline: new Date(Date.now() + 600_000).toISOString(), mandateHash: canonicalPayloadHash(a.mandate), n3Slots: [],
        commands: { "start-lead": { command: "start-lead", commandId: randomUUID() } } };
      a.commandReceipts.push({ commandId: firstGrantId, command: "prepare-n1-resume", actorType: "user", actorId: id.owner,
        payloadHash: "first-grant", appliedVersion: 18, result: { missionId: id.mission, version: 18 }, recordedAt: new Date(0).toISOString() });
      a.modelSelection!.tasks[0]!.launches.push({ ...a.modelSelection!.tasks[0]!.launches[0]!, launchKey: secondReservation,
        previousLaunchKey: String(h.value.n1!.activationReservationId), runId: secondRun });
      return a;
    });
    while (h.row().version < 28) h.advanceMission(a => a);
    h.issues.get(h.coordinator)!.status = "blocked" as never;
    const body = { command: "prepare-n1-resume", commandId: randomUUID(), expectedVersion: 28,
      authorizeOneResume: true, authorizeContinuityResume: true, previousOwnerUserId: id.owner, reason: "Explicit operator restart after second defect" };
    const apply = () => executeN1BoardCommand(h.ctx, { companyId: id.company, missionId: id.mission, actorUserId: id.owner, body });
    const job = { jobKey: "mission-continuity", runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString() } as PluginJobContext;
    const advance = () => h.read().then(m => advanceContinuity(h.ctx, m, job));
    vi.mocked(reserveAdmission).mockClear();
    return { ...h, firstGrant, childReservation, body, apply, advance };
  }

  function hierarchyProgression(h = composedHierarchy()) {
    const specialists: string[] = [randomUUID(), randomUUID()];
    const job = { jobKey: "mission-continuity", runId: randomUUID(), trigger: "schedule", scheduledAt: new Date().toISOString() } as PluginJobContext;
    h.advanceMission(a => {
      a.mandate.limits.correctionLimit = 1; a.projectMandate!.mandateHash = canonicalPayloadHash(a.mandate);
      a.compositions.council.members.push(...specialists.map(agentId => ({ agentId, responsibilities: [] })));
      a.continuity = { protocol: "council-continuity-v1", enabled: true, authorizedBy: id.owner, authorizedAt: new Date().toISOString(),
        deadline: new Date(Date.now() + 600_000).toISOString(), mandateHash: canonicalPayloadHash(a.mandate), commands: {},
        n3Slots: specialists.map((specialistAgentId, i) => ({ slotId: randomUUID(), specialistAgentId,
          perspective: i ? "security" : "quality", required: true, question: "Verify the accepted criteria" })) };
      return a;
    });
    h.list.mockImplementation(async (...args: unknown[]) => {
      const filter = args[0] as { originKind?: string; originId?: string };
      return [...h.issues.values()].filter(issue => !filter.originId || issue.originId === filter.originId && issue.originKind === filter.originKind) as never;
    });
    h.create.mockImplementation(async (...args: unknown[]) => {
      const issue = { ...args[0] as object, id: randomUUID(), parentId: null } as ReturnType<typeof nativeIssue>;
      h.issues.set(issue.id, issue); return issue;
    });
    h.requestWakeup.mockImplementation(async (...args: unknown[]) => {
      const issueId = String(args[0]), issue = h.issues.get(issueId)!;
      const runId = issueId === id.childA ? h.childRuns[0]! : issueId === id.childB ? h.childRuns[1]! : randomUUID();
      if (issueId === id.childA || issueId === id.childB) {
        // The native wake uses this description, not the bodies of documentSummaries.
        const description = (issue as typeof issue & { description: string }).description;
        expect(description).toContain(`GET /api/issues/${issueId}/documents/council-execution-${id.mission}`);
        expect(description).toContain("Do not mark this issue done yourself");
      }
      issue.status = "in_progress";
      h.runs.push({ id: runId, issueId, agentId: issue.assigneeAgentId, status: "running", startedAt: new Date().toISOString(), finishedAt: null });
      return { queued: true, runId };
    });
    const agentGet = h.agentGet.getMockImplementation()!;
    h.agentGet.mockImplementation(async (agentId: string) => specialists.includes(agentId)
      ? { id: agentId, companyId: id.company, status: "active", adapterType: "codex_local", adapterConfig: { engine: "cli" } }
      : agentGet(agentId));
    const variant = vi.mocked(inspectVariant).getMockImplementation()!;
    vi.mocked(inspectVariant).mockImplementation(async (ctx, company, logicalAgentId, profileId, revision) => logicalAgentId === id.reviewer || specialists.includes(logicalAgentId)
      ? { logicalAgentId, agentId: logicalAgentId, roleKey: logicalAgentId === id.reviewer ? "generalist-reviewer" : logicalAgentId === specialists[0] ? "quality-reviewer" : "security-reviewer",
        profileId, revision: revision!, ready: true, expected: {}, observed: {}, gaps: [] }
      : variant(ctx, company, logicalAgentId, profileId, revision));
    const terminal = (runId: string) => Object.assign(h.runs.find(run => run.id === runId)!, { status: "succeeded", finishedAt: new Date().toISOString() });
    const report = async (i: number) => {
      const result = await handleN1AgentApi(agentRequest({ command: "record-contribution", commandId: randomUUID(), expectedVersion: h.row().version,
        contributionId: plan[i]!.contributionId, commit: (i ? "d" : "c").repeat(40), proof: { attachmentId: randomUUID(), expectedSha256: "e".repeat(64), segmentRootCommit: (i ? "c" : "b").repeat(40) } },
        { agentId: h.physical[i]!, runId: h.childRuns[i]! }, i ? id.childB : id.childA), h.ctx);
      expect(result.status).toBe(200); terminal(h.childRuns[i]!);
    };
    const tick = () => h.read().then(m => advanceContinuity(h.ctx, m, { ...job, runId: randomUUID() }));
    return { ...h, tick, terminal, report };
  }

  it.each(["shared files", "empty integration"])("continues after the planner exits through sequential closure, integration (%s), and actual review", async integrationKind => {
    const h = hierarchyProgression();
    await h.choose(0); expect((await h.dispatch(0)).status).toBe(200);
    h.terminal(id.leadRun);
    expect((await h.tick()).code).toBe("hierarchy_child_running");
    const commandIds = structuredClone(h.row().aggregate.continuity!.commands);
    expect((await h.tick()).code).toBe("hierarchy_child_running");
    expect(h.row().aggregate.continuity!.commands).toEqual(commandIds);
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    await h.report(0);
    expect((await h.tick()).code).toBe("hierarchy_child_dispatched");
    expect(h.issues.get(id.childA)!.status).toBe("done");
    expect(h.envelope.reservations[1]).toMatchObject({ status: "settled", usage: { status: "known", units: 100 } });
    expect((h.requestWakeup.mock.calls[1] as unknown[])[2]).toMatchObject({ actorUserId: id.owner });
    expect((h.requestWakeup.mock.calls[1] as unknown[])[2]).not.toHaveProperty("actorRunId");
    expect((await h.tick()).code).toBe("hierarchy_child_running");
    await h.report(1);
    expect((await h.tick()).code).toBe("hierarchy_integration_started");
    const integration = (h.row().aggregate.n1 as N1State).integration!;
    expect(integration.issueId).not.toBe(h.coordinator); expect(integration.runId).not.toBe(id.leadRun);
    expect(h.issues.get(id.childB)!.status).toBe("done");
    expect(h.envelope.reservations).toHaveLength(4); expect(h.requestWakeup).toHaveBeenCalledTimes(3);
    expect(reserveAdmission).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ reservationId: integration.reservationId, attempt: { kind: "initial", ordinal: 0 } }));
    expect((await h.tick()).code).toBe("hierarchy_integration_running");
    expect(h.create.mock.calls.filter(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:n1-integration")).toHaveLength(1); expect(h.requestWakeup).toHaveBeenCalledTimes(3);
    expect((await handleN1AgentApi(agentRequest({ command: "inspect" }, { agentId: id.lead, runId: id.leadRun }, h.coordinator), h.ctx)).status).toBe(404);
    expect((await handleN1AgentApi(agentRequest({ command: "inspect" }, { agentId: id.lead, runId: integration.runId! }, integration.issueId!), h.ctx)).status).toBe(200);
    const candidate = { outcome: "verified", publicationEligible: true, subject: { companyId: id.company, issueId: id.root },
      candidate: { attachmentId: randomUUID(), byteSize: 100, sha256: "e".repeat(64), baseCommit: "b".repeat(40), candidateCommit: "f".repeat(40) },
      contributions: plan.map((s, i) => ({ ...s, commit: (i ? "d" : "c").repeat(40), changedPaths: s.ownedPaths })), checks: [] };
    vi.mocked(verifyIntegratedCandidate).mockResolvedValue(candidate as never);
    const publish = (paths: string[]) => handleN1AgentApi(agentRequest({ command: "publish", commandId: randomUUID(), expectedVersion: h.row().version,
      ...candidate.candidate, expectedSha256: candidate.candidate.sha256, integrationAdjustedPaths: paths }, { agentId: id.lead, runId: integration.runId! }, integration.issueId!), h.ctx);
    expect(await publish(["src/a/owned.ts"])).toMatchObject({ status: 422, body: { code: "integration_child_ownership" } });
    expect(await publish(["outside/project.ts"])).toMatchObject({ status: 422, body: { code: "project_write_scope" } });
    const paths = integrationKind === "shared files" ? ["src/shared.ts"] : [];
    expect(await publish(paths)).toMatchObject({ status: 200 });
    expect(verifyIntegratedCandidate).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ integrationAdjustedPaths: paths.length ? paths : undefined }));
    expect(h.row().aggregate.phase).toBe("integrating");
    // The old planner's settlement cannot bypass the new integration run's cost.
    expect((await h.tick()).code).toBe("hierarchy_integration_running");
    expect(h.row().aggregate.phase).toBe("integrating");
    h.terminal(integration.runId!);
    expect((await h.tick()).code).toBe("hierarchy_ready_for_review");
    expect(h.row().aggregate.phase).toBe("ready_for_review");
    expect(h.envelope.reservations.every(r => r.status === "settled")).toBe(true);
    expect((await h.tick()).code).toBe("start-review");
    expect(h.row().aggregate.phase).toBe("review_handoff");
    expect(h.row().aggregate.n2!.submissions[0]!.candidateCommit).toEqual(candidate.candidate.candidateCommit);
    expect(h.runs.filter(r => r.issueId === h.coordinator)).toHaveLength(1);
    expect(h.row().aggregate.n1!.rootDispatchRunId).toBe(id.leadRun);
  });

  it.each(["missing proof", "unknown wake", "unknown usage", "dependency", "deadline", "run limit"])("retains the original plan and stops delegated departure on %s", async kind => {
    const h = hierarchyProgression(); await h.dispatch(0); h.terminal(id.leadRun);
    if (kind !== "missing proof") await h.report(0); else h.terminal(h.childRuns[0]!);
    if (kind === "unknown wake") h.advanceMission(a => { (a.n1 as N1State).contributions[0]!.dispatchState = "unknown"; return a; });
    if (kind === "unknown usage") vi.mocked(settleAdmission).mockRejectedValueOnce(new MissionError(409, "g4_usage_unavailable", "unavailable"));
    if (kind === "dependency") h.ctx.issues.relations.get = vi.fn(async issueId => ({ blockedBy: issueId === id.childB ? [{ id: id.childA, status: "blocked" }] : [], blocks: [] })) as never;
    if (kind === "deadline") h.advanceMission(a => { a.continuity!.deadline = new Date(0).toISOString(); return a; });
    if (kind === "run limit") h.advanceMission(a => { Object.assign(a.nativeWakePolicy!, { runLimit: 2 }); return a; });
    await expect(h.tick()).rejects.toThrow();
    expect(h.requestWakeup).toHaveBeenCalledTimes(1); expect(h.create.mock.calls.every(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:operation:contribution-settlement")).toBe(true);
    expect((h.row().aggregate.n1 as N1State).contributions[1]!.dispatchState).toBeUndefined();
  });

  it("continues an already resumed mission with three old leads and a settled but unclosed first child without another lead or hold", async () => {
    const previous = await secondStoppedHierarchy(); await previous.apply(); await previous.advance();
    expect((await previous.dispatch(0, previous.childReservation)).status).toBe(200);
    const h = hierarchyProgression(previous), before = h.row().aggregate;
    h.terminal(String(before.n1!.rootDispatchRunId)); await h.report(0);
    Object.assign(h.envelope.reservations.find(r => r.reservationId === previous.childReservation)!, {
      status: "settled", usage: { status: "known", units: 100 }, remainingExposure: { status: "known", units: 0 } });
    const originalReservations = h.envelope.reservations.map(r => r.reservationId);
    expect((await h.tick()).code).toBe("hierarchy_child_dispatched");
    expect(h.runs.filter(run => run.issueId === h.coordinator)).toHaveLength(3);
    expect(h.issues.get(id.childA)!.status).toBe("done");
    expect(h.envelope.reservations.slice(0, originalReservations.length).map(r => r.reservationId)).toEqual(originalReservations);
    expect(h.row().aggregate.n1!.resumeHistory).toEqual(before.n1!.resumeHistory);
    expect(h.row().aggregate.n1!.resume).toEqual(before.n1!.resume);
    expect(h.row().aggregate.continuity!.deadline).toBe(before.continuity!.deadline);
    expect(h.row().aggregate.mandate).toEqual(before.mandate);
    expect(h.requestWakeup).toHaveBeenCalledTimes(3); // third planning run, first child, then second child only
  });

  it("settles a terminal integration without a candidate and never repeats its run", async () => {
    const h = hierarchyProgression(); await h.dispatch(0); h.terminal(id.leadRun); await h.report(0); await h.tick();
    await h.report(1); await h.tick();
    const integration = (h.row().aggregate.n1 as N1State).integration!;
    h.terminal(integration.runId!);
    await expect(h.tick()).rejects.toMatchObject({ code: "hierarchy_integration_incomplete" });
    await expect(h.tick()).rejects.toMatchObject({ code: "hierarchy_integration_incomplete" });
    expect(h.envelope.reservations.find(r => r.reservationId === integration.reservationId)!.status).toBe("settled");
    expect(h.requestWakeup).toHaveBeenCalledTimes(3); expect(h.create.mock.calls.filter(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:n1-integration")).toHaveLength(1);
    expect(h.row().aggregate.n2).toBeUndefined();
  });

  it("correlates a persisted integration creation after a lost response without recreating its task", async () => {
    const h = hierarchyProgression(); await h.dispatch(0); h.terminal(id.leadRun); await h.report(0); await h.tick(); await h.report(1);
    const create = h.create.getMockImplementation()!, list = h.list.getMockImplementation()!;
    h.create.mockImplementationOnce(async (...args) => { await create(...args); throw new Error("lost create response"); });
    let hidden = true;
    h.list.mockImplementation(async (...args: unknown[]) => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:n1-integration" && hidden ? [] : (list as (...values: unknown[]) => Promise<never[]>)(...args));
    await expect(h.tick()).rejects.toMatchObject({ code: "hierarchy_integration_creation_unknown" });
    const original = structuredClone((h.row().aggregate.n1 as N1State).integration!);
    hidden = false;
    expect((await h.tick()).code).toBe("hierarchy_integration_started");
    expect((h.row().aggregate.n1 as N1State).integration).toMatchObject({ taskId: original.taskId, reservationId: original.reservationId });
    expect(h.create.mock.calls.filter(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:n1-integration")).toHaveLength(1); expect(h.requestWakeup).toHaveBeenCalledTimes(3);
  });

  it("resumes version 28 with all old leads, then consumes the same prepared child hold before its successor", async () => {
    const h = await secondStoppedHierarchy(), before = h.row().aggregate, oldReservations = structuredClone(h.envelope.reservations);
    expect(h.row().version).toBe(28); expect((await h.advance()).code).toBe("continuity_disabled");
    await h.apply();
    const granted = h.row().aggregate, state = granted.n1 as N1State;
    expect(state.resumeHistory).toEqual([h.firstGrant]);
    expect(state.resume!.preparedContributions).toEqual([{ contributionId: id.contributionA, issueId: id.childA, reservationId: h.childReservation }]);
    expect(granted.mandate).toEqual(before.mandate); expect(granted.hierarchy).toEqual(before.hierarchy);
    expect(granted.nativeWakePolicy).toEqual(before.nativeWakePolicy); expect(granted.continuity!.deadline).toBe(before.continuity!.deadline);
    expect(state.activatedAt).toBe(before.n1!.activatedAt); expect(h.envelope.reservations).toEqual(oldReservations);
    expect(granted.effectIntents).toEqual(before.effectIntents); expect(granted.modelSelection).toEqual(before.modelSelection);
    expect((await h.apply()).outcome).toBe("replayed"); expect(h.requestWakeup).not.toHaveBeenCalled();
    expect((await h.advance()).code).toBe("start-lead");
    expect((await h.advance()).code).toBe("native_lead_running");
    expect((await h.apply()).outcome).toBe("replayed"); expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(reserveAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({ attempt: { kind: "resume", ordinal: 2 }, ownerReplacementCommandId: h.body.commandId }));
    expect(h.runs.filter(run => run.issueId === h.coordinator)).toHaveLength(3);
    expect(await h.dispatch(0)).toMatchObject({ status: 409, body: { code: "n1_prepared_reservation_mismatch" } });
    expect(h.envelope.reservations).toHaveLength(4); expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    expect(await h.dispatch(0, h.childReservation)).toMatchObject({ status: 200, body: { outcome: "requested" } });
    expect(h.envelope.reservations.filter(r => r.reservationId === h.childReservation)).toHaveLength(1);
    expect(h.envelope.reservations).toHaveLength(4);
    expect(await h.dispatch(1)).toMatchObject({ status: 409, body: { code: "prior_contribution_proof" } });
    await h.deliverFirst(); await h.choose(1);
    expect(await h.dispatch(1)).toMatchObject({ status: 200, body: { outcome: "requested" } });
    expect(h.envelope.reservations).toHaveLength(5); expect(h.requestWakeup).toHaveBeenCalledTimes(3);
    expect(h.create.mock.calls.every(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:operation:contribution-settlement")).toBe(true); expect(h.row().aggregate.n1!.resumeHistory).toEqual([h.firstGrant]);
    expect(h.row().aggregate.commandReceipts).toEqual(expect.arrayContaining(before.commandReceipts));
    expect(h.envelope.reservations[0]).toEqual(oldReservations[0]); expect(h.envelope.reservations[2]).toEqual(oldReservations[2]);
  });

  it("retains every grant on a further explicit pre-leaf restart without imposing another resume ceiling", async () => {
    const h = await secondStoppedHierarchy(); await h.apply(); await h.advance();
    const secondGrant = structuredClone((h.row().aggregate.n1 as N1State).resume!);
    Object.assign(h.runs.at(-1)!, { status: "succeeded", finishedAt: new Date().toISOString() });
    Object.assign(h.envelope.reservations.at(-1)!, { status: "settled", usage: { status: "known", units: 100 }, remainingExposure: { status: "known", units: 0 } });
    h.issues.get(h.coordinator)!.status = "blocked" as never;
    h.advanceMission(a => { a.continuity!.enabled = false; return a; });
    Object.assign(h.body, { commandId: randomUUID(), expectedVersion: h.row().version, reason: "Further explicit operator decision" });
    await h.apply();
    expect(h.row().aggregate.n1!.resumeHistory).toEqual([h.firstGrant, secondGrant]);
    expect((h.row().aggregate.n1 as N1State).resume!.preparedContributions).toEqual(secondGrant.preparedContributions);
    await h.advance();
    expect(h.requestWakeup).toHaveBeenCalledTimes(2); expect(h.runs.filter(run => run.issueId === h.coordinator)).toHaveLength(4);
    expect(reserveAdmission).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({ attempt: { kind: "resume", ordinal: 3 } }));
  });

  it.each(["unknown lead", "unknown child", "child wake claimed", "child dispatched", "unknown usage", "unknown hold", "admission blocked", "run limit", "deadline"])(
    "refuses the second operator grant with %s without a new wake or reservation", async kind => {
      const h = await secondStoppedHierarchy();
      h.advanceMission(a => {
        if (kind === "unknown lead") a.n1!.rootDispatchState = "unknown";
        if (kind === "child dispatched") (a.n1 as N1State).contributions[0]!.dispatchState = "claimed";
        if (kind === "unknown child" || kind === "child wake claimed") a.modelSelection!.tasks[1]!.launches[0]!.state = kind === "unknown child" ? "unknown" : "wake_claimed";
        if (kind === "run limit") Object.assign(a.nativeWakePolicy!, { runLimit: 2 });
        if (kind === "deadline") a.continuity!.deadline = new Date(0).toISOString();
        return a;
      });
      if (kind === "unknown usage") Object.assign(h.envelope.reservations[0]!, { usage: { status: "unknown" } });
      if (kind === "unknown hold") Object.assign(h.envelope.reservations[1]!, { remainingExposure: { status: "unknown" } });
      if (kind === "admission blocked") Object.assign(h.envelope, { blockers: [{ code: "exposure_unknown" }] });
      h.body.expectedVersion = h.row().version;
      const before = h.row(); await expect(h.apply()).rejects.toThrow();
      expect(h.row()).toEqual(before); expect(h.requestWakeup).not.toHaveBeenCalled(); expect(reserveAdmission).not.toHaveBeenCalled();
    });

  it("dispatches both profiled leaves through unchanged pinned sources, dependency proof and exact settlement", async () => {
    const h = composedHierarchy(), initialHierarchy = structuredClone(h.value.hierarchy);
    await h.choose(0); await h.choose(1);
    expect(await h.dispatch(0)).toMatchObject({ status: 200, body: { outcome: "requested" } });
    expect(await h.dispatch(1)).toMatchObject({ status: 409, body: { code: "prior_contribution_proof" } });
    await h.deliverFirst();
    expect(await h.dispatch(1)).toMatchObject({ status: 200, body: { outcome: "requested" } });
    await expect(assertHierarchySources(h.ctx, await h.read())).resolves.toBeUndefined();
    expect(h.row().aggregate.hierarchy).toEqual(initialHierarchy);
    expect(h.requestWakeup).toHaveBeenCalledTimes(2); expect(h.create.mock.calls.every(args => (args[0] as { originKind?: string })?.originKind === "plugin:private.paperclip-council:operation:contribution-settlement")).toBe(true);
    expect(h.envelope.reservations).toHaveLength(3);
    expect(h.envelope.reservations[1]).toMatchObject({ status: "settled", usage: { units: 100 }, remainingExposure: { units: 0 } });
    for (const [i, issue] of h.product.slice(1).entries()) {
      expect(issue.description).toContain(`Immutable product requirements ${i + 1}.\n\nCouncil execution`);
      expect(issue.description).toContain("\n\nCouncil profile launch");
      expect(issue.assigneeAgentId).toBe(h.physical[i]);
    }
  });

  it("reuses the reserved ready binding after a failed departure without another effect identity", async () => {
    const h = composedHierarchy(), reservationId = randomUUID(); await h.choose(0);
    h.documentGet.mockImplementation(async () => ({ latestRevisionId: h.product[1]!.description.includes("Council profile launch") ? "unavailable" : "work-v1", body: "Council contribution reporting command" }));
    expect(await h.dispatch(0, reservationId)).toMatchObject({ status: 409, body: { code: "hierarchy_source_changed" } });
    expect(h.requestWakeup).not.toHaveBeenCalled(); expect(h.envelope.reservations).toHaveLength(2);
    const ready = h.row().aggregate.modelSelection!.tasks.find(task => task.taskKey === id.contributionA)!.launches[0]!;
    expect(ready).toMatchObject({ launchKey: reservationId, state: "ready", runId: null });
    h.documentGet.mockResolvedValue({ latestRevisionId: "work-v1", body: "Council contribution reporting command" });
    expect(await h.dispatch(0, reservationId)).toMatchObject({ status: 200, body: { outcome: "requested" } });
    expect(h.requestWakeup).toHaveBeenCalledExactlyOnceWith(id.childA, id.company, expect.objectContaining({ idempotencyKey: `council:n1:${reservationId}` }));
    expect(h.envelope.reservations).toHaveLength(2);
    expect(h.row().aggregate.modelSelection!.tasks.find(task => task.taskKey === id.contributionA)!.launches).toHaveLength(1);
  });

  it.each(["product", "marker", "duplicate", "foreign marker", "other issue binding", "ownership", "relation"])(
    "refuses %s drift after the first profiled leaf without rebasing the source", async mutation => {
      const h = composedHierarchy(); await h.choose(0);
      expect((await h.dispatch(0)).status).toBe(200); await h.deliverFirst();
      const first = h.product[1]!, original = first.description.split("\n\n")[0]!;
      if (mutation === "product") first.description = first.description.replace("Immutable product", "Changed product");
      if (mutation === "marker") first.description = first.description.replace("Bounded product", "Altered product");
      if (mutation === "duplicate") first.description += first.description.slice(original.length);
      if (mutation === "foreign marker") first.description += `\n\nCouncil profile launch ${randomUUID()}: forged`;
      if (mutation === "other issue binding") h.advanceMission(a => { a.modelSelection!.tasks.find(task => task.taskKey === id.contributionA)!.launches[0]!.issueId = id.childB; return a; });
      if (mutation === "ownership") h.documentGet.mockResolvedValue({ latestRevisionId: "work-v2" });
      if (mutation === "relation") h.ctx.issues.relations.get = vi.fn(async () => ({ blockedBy: [], blocks: [] })) as never;
      await expect(assertHierarchySources(h.ctx, await h.read())).rejects.toMatchObject({ code: "hierarchy_source_changed" });
      expect(h.row().aggregate.hierarchy).toEqual(h.value.hierarchy); expect(h.requestWakeup).toHaveBeenCalledTimes(1);
    });
});
