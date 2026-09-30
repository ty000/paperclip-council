import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { initialL03Governance, transitionL03 } from "../src/l03.js";
import { L03GovernanceService } from "../src/l03-store.js";
import type { L03Actor, L03AuthoritySnapshot, L03CreateInput, L03Governance } from "../src/l03-types.js";

const H = "a".repeat(64);
const companyId = "10000000-0000-4000-8000-000000000001";
const missionId = "10000000-0000-4000-8000-000000000002";
const issueId = "10000000-0000-4000-8000-000000000003";
const projectId = "10000000-0000-4000-8000-000000000004";
const executorId = "executor-current";
const reviewerId = "reviewer-current";
const councilId = reviewerId;

const missionAggregate = {
  schemaVersion: 1 as const,
  missionId,
  companyId,
  rootIssueId: issueId,
  projectId,
  ownerUserId: "owner-1",
  mandate: {
    objective: "Ship a bounded result",
    acceptanceCriteria: ["Criterion one", "Criterion two"],
    commitments: ["Preserve exclusions"],
    limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 2, elapsedMinutes: 60 },
  },
  compositions: {
    status: "pinned" as const,
    team: {
      rosterId: "10000000-0000-4000-8000-000000000010",
      revision: "10000000-0000-4000-8000-000000000011",
      kind: "team" as const,
      name: "Team",
      projectId,
      members: [{ agentId: executorId, responsibilities: ["integration_lead"] }],
    },
    council: {
      rosterId: "10000000-0000-4000-8000-000000000012",
      revision: "10000000-0000-4000-8000-000000000013",
      kind: "council" as const,
      name: "Council",
      projectId,
      members: [
        { agentId: reviewerId, responsibilities: ["final_reviewer"] },
        { agentId: "executive-advisor-1", responsibilities: ["quality"] },
      ],
    },
  },
  responsibilities: { integrationLeadAgentId: executorId, finalReviewerAgentId: reviewerId, requiredPerspectives: ["quality"] },
  phase: "draft" as const,
  control: { status: "inactive" as const, reason: "mission_not_enabled" as const },
  readiness: { mission: "recorded" as const, compositions: "pinned" as const, execution: "blocked" as const, blockers: [] },
  journal: [],
  commandReceipts: [],
  effectIntents: [] as [],
};

function missionRow(version = 1) {
  return {
    company_id: companyId,
    mission_id: missionId,
    root_issue_id: issueId,
    project_id: projectId,
    owner_user_id: "owner-1",
    team_roster_id: "10000000-0000-4000-8000-000000000010",
    team_revision: "10000000-0000-4000-8000-000000000011",
    council_roster_id: "10000000-0000-4000-8000-000000000012",
    council_revision: "10000000-0000-4000-8000-000000000013",
    version,
    aggregate: missionAggregate,
    created_at: "2026-09-30T00:00:00.000Z",
    updated_at: "2026-09-30T00:00:00.000Z",
  };
}

function input(overrides: Partial<L03CreateInput> = {}): L03CreateInput {
  return {
    companyId,
    missionId,
    expectedMissionVersion: 1,
    mandateRevision: 1,
    executorAgentId: executorId,
    finalReviewerAgentId: reviewerId,
    councilAgentId: councilId,
    executivePluginActorId: "paperclip-executive.executive",
    expiresAt: "2099-10-01T00:00:00.000Z",
    ticket: {
      issueId,
      sourceRef: "linear:ETY-3@1",
      sourceVersion: "1",
      sourceHash: H,
      suppliedContext: { sourceRef: "attachment:context", sourceHash: H, content: "Supplied immutable context" },
      criteria: [{ id: "c1", text: "Criterion one" }, { id: "c2", text: "Criterion two" }],
      exclusions: ["deployment"],
    },
    limits: { envelope: 10, approach: 2, result: 2, consultation: 4, correction: 2 },
    ...overrides,
  };
}

function actor(type: "user" | "agent", id: string): L03Actor {
  return { actorType: type, actorId: id, ...(type === "user" ? { userId: id } : {}), companyId };
}

function context(options: {
  governance?: L03Governance | null;
  missionVersion?: number;
  statuses?: Record<string, string>;
} = {}) {
  const statuses = options.statuses ?? {};
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(".mission_governance")) return options.governance ? [{ aggregate: options.governance }] : [];
    if (sql.includes(".missions")) return [missionRow(options.missionVersion ?? 1)];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const execute = vi.fn(async () => ({ rowCount: 1 }));
  const ctx = {
    db: { namespace: "plugin_private_paperclip_council_test", query, execute },
    companies: { get: vi.fn(async () => ({ id: companyId, status: "active", defaultResponsibleUserId: "owner-1" })) },
    issues: { get: vi.fn(async () => ({ id: issueId, companyId, projectId, parentId: null })) },
    agents: {
      get: vi.fn(async (id: string) => ({ id, companyId, status: statuses[id] ?? "idle" })),
    },
  } as unknown as PluginContext;
  return { ctx, query, execute };
}

function storedGovernance(): L03Governance {
  const create = input();
  const current: L03AuthoritySnapshot = {
    companyId,
    missionId,
    missionVersion: 1,
    mandateRevision: 1,
    ownerUserId: "owner-1",
    executorAgentId: executorId,
    finalReviewerAgentId: reviewerId,
    councilAgentId: councilId,
    executivePluginActorId: create.executivePluginActorId,
    expiresAt: create.expiresAt,
  };
  return initialL03Governance(create, {
    now: "2026-09-30T12:00:00.000Z",
    actor: actor("user", "owner-1"),
    current,
  }, missionAggregate.responsibilities.requiredPerspectives);
}

describe("L03 service current-authority boundary", () => {
  it("derives executor and reviewer from the current mission instead of trusting create input", async () => {
    const { ctx, execute } = context();
    const service = new L03GovernanceService(ctx);
    await expect(service.create(input({ executorAgentId: "untrusted-executor" }), actor("user", "owner-1")))
      .rejects.toMatchObject({ code: "pinned_roles_changed" });
    await expect(service.create(input({ councilAgentId: "separate-council-actor" }), actor("user", "owner-1")))
      .rejects.toMatchObject({ code: "council_reviewer_must_match" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires the native root issue/project and exact mandate criterion texts before insert", async () => {
    const scoped = context();
    const service = new L03GovernanceService(scoped.ctx);
    await expect(service.create(input({ ticket: { ...input().ticket, issueId: "another-issue" } }), actor("user", "owner-1")))
      .rejects.toMatchObject({ code: "ticket_identity_mismatch" });
    await expect(service.create(input({ ticket: { ...input().ticket, criteria: [{ id: "c1", text: "Caller changed the criterion" }] } }), actor("user", "owner-1")))
      .rejects.toMatchObject({ code: "criteria_mismatch" });
    expect(scoped.execute).not.toHaveBeenCalled();
  });

  it("allows paused preparation but refuses terminated identities", async () => {
    const preparable = context({ statuses: { [executorId]: "paused", [reviewerId]: "error" } });
    await expect(new L03GovernanceService(preparable.ctx).create(input(), actor("user", "owner-1"))).resolves.toMatchObject({ phase: "awaiting_approach" });
    const revoked = context({ statuses: { [reviewerId]: "terminated" } });
    await expect(new L03GovernanceService(revoked.ctx).create(input(), actor("user", "owner-1")))
      .rejects.toMatchObject({ code: "pinned_actor_unavailable" });
  });

  it("assertCurrent rejects mandate drift, unauthorized actors and non-operational native actors", async () => {
    const state = storedGovernance();
    const drift = context({ governance: state, missionVersion: 2 });
    await expect(new L03GovernanceService(drift.ctx).assertCurrent(companyId, missionId, actor("agent", councilId)))
      .rejects.toMatchObject({ code: "mandate_changed" });
    const intruder = context({ governance: state });
    await expect(new L03GovernanceService(intruder.ctx).assertCurrent(companyId, missionId, actor("agent", "intruder")))
      .rejects.toMatchObject({ code: "actor_not_authorized" });
    const paused = context({ governance: state, statuses: { [councilId]: "paused" } });
    await expect(new L03GovernanceService(paused.ctx).assertCurrent(companyId, missionId, actor("agent", councilId)))
      .rejects.toMatchObject({ code: "pinned_actor_not_operational" });
  });

  it("reserves consultation only for a distinct pinned Council member responsible for the profile", async () => {
    const base = storedGovernance();
    const approach = transitionL03(base, {
      type: "submit-approach",
      expectedVersion: base.version,
      approach: {
        approachId: "approach-1",
        authorAgentId: executorId,
        contentRef: "document:approach-1",
        contentHash: H,
        criterionRefs: ["c1", "c2"],
        evidenceRefs: ["evidence:plan"],
        supersedesApproachId: null,
        addressesFindingIds: [],
      },
    }, {
      now: "2026-09-30T12:00:00.000Z",
      actor: actor("agent", executorId),
      current: base.authority,
    });
    const reservation = (reservedExecutiveAgentId: string, profileId: string) => ({
      type: "reserve-consultation" as const,
      expectedVersion: approach.version,
      subjectApproachId: "approach-1",
      reservation: {
        companyId,
        missionId,
        missionVersion: 1,
        mandateRevision: 1,
        slotId: "slot-1",
        reservationId: "reservation-1",
        reservationVersion: 1,
        status: "reserved" as const,
        reservedExecutiveAgentId,
        profile: { id: profileId, version: "1", sourceHash: H },
        method: { id: "paperclip-executive.council-reserved-opinion", version: "1.0.0" },
        criterionRefs: ["c1", "c2"],
        evidenceRefs: ["evidence:plan"],
        context: { sourceRef: "document:approach-1", sourceHash: H, content: "Bounded approach" },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      required: true,
      reservationEventRef: "event:reservation-1",
      costExposure: { status: "known" as const, reference: "cost:reservation-1" },
    });

    const wrongProfile = context({ governance: approach });
    await expect(new L03GovernanceService(wrongProfile.ctx).apply(
      companyId,
      missionId,
      actor("agent", councilId),
      reservation("executive-advisor-1", "architecture"),
    )).rejects.toMatchObject({ code: "reservation_profile_not_pinned" });
    expect(wrongProfile.execute).not.toHaveBeenCalled();

    const executorReservation = context({ governance: approach });
    await expect(new L03GovernanceService(executorReservation.ctx).apply(
      companyId,
      missionId,
      actor("agent", councilId),
      reservation(executorId, "integration_lead"),
    )).rejects.toMatchObject({ code: "reservation_profile_not_pinned" });
    expect(executorReservation.execute).not.toHaveBeenCalled();

    const pinned = context({ governance: approach });
    await expect(new L03GovernanceService(pinned.ctx).apply(
      companyId,
      missionId,
      actor("agent", councilId),
      reservation("executive-advisor-1", "quality"),
    )).resolves.toMatchObject({ consultationSlots: [{ slot: { profile: { id: "quality" } } }] });
    expect(pinned.execute).toHaveBeenCalledOnce();
  });
});

