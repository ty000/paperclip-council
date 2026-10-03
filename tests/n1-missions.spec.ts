import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return { ...actual, verifyIntegratedCandidate: vi.fn() };
});

import { AdmissionError, readAdmission, reserveAdmission, settleAdmission } from "../src/admission.js";
import { verifyIntegratedCandidate } from "../src/integration.js";
import { executeN1BoardCommand, handleN1AgentApi } from "../src/n1-missions.js";
import type { MissionAggregate } from "../src/missions.js";
import { reconcileTerminalN1Usage } from "./functional/n1-live.js";

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
      version: row.version + 1,
      updated_at: new Date().toISOString(),
    };
    return { rowCount: 1 };
  });
  const assertCheckoutOwner = vi.fn(async () => undefined);
  const list = vi.fn(async () => []);
  const create = vi.fn(async () => {
    throw new Error("native issue create response was lost");
  });
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
