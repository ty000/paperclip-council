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

import { readAdmission, reserveAdmission, settleAdmission } from "../src/admission.js";
import { verifyIntegratedCandidate } from "../src/integration.js";
import { executeN1BoardCommand, handleN1AgentApi } from "../src/n1-missions.js";
import type { MissionAggregate } from "../src/missions.js";

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

function harness(initial = aggregate()) {
  let row = storedRow(initial);
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
  const requestWakeup = vi.fn(async () => ({ queued: true, runId: null }));
  const ctx = {
    db: { namespace: "plugin_private_council_test", query, execute },
    config: { get: vi.fn(async () => ({ n1FixtureMode: "ephemeral-local-sandbox" })) },
    companies: { get: vi.fn(async () => ({ id: id.company, defaultResponsibleUserId: id.owner })) },
    projects: { get: vi.fn(async () => ({ id: id.project, companyId: id.company, archivedAt: null })) },
    agents: {
      get: vi.fn(async (agentId: string) => new Set<string>([id.lead, id.contributorA, id.contributorB, id.reviewer]).has(agentId)
        ? { id: agentId, companyId: id.company, status: "active" }
        : null),
    },
    issues: {
      get: vi.fn(async (issueId: string) => issues.get(issueId) ?? null),
      assertCheckoutOwner,
      list,
      create,
      update,
      requestWakeup,
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

  it("rejects a stale activation before reserving and releases an unused reservation after a CAS race", async () => {
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
    expect(settleAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      reservationId: body.reservationId, expectedVersion: 5,
      usage: expect.objectContaining({ status: "known", units: 0 }),
      remainingExposure: expect.objectContaining({ status: "known", units: 0 }),
    }));
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

  it("does not reserve for stale child dispatch and reconciles a pre-effect CAS race", async () => {
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
    expect(settleAdmission).toHaveBeenCalledWith(h.ctx, expect.objectContaining({
      reservationId: body.reservationId,
      usage: expect.objectContaining({ status: "known", units: 0 }),
    }));
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
  });
});
