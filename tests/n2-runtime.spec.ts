import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/admission.js")>();
  return { ...actual, readAdmission: vi.fn(), reserveAdmission: vi.fn() };
});
vi.mock("../src/g4-native.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/g4-native.js")>();
  return {
    ...actual,
    assertNativeEnvelope: vi.fn(),
    readNativeG4Profile: vi.fn(),
    readNativeSequentialUsageBaseline: vi.fn(),
    settleNativeSequentialRunUsage: vi.fn(),
  };
});
vi.mock("../src/integration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integration.js")>();
  return { ...actual, verifyIntegratedCandidate: vi.fn() };
});

import { readAdmission, reserveAdmission } from "../src/admission.js";
import type { DecisionReceipt } from "../src/decision-receipts.js";
import {
  readNativeG4Profile,
  readNativeSequentialUsageBaseline,
  settleNativeSequentialRunUsage,
} from "../src/g4-native.js";
import { verifyIntegratedCandidate } from "../src/integration.js";
import type { MissionAggregate } from "../src/missions.js";
import {
  confirmN2ReviewHandoff,
  executeN2BoardCommand,
  handleN2AgentApi,
  n2SubmissionResultReference,
  prepareN2Decision,
  recordN2Decision,
} from "../src/n2-missions.js";

const id = {
  company: randomUUID(), mission: randomUUID(), root: randomUUID(), project: randomUUID(), owner: randomUUID(),
  lead: randomUUID(), reviewer: randomUUID(), contributorA: randomUUID(), contributorB: randomUUID(),
  leadRun: randomUUID(), reviewerRun1: randomUUID(), correctionRun: randomUUID(), reviewerRun2: randomUUID(),
  contributionA: randomUUID(), contributionB: randomUUID(), attachment1: randomUUID(), attachment2: randomUUID(),
  team: randomUUID(), teamRevision: randomUUID(), council: randomUUID(), councilRevision: randomUUID(),
};

const profile = {
  kind: "paperclip-orchestration-tokens-v1" as const,
  periodKey: "n2-runtime-period",
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-10-02T00:00:00.000Z",
  periodAllowanceUnits: 200_000,
  runReservationUnits: 20_000,
  initialKnownUsageUnits: 0,
  initialExposureUnits: 0,
  initialTokenAccountingSource: "owner-readback:n2-runtime-period",
  maxCorrections: 1 as const,
};

function candidate(commit = "c".repeat(40), sha = "d".repeat(64), attachmentId = id.attachment1) {
  return {
    outcome: "verified" as const,
    publicationEligible: true as const,
    subject: { companyId: id.company, issueId: id.root },
    candidate: { attachmentId, byteSize: 120, sha256: sha, baseCommit: "a".repeat(40), candidateCommit: commit },
    contributions: [
      { contributionId: id.contributionA, commit: "1".repeat(40), ownedPaths: ["src/a/"], changedPaths: ["src/a/a.ts"] },
      { contributionId: id.contributionB, commit: "2".repeat(40), ownedPaths: ["src/b/"], changedPaths: ["src/b/b.ts"] },
    ],
    checks: [{ name: "fixture", status: "passed" as const, detail: "verified" }],
  };
}

function aggregate(): MissionAggregate {
  return {
    schemaVersion: 1,
    missionId: id.mission,
    companyId: id.company,
    rootIssueId: id.root,
    projectId: id.project,
    ownerUserId: id.owner,
    mandate: {
      objective: "Correct and independently accept one candidate",
      acceptanceCriteria: ["Candidate passes the bounded regression"],
      commitments: ["No uncertain decision passes"],
      limits: { taskPolicy: "bounded", periodPolicy: "bounded", correctionLimit: 1, elapsedMinutes: 60 },
    },
    compositions: {
      status: "pinned",
      team: {
        rosterId: id.team, revision: id.teamRevision, kind: "team", name: "team", projectId: id.project,
        members: [id.lead, id.contributorA, id.contributorB].map((agentId) => ({ agentId, responsibilities: [] })),
      },
      council: {
        rosterId: id.council, revision: id.councilRevision, kind: "council", name: "council", projectId: id.project,
        members: [{ agentId: id.reviewer, responsibilities: ["final_reviewer"] }],
      },
    },
    responsibilities: { integrationLeadAgentId: id.lead, finalReviewerAgentId: id.reviewer, requiredPerspectives: [] },
    phase: "ready_for_review",
    control: { status: "inactive", reason: "candidate_ready_for_review" },
    readiness: { mission: "recorded", compositions: "pinned", execution: "blocked", blockers: [] },
    journal: [],
    commandReceipts: [],
    effectIntents: [],
    n1: {
      periodKey: profile.periodKey,
      candidate: candidate(),
      contributions: [
        { contributionId: id.contributionA, assigneeAgentId: id.contributorA, authorRunId: randomUUID(), commit: "1".repeat(40), ownedPaths: ["src/a/"] },
        { contributionId: id.contributionB, assigneeAgentId: id.contributorB, authorRunId: randomUUID(), commit: "2".repeat(40), ownedPaths: ["src/b/"] },
      ],
    },
  };
}

function harness(options: { confirmReviewDuringNativeUpdate?: boolean } = {}) {
  let version = 12;
  let stored = aggregate();
  let issue: Record<string, unknown> = {
    id: id.root, companyId: id.company, projectId: id.project, status: "in_progress", assigneeAgentId: id.lead,
  };
  let baseline: { runIds: string[]; tokenTotal: number } = { runIds: [id.leadRun], tokenTotal: 100 };
  const row = () => ({
    company_id: id.company, mission_id: id.mission, root_issue_id: id.root, project_id: id.project,
    owner_user_id: id.owner, team_roster_id: id.team, team_revision: id.teamRevision,
    council_roster_id: id.council, council_revision: id.councilRevision,
    version, aggregate: structuredClone(stored), created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(),
  });
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    if (params[0] !== id.company) return [];
    if (params[1] !== id.mission && params[1] !== id.root) return [];
    return [row()];
  });
  const execute = vi.fn(async (_sql: string, params: unknown[]) => {
    if (params[1] !== id.company || params[2] !== id.mission || params[3] !== version) return { rowCount: 0 };
    stored = JSON.parse(String(params[0])) as MissionAggregate;
    version += 1;
    return { rowCount: 1 };
  });
  const update = vi.fn(async (_issueId: string, patch: Record<string, unknown>) => {
    if (patch.status === "in_review") {
      issue = {
        ...issue,
        status: "in_review",
        assigneeAgentId: id.reviewer,
        executionState: {
          currentParticipant: { type: "agent", agentId: id.reviewer },
          returnAssignee: { type: "agent", agentId: id.lead },
          lastDecisionOutcome: null,
        },
      };
      if (options.confirmReviewDuringNativeUpdate) {
        stored = {
          ...stored,
          phase: "reviewing",
          n2: confirmN2ReviewHandoff(stored.n2!, { aggregate: stored } as never, {
            status: "in_review",
            assigneeAgentId: id.reviewer,
            currentParticipantAgentId: id.reviewer,
            returnAssigneeAgentId: id.lead,
            observedRunIds: [id.leadRun, id.reviewerRun1].sort(),
            reviewerRunId: id.reviewerRun1,
          }),
        };
        version += 1;
      }
    }
    return structuredClone(issue);
  });
  const requestWakeup = vi.fn(async () => ({ queued: true, runId: id.correctionRun }));
  const ctx = {
    db: { namespace: "plugin_private_n2_runtime", query, execute },
    companies: { get: vi.fn(async () => ({ id: id.company, defaultResponsibleUserId: id.owner })) },
    issues: { get: vi.fn(async () => structuredClone(issue)), update, requestWakeup },
  } as unknown as PluginContext;
  return {
    ctx,
    current: () => structuredClone(stored),
    version: () => version,
    setIssue: (next: Record<string, unknown>) => { issue = next; },
    setBaseline: (next: { runIds: string[]; tokenTotal: number }) => { baseline = next; },
    baseline: () => baseline,
    update,
    requestWakeup,
  };
}

function agentRequest(command: Record<string, unknown>, agentId: string, runId: string): PluginApiRequestInput {
  return {
    routeKey: "mission-agent-command",
    method: "POST",
    path: "",
    headers: {},
    params: { issueId: id.root },
    query: {},
    body: { missionId: id.mission, ...command },
    companyId: id.company,
    actor: { actorType: "agent", actorId: agentId, agentId, runId },
  } as unknown as PluginApiRequestInput;
}

function receipt(operationId: string): DecisionReceipt {
  const state = currentN2();
  const submission = state.submissions.find((entry) => entry.submissionId === state.activeSubmissionId)!;
  return {
    companyId: id.company,
    issueId: id.root,
    operationId,
    verdict: "changes_requested",
    state: "native_observed",
    blockReason: null,
    targetUrl: `http://127.0.0.1/api/issues/${id.root}`,
    requestBody: {
      status: "in_progress",
      comment: [
        "Council decision: changes requested.",
        "Justification: Add the missing regression.",
        `Result reference: ${n2SubmissionResultReference(submission.submissionId)}`,
        `Operation ID: ${operationId}`,
      ].join("\n"),
    },
    actorAgentId: id.reviewer,
    runId: id.reviewerRun1,
    claimedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nativeObservation: { status: 200, body: { id: id.root }, observedAt: new Date().toISOString(), usable: true },
    humanDecisions: [],
  };
}

let currentN2: () => NonNullable<MissionAggregate["n2"]>;

describe("N2 persisted native journey", () => {
  beforeEach(() => {
    vi.mocked(readNativeG4Profile).mockReset().mockResolvedValue(profile);
    vi.mocked(readAdmission).mockReset().mockResolvedValue({
      ...profile,
      schemaVersion: 1,
      measurement: { status: "known", source: "native", unit: "tokens" },
      allowance: { status: "known", source: "owner", periodUnits: 200_000, taskUnits: 20_000, knownUsageUnits: 0 },
      exposure: { status: "known", source: "owner", units: 0 },
      limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 },
      reservations: [], commandReceipts: [], version: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      status: "admissible", blockers: [], accountedUnits: 0, availablePeriodUnits: 200_000,
    } as never);
    vi.mocked(reserveAdmission).mockReset().mockImplementation(async (_ctx, input) => ({
      outcome: "reserved",
      envelope: { version: input.expectedVersion + 1 } as never,
      reservation: { reservationId: input.reservationId } as never,
    }));
    vi.mocked(settleNativeSequentialRunUsage).mockReset().mockResolvedValue({ outcome: "settled", envelope: {} as never });
  });

  it("accepts a reviewer confirmation that races the owner handoff readback", async () => {
    const h = harness({ confirmReviewDuringNativeUpdate: true });
    currentN2 = () => h.current().n2!;
    vi.mocked(readNativeSequentialUsageBaseline).mockResolvedValue({ runIds: [id.leadRun], tokenTotal: 100 });

    const started = await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "start-review", commandId: randomUUID(), expectedVersion: h.version(),
        submissionId: randomUUID(), reservationId: randomUUID(),
      },
    });

    expect(started).toMatchObject({
      outcome: "requested",
      mission: { aggregate: { phase: "reviewing", n2: { rounds: [{ handoff: { state: "confirmed" } }] } } },
    });
  });

  it("persists handoff, correction admission, changed V2 and second independent review", async () => {
    const h = harness();
    currentN2 = () => h.current().n2!;
    vi.mocked(readNativeSequentialUsageBaseline).mockImplementation(async () => h.baseline());
    const submission1 = randomUUID();

    const start = await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "start-review", commandId: randomUUID(), expectedVersion: h.version(),
        submissionId: submission1, reservationId: randomUUID(),
      },
    });
    expect(start).toMatchObject({ outcome: "requested", mission: { aggregate: { phase: "review_handoff" } } });
    expect(h.update).toHaveBeenCalledWith(id.root, { status: "in_review" }, id.company, { actorUserId: id.owner });
    expect(vi.mocked(reserveAdmission)).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({
      missionId: id.mission,
      effectId: submission1,
    }));

    h.setBaseline({ runIds: [id.leadRun, id.reviewerRun1].sort(), tokenTotal: 180 });
    const confirmed = await handleN2AgentApi(agentRequest({
      command: "confirm-review-handoff", commandId: randomUUID(), expectedVersion: h.version(),
    }, id.reviewer, id.reviewerRun1), h.ctx);
    expect(confirmed).toMatchObject({ status: 200, body: { mission: { aggregate: { phase: "reviewing" } } } });

    const operationId = randomUUID();
    const decision = {
      operationId,
      verdict: "changes_requested" as const,
      actorAgentId: id.reviewer,
      runId: id.reviewerRun1,
      resultReference: n2SubmissionResultReference(currentN2().activeSubmissionId),
      justification: "Add the missing regression.",
    };
    await prepareN2Decision(h.ctx, {
      companyId: id.company, missionId: id.mission, rootIssueId: id.root, projectId: id.project,
      ownerUserId: id.owner, teamRosterId: id.team, teamRevision: id.teamRevision,
      councilRosterId: id.council, councilRevision: id.councilRevision, version: h.version(),
      aggregate: h.current(), createdAt: new Date(0).toISOString(), updatedAt: new Date().toISOString(),
    }, decision, randomUUID());
    expect(vi.mocked(reserveAdmission)).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({
      missionId: id.mission,
      effectId: operationId,
    }));
    await recordN2Decision(h.ctx, id.mission, decision, receipt(operationId));
    expect(h.current()).toMatchObject({ phase: "correction_requested", n2: { correction: { reservationId: expect.any(String) } } });

    h.setIssue({
      id: id.root, companyId: id.company, projectId: id.project, status: "in_progress", assigneeAgentId: id.lead,
      executionState: { lastDecisionOutcome: "changes_requested" },
    });
    await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "settle-n2-usage", commandId: randomUUID(), expectedVersion: h.version(),
        target: "review", round: 1, settlementCommandId: randomUUID(), expectedAdmissionVersion: 3,
      },
    });
    h.setBaseline({ runIds: [id.leadRun, id.reviewerRun1].sort(), tokenTotal: 180 });
    const startedCorrection = await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: { command: "start-correction", commandId: randomUUID(), expectedVersion: h.version() },
    });
    expect(startedCorrection).toMatchObject({ outcome: "requested", mission: { aggregate: { phase: "correcting" } } });
    expect(h.requestWakeup).toHaveBeenCalledTimes(1);

    vi.mocked(verifyIntegratedCandidate).mockResolvedValue(candidate("e".repeat(40), "f".repeat(64), id.attachment2));
    const submission2 = randomUUID();
    const prepared = await handleN2AgentApi(agentRequest({
      command: "prepare-resubmission", commandId: randomUUID(), expectedVersion: h.version(),
      attachmentId: id.attachment2, baseCommit: "a".repeat(40), candidateCommit: "e".repeat(40),
      expectedSha256: "f".repeat(64), submissionId: submission2, correctedPaths: ["src/a/a.ts"],
    }, id.lead, id.correctionRun), h.ctx);
    expect(prepared).toMatchObject({
      status: 200, body: { mission: { aggregate: { n2: { status: "resubmission_prepared" } } } },
    });

    h.setBaseline({ runIds: [id.leadRun, id.reviewerRun1, id.correctionRun].sort(), tokenTotal: 260 });
    await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "settle-n2-usage", commandId: randomUUID(), expectedVersion: h.version(),
        target: "correction", settlementCommandId: randomUUID(), expectedAdmissionVersion: 5,
      },
    });
    expect(currentN2().correction?.usageSettledAt).toEqual(expect.any(String));

    const resubmitted = await executeN2BoardCommand(h.ctx, {
      companyId: id.company,
      missionId: id.mission,
      actorUserId: id.owner,
      body: {
        command: "start-resubmitted-review", commandId: randomUUID(), expectedVersion: h.version(),
        reservationId: randomUUID(),
      },
    });
    expect(resubmitted).toMatchObject({ outcome: "requested", mission: { aggregate: { phase: "review_handoff", n2: { activeSubmissionId: submission2 } } } });
    expect(vi.mocked(reserveAdmission)).toHaveBeenLastCalledWith(h.ctx, expect.objectContaining({
      missionId: id.mission,
      effectId: submission2,
    }));
    expect(currentN2()).toMatchObject({ submissions: [{ ordinal: 1 }, { ordinal: 2 }], correctionsUsed: 1 });
  });
});
