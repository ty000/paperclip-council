import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  AdmissionError,
  configureAdmission,
  readAdmission,
  reserveAdmission,
  settleAdmission,
  type AdmissionConfigureInput,
  type AdmissionSettleInput,
} from "./admission.js";
import {
  canonicalPayloadHash,
  getMission,
  MissionError,
  type MissionAggregate,
  type MissionRecord,
  type MissionReceipt,
} from "./missions.js";
import { createContributionIssueEffect, type ContributionIssueIntent } from "./contribution-effects.js";
import {
  assertNativeConfigurationRequest,
  assertNativeEnvelope,
  assertNativeLaunchAllowed,
  nativeAdmissionConfiguration,
  readNativeG4Profile,
  settleNativeRunUsage,
} from "./g4-native.js";
import { verifyIntegratedCandidate, type IntegratedCandidateVerification } from "./integration.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;

type Slot = {
  contributionId: string;
  assigneeAgentId: string;
  title: string;
  ownedPaths: string[];
  issueState: "planned" | "creation_claimed" | "confirmed" | "unknown";
  intentId?: string;
  childIssueId?: string;
  issueUnknown?: string;
  dispatchState?: "claimed" | "requested" | "unknown";
  dispatchReservationId?: string;
  dispatchRunId?: string | null;
  commit?: string;
  authorRunId?: string;
};

type N1State = {
  periodKey: string;
  activationReservationId: string;
  activatedAt: string;
  rootDispatchState?: "claimed" | "requested" | "unknown";
  rootDispatchRunId?: string | null;
  rootDispatchMode?: "native" | "fixture";
  contributions: Slot[];
  candidate?: IntegratedCandidateVerification;
  lastIntegrationFailure?: string;
};

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(400, "malformed_request", "Command body must be an object");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value !== value.trim()) {
    throw new MissionError(400, "malformed_request", label + " must be a nonempty bounded string");
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  if (!UUID.test(result)) throw new MissionError(400, "malformed_request", label + " must be a UUID");
  return result;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new MissionError(400, "malformed_request", label + " must be a positive safe integer");
  }
  return Number(value);
}

function n1State(mission: MissionRecord): N1State | null {
  const state = mission.aggregate.n1;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  return state as N1State;
}

function table(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return ctx.db.namespace + ".missions";
}

function receipt(mission: MissionRecord, commandId: string, actorId: string, hash: string) {
  const found = mission.aggregate.commandReceipts.find((item) => item.commandId === commandId);
  if (!found) return null;
  if (found.actorId !== actorId || found.payloadHash !== hash) {
    throw new MissionError(409, "command_identity_conflict", "commandId belongs to a different actor or payload");
  }
  return found;
}

async function cas(
  ctx: PluginContext,
  mission: MissionRecord,
  aggregate: MissionAggregate,
  expectedVersion: number,
): Promise<MissionRecord> {
  const changed = await ctx.db.execute(
    "UPDATE " + table(ctx) + " SET aggregate = $1::jsonb, version = version + 1, updated_at = now() " +
    "WHERE company_id = $2 AND mission_id = $3 AND version = $4",
    [JSON.stringify(aggregate), mission.companyId, mission.missionId, expectedVersion],
  );
  const after = await getMission(ctx, mission.companyId, mission.missionId);
  if (!after) throw new Error("Mission disappeared after CAS");
  if (changed.rowCount !== 1) {
    throw new MissionError(409, "version_conflict", "Mission changed concurrently", { currentVersion: after.version });
  }
  return after;
}

async function commandCas(
  ctx: PluginContext,
  mission: MissionRecord,
  body: Record<string, unknown>,
  actorType: "user" | "agent",
  actorId: string,
  next: MissionAggregate,
) {
  const commandId = uuid(body.commandId, "commandId");
  const expectedVersion = integer(body.expectedVersion, "expectedVersion");
  const payloadHash = canonicalPayloadHash(body);
  const old = receipt(mission, commandId, actorId, payloadHash);
  if (old) return { outcome: "replayed" as const, mission, receipt: old };
  if (mission.version !== expectedVersion) {
    throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
  }
  if (mission.aggregate.commandReceipts.length >= 100) {
    throw new MissionError(409, "command_limit_reached", "Mission command receipt limit reached");
  }
  const command = boundedString(body.command, "command") as MissionReceipt["command"];
  const nextVersion = expectedVersion + 1;
  const item: MissionReceipt = {
    commandId, command, actorType, actorId, payloadHash, appliedVersion: nextVersion,
    result: { missionId: mission.missionId, version: nextVersion }, recordedAt: new Date().toISOString(),
  };
  next.commandReceipts = [...mission.aggregate.commandReceipts, item];
  const after = await cas(ctx, mission, next, expectedVersion);
  return { outcome: "applied" as const, mission: after, receipt: item };
}

function requireFreshCommand(mission: MissionRecord, body: Record<string, unknown>): void {
  const expectedVersion = integer(body.expectedVersion, "expectedVersion");
  if (mission.version !== expectedVersion) {
    throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: mission.version });
  }
  if (mission.aggregate.commandReceipts.length >= 100) {
    throw new MissionError(409, "command_limit_reached", "Mission command receipt limit reached");
  }
}

async function owner(ctx: PluginContext, mission: MissionRecord, actorUserId: string | null) {
  const company = await ctx.companies.get(mission.companyId);
  if (!company || company.id !== mission.companyId || !company.defaultResponsibleUserId) {
    throw new MissionError(422, "owner_not_configured", "Company owner is not configured");
  }
  if (!actorUserId || actorUserId !== company.defaultResponsibleUserId || actorUserId !== mission.ownerUserId) {
    throw new MissionError(403, "owner_required", "Configured mission owner required");
  }
}

async function lead(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput) {
  const actor = input.actor;
  if (actor.actorType !== "agent" || actor.agentId !== mission.aggregate.responsibilities.integrationLeadAgentId || !actor.runId) {
    throw new MissionError(403, "integration_lead_required", "Active integration lead run required");
  }
  if (input.params.issueId !== mission.rootIssueId) {
    throw new MissionError(403, "root_issue_required", "Command must address the mission root issue");
  }
  const dispatch = n1State(mission);
  if (dispatch?.rootDispatchState !== "requested" || !dispatch.rootDispatchRunId
      || actor.runId !== dispatch.rootDispatchRunId) {
    throw new MissionError(409, "root_dispatch_run_mismatch", "Integration Lead command requires its confirmed admitted run");
  }
  const issue = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
      || issue.assigneeAgentId !== actor.agentId || issue.status !== "in_progress") {
    throw new MissionError(409, "root_ownership_changed", "Root issue is not in progress under the integration lead");
  }
  await ctx.issues.assertCheckoutOwner({
    issueId: mission.rootIssueId, companyId: mission.companyId,
    actorAgentId: actor.agentId, actorRunId: actor.runId,
  });
  return { agentId: actor.agentId, runId: actor.runId };
}

function readSlotPlan(value: unknown, mission: MissionRecord): Slot[] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new MissionError(422, "two_contributors_required", "Exactly two contributions are required");
  }
  const allowed = new Set(mission.aggregate.compositions.team.members.map((member) => member.agentId));
  const reviewer = mission.aggregate.responsibilities.finalReviewerAgentId;
  const integrationLead = mission.aggregate.responsibilities.integrationLeadAgentId;
  const slots = value.map((item: unknown) => {
    const record = bodyRecord(item);
    const ownedPaths = record.ownedPaths;
    if (!Array.isArray(ownedPaths) || ownedPaths.length < 1 || ownedPaths.length > 64) {
      throw new MissionError(422, "ownership_required", "Each contribution needs bounded ownedPaths");
    }
    return {
      contributionId: uuid(record.contributionId, "contributionId"),
      assigneeAgentId: uuid(record.assigneeAgentId, "assigneeAgentId"),
      title: boundedString(record.title, "title", 200),
      ownedPaths: ownedPaths.map((path) => {
        const parsed = boundedString(path, "ownedPath", 512);
        const segments = (parsed.endsWith("/") ? parsed.slice(0, -1) : parsed).split("/");
        if (parsed.startsWith("/") || parsed.includes("\\") || parsed.includes("//")
            || segments.some((part) => part === "." || part === ".." || part === ".git" || part === "")) {
          throw new MissionError(422, "invalid_owned_path", "Owned paths must be safe repository-relative POSIX paths");
        }
        return parsed;
      }),
      issueState: "planned" as const,
    };
  });
  if (slots[0].contributionId === slots[1].contributionId || slots[0].assigneeAgentId === slots[1].assigneeAgentId) {
    throw new MissionError(422, "distinct_contributors_required", "Contribution IDs and assignees must be distinct");
  }
  for (const slot of slots) {
    if (!allowed.has(slot.assigneeAgentId) || slot.assigneeAgentId === integrationLead || slot.assigneeAgentId === reviewer) {
      throw new MissionError(422, "contributor_ineligible", "Contributor must be a distinct pinned team member");
    }
  }
  for (const left of slots[0].ownedPaths) {
    for (const right of slots[1].ownedPaths) {
      const overlaps = left === right
        || (left.endsWith("/") && right.startsWith(left))
        || (right.endsWith("/") && left.startsWith(right));
      if (overlaps) throw new MissionError(422, "ownership_overlap", "Contribution write ownership overlaps");
    }
  }
  return slots;
}

function contributionDescription(input: {
  missionId: string;
  contributionId: string;
  ownedPaths: string[];
}): string {
  return [
    "Council N1 contribution. Complete only this bounded child issue.",
    `Mission ID: ${input.missionId}`,
    `Contribution ID: ${input.contributionId}`,
    `Owned paths: ${input.ownedPaths.join(", ")}`,
    "Do not modify files outside the owned paths. Commit the completed change on the current shared branch.",
    "Use the authenticated endpoint /api/plugins/private.paperclip-council/api/issues/<this-child-issue-id>/council/commands: first command=inspect to read the current mission version, then command=record-contribution with a fresh commandId, that expectedVersion, the contributionId, and the 40-character commit SHA.",
    "Mark this Paperclip child issue done only after record-contribution succeeds.",
    "",
    "Plugins/skills à utiliser",
    "Use the Paperclip skill injected by the host for issue context, authenticated API calls, and status updates. No additional plugin is required.",
    "",
    "Modele et effort recommandes",
    "Target: bounded implementation contributor. Model: gpt-5.6-sol. Effort: high because the run participates in a governed native integration proof. Re-evaluate only if availability is rejected before launch; do not silently substitute. Source: independent mapping /home/davy-lp/.codex/shared/model-selection/model-effort-mapping.md, updated 2026-09-05. Effective runtime settings must be observed separately.",
  ].join("\n");
}

export function inspectN1State(mission: MissionRecord) {
  const state = n1State(mission);
  if (!state) return null;
  const unresolved = state.contributions.find((slot) => slot.issueState === "unknown" || slot.issueState === "creation_claimed");
  const nextAction = state.candidate
    ? "Integration Lead has published a checked candidate; eligible final reviewer may begin N2 review."
    : unresolved
      ? "Manual native issue reconciliation is required before any further creation or dispatch."
      : state.contributions.length === 0
        ? state.rootDispatchState === "unknown" || state.rootDispatchState === "claimed"
          ? "Owner must reconcile the root lead wakeup before any further launch."
          : "Owner may start the Integration Lead; the lead then records the two-contributor plan."
        : state.contributions.some((slot) => slot.issueState === "planned")
          ? "Integration Lead must materialize the planned child issues."
          : state.contributions.some((slot) => !slot.dispatchState)
            ? "Integration Lead must reserve and dispatch each mapped child issue."
            : state.contributions.some((slot) => slot.dispatchState === "unknown" || slot.dispatchState === "claimed")
              ? "Manual dispatch reconciliation is required before further launch."
              : state.contributions.some((slot) => !slot.commit)
                ? "Assigned contributors must report their Git commits through their child issues."
            : "Integration Lead must publish a verified integrated Git bundle.";
  return {
    prerequisites: mission.aggregate.readiness.blockers,
    nextAction,
    participants: state.contributions,
    candidate: state.candidate ?? null,
    reservations: { activation: state.activationReservationId, periodKey: state.periodKey },
    blocker: unresolved?.issueUnknown ?? state.lastIntegrationFailure ?? null,
  };
}

export async function readN1AdmissionForMission(ctx: PluginContext, mission: MissionRecord) {
  const state = n1State(mission);
  if (!state) return null;
  return readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
}

export async function executeN1BoardCommand(ctx: PluginContext, input: {
  companyId: string;
  missionId: string;
  actorUserId: string | null;
  body: Record<string, unknown>;
}) {
  const mission = await getMission(ctx, input.companyId, input.missionId);
  if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
  await owner(ctx, mission, input.actorUserId);
  if (input.body.command === "fixture-bind-lead-run") {
    if (!await isOwnedFixtureRuntime(ctx, mission.companyId) || input.body.fixtureSource !== "fixture:local-sandbox") {
      throw new MissionError(403, "fixture_only", "Synthetic run binding is confined to the owned local sandbox");
    }
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    requireFreshCommand(mission, input.body);
    const state = n1State(mission);
    if (!state || mission.aggregate.control.status !== "active" || state.rootDispatchState) {
      throw new MissionError(409, "root_dispatch_unavailable", "Synthetic binding requires an active mission without a wake claim");
    }
    const runId = uuid(input.body.runId, "runId");
    const root = await ctx.issues.get(mission.rootIssueId, mission.companyId);
    const leadAgentId = mission.aggregate.responsibilities.integrationLeadAgentId;
    if (!root || root.companyId !== mission.companyId || root.projectId !== mission.projectId
        || root.assigneeAgentId !== leadAgentId || root.status !== "in_progress") {
      throw new MissionError(409, "root_ownership_changed", "Synthetic lead run needs the mapped native root issue");
    }
    await ctx.issues.assertCheckoutOwner({
      issueId: mission.rootIssueId, companyId: mission.companyId,
      actorAgentId: leadAgentId, actorRunId: runId,
    });
    const next: MissionAggregate = {
      ...mission.aggregate,
      n1: { ...state, rootDispatchState: "requested", rootDispatchRunId: runId, rootDispatchMode: "fixture" },
      journal: [...mission.aggregate.journal, {
        action: "fixture_lead_run_bound_without_wakeup", runId, actorUserId: input.actorUserId,
        at: new Date().toISOString(),
      }],
    };
    return commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
  }
  if (input.body.command === "start-lead") {
    const fixtureRuntime = await isOwnedFixtureRuntime(ctx, mission.companyId);
    const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, mission.companyId);
    if (!fixtureRuntime && !nativeProfile) {
      throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
    }
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    const state = n1State(mission);
    if (!state || mission.aggregate.control.status !== "active" || state.rootDispatchState) {
      throw new MissionError(409, "root_dispatch_unavailable", "Root dispatch is unavailable or already claimed");
    }
    const activatedAt = Date.parse(state.activatedAt);
    if (!Number.isFinite(activatedAt) || Date.now() >= activatedAt + mission.aggregate.mandate.limits.elapsedMinutes * 60_000) {
      throw new MissionError(409, "elapsed_limit_exceeded", "Mission elapsed limit blocks root dispatch");
    }
    const admission = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
    const reservation = admission?.reservations.find((item) => item.reservationId === state.activationReservationId);
    if (!reservation || reservation.missionId !== mission.missionId || reservation.status !== "reserved"
        || Date.now() < Date.parse(admission!.periodStart) || Date.now() >= Date.parse(admission!.periodEnd)) {
      throw new MissionError(409, "g4_reservation_unavailable", "Root launch requires its durable unsettled reservation");
    }
    if (nativeProfile) {
      assertNativeEnvelope(admission!, nativeProfile);
      await assertNativeLaunchAllowed(ctx, { companyId: mission.companyId, issueId: mission.rootIssueId });
    }
    const root = await ctx.issues.get(mission.rootIssueId, mission.companyId);
    const leadAgentId = mission.aggregate.responsibilities.integrationLeadAgentId;
    const leadAgent = await ctx.agents.get(leadAgentId, mission.companyId);
    if (!root || root.companyId !== mission.companyId || root.projectId !== mission.projectId
        || root.assigneeAgentId !== leadAgentId || !["backlog", "todo"].includes(root.status)
        || !leadAgent || leadAgent.companyId !== mission.companyId
        || !["active", "idle", "running"].includes(leadAgent.status)) {
      throw new MissionError(409, "root_dispatch_ineligible", "Root issue or lead is no longer eligible");
    }
    const next: MissionAggregate = {
      ...mission.aggregate,
      n1: { ...state, rootDispatchState: "claimed" },
      effectIntents: [...mission.aggregate.effectIntents, {
        kind: "root_wakeup", state: "claimed", reservationId: state.activationReservationId,
        issueId: mission.rootIssueId, assigneeAgentId: leadAgentId,
      }],
      journal: [...mission.aggregate.journal, {
        action: "root_dispatch_claimed", reservationId: state.activationReservationId,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
    };
    const claim = await commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
    if (claim.outcome !== "applied") return claim;
    let wake: { queued: boolean; runId: string | null } | null = null;
    try {
      if (root.status === "backlog") {
        await ctx.issues.update(mission.rootIssueId, { status: "todo" }, mission.companyId, { actorUserId: input.actorUserId! });
      }
      wake = await ctx.issues.requestWakeup(mission.rootIssueId, mission.companyId, {
        idempotencyKey: "council:n1:" + state.activationReservationId,
        reason: "council_integration_lead_dispatch",
        actorUserId: input.actorUserId!,
      });
    } catch {
      // A lost response cannot authorize a second wakeup.
    }
    const afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
    if (!afterClaim) throw new Error("Mission disappeared after root dispatch effect");
    const afterState = n1State(afterClaim);
    if (!afterState) throw new Error("N1 state disappeared after root dispatch effect");
    const confirmed = Boolean(wake?.queued && wake.runId);
    const settled: MissionAggregate = {
      ...afterClaim.aggregate,
      n1: { ...afterState, rootDispatchState: confirmed ? "requested" : "unknown", rootDispatchRunId: wake?.runId ?? null, rootDispatchMode: "native" },
      effectIntents: afterClaim.aggregate.effectIntents.map((entry) =>
        entry.kind === "root_wakeup" && entry.reservationId === state.activationReservationId
          ? { ...entry, state: confirmed ? "requested" : "unknown", queued: wake?.queued ?? null, runId: wake?.runId ?? null }
          : entry),
    };
    const finalMission = await cas(ctx, afterClaim, settled, afterClaim.version);
    return { outcome: confirmed ? "requested" as const : "unknown" as const, mission: finalMission, receipt: claim.receipt };
  }
  if (input.body.command === "reconcile-lead-usage") {
    const state = n1State(mission);
    if (!state?.rootDispatchRunId || state.rootDispatchState !== "requested" || state.rootDispatchMode !== "native") {
      throw new MissionError(409, "root_dispatch_unavailable", "A confirmed native lead run is required for usage reconciliation");
    }
    const profile = await readNativeG4Profile(ctx, mission.companyId);
    if (!profile) throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
    const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
    if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
    assertNativeEnvelope(envelope, profile);
    const settlement = await settleNativeRunUsage(ctx, {
      commandId: uuid(input.body.commandId, "commandId"),
      companyId: mission.companyId,
      issueId: mission.rootIssueId,
      runId: state.rootDispatchRunId,
      periodKey: state.periodKey,
      reservationId: state.activationReservationId,
      expectedVersion: envelope.version,
    });
    return { ...settlement, mission };
  }
  if (input.body.command !== "activate") throw new MissionError(400, "unknown_command", "Unsupported N1 board command");
  const commandId = uuid(input.body.commandId, "commandId");
  const hash = canonicalPayloadHash(input.body);
  const prior = receipt(mission, commandId, input.actorUserId!, hash);
  if (prior) return { outcome: "replayed" as const, mission, receipt: prior };
  requireFreshCommand(mission, input.body);
  if (mission.aggregate.phase !== "draft" || mission.aggregate.control.status !== "inactive") {
    throw new MissionError(409, "not_draft", "Only an inactive draft mission may activate");
  }
  const periodKey = boundedString(input.body.periodKey, "periodKey", 120);
  const reservationId = uuid(input.body.reservationId, "reservationId");
  const requestedUnits = integer(input.body.requestedUnits, "requestedUnits");
  const eligibleTeam = mission.aggregate.compositions.team.members.filter(
    (member) => member.agentId !== mission.aggregate.responsibilities.integrationLeadAgentId,
  );
  if (eligibleTeam.length < 2) {
    throw new MissionError(422, "two_contributors_required", "Pinned team needs two contributors in addition to the lead");
  }
  const root = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  if (!root || root.companyId !== mission.companyId || root.projectId !== mission.projectId
      || root.assigneeAgentId !== mission.aggregate.responsibilities.integrationLeadAgentId
      || !["backlog", "todo"].includes(root.status)) {
    throw new MissionError(409, "root_ownership_changed",
      "Root issue must be assigned to the integration lead and not already running");
  }
  const project = await ctx.projects.get(mission.projectId, mission.companyId);
  if (!project || project.companyId !== mission.companyId || project.archivedAt) {
    throw new MissionError(422, "project_incompatible", "Mission project is no longer available");
  }
  const executionAgentIds = new Set(mission.aggregate.compositions.team.members.map((member) => member.agentId));
  const reviewerAgentIds = new Set(mission.aggregate.compositions.council.members.map((member) => member.agentId));
  if ([...reviewerAgentIds].some((agentId) => executionAgentIds.has(agentId))) {
    throw new MissionError(422, "self_review_conflict", "Pinned candidate authors and reviewers must remain distinct");
  }
  for (const agentId of new Set([...executionAgentIds, ...reviewerAgentIds])) {
    const agent = await ctx.agents.get(agentId, mission.companyId);
    if (!agent || agent.companyId !== mission.companyId || !["active", "idle", "running"].includes(agent.status)) {
      throw new MissionError(422, "agent_ineligible", "Pinned execution agent is no longer eligible");
    }
  }
  await requireActivationReservation(ctx, {
    companyId: mission.companyId, missionId: mission.missionId,
    periodKey, reservationId, requestedUnits, commandId,
  });
  const next: MissionAggregate = {
    ...mission.aggregate,
    phase: "executing",
    control: { status: "active" },
    readiness: {
      ...mission.aggregate.readiness, execution: "blocked",
      blockers: [
        { code: "g4_root_reserved", status: "ready", message: "Root lead launch allowance is durably reserved." },
        { code: "child_dispatch_pending", status: "pending", message: "Child launches require their own admission and effect reconciliation." },
      ],
    },
    n1: { periodKey, activationReservationId: reservationId, activatedAt: new Date().toISOString(), contributions: [] },
    journal: [...mission.aggregate.journal, {
      action: "mission_activated", actorUserId: input.actorUserId, at: new Date().toISOString(),
      periodKey, reservationId,
    }],
  };
  try {
    return await commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
  } catch (error) {
    // Another command may have adopted the same reservation before the mission CAS.
    // Retain it until ownership is reconciled; a zero-usage settlement could release a live launch.
    throw error;
  }
}

async function requireActivationReservation(
  ctx: PluginContext,
  input: { companyId: string; missionId: string; periodKey: string; reservationId: string; requestedUnits: number; commandId: string },
): Promise<void> {
  const envelope = await readAdmission(ctx, { companyId: input.companyId, periodKey: input.periodKey });
  if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
  const fixtureRuntime = await isOwnedFixtureRuntime(ctx, input.companyId);
  if (fixtureRuntime) {
    if (envelope.measurement.status !== "known"
        || envelope.measurement.source !== "fixture:local-sandbox"
        || envelope.allowance.status !== "known"
        || envelope.allowance.source !== "fixture:local-sandbox"
        || envelope.exposure.status !== "known"
        || envelope.exposure.source !== "fixture:local-sandbox") {
      throw new MissionError(409, "g4_measurement_unqualified", "Fixture admission inputs are not qualified");
    }
  } else {
    const profile = await readNativeG4Profile(ctx, input.companyId);
    if (!profile) {
      throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
    }
    assertNativeEnvelope(envelope, profile);
    if (input.periodKey !== profile.periodKey || input.requestedUnits !== profile.runReservationUnits) {
      throw new MissionError(422, "g4_profile_mismatch", "Activation must use the configured period and run reservation estimate");
    }
  }
  const result = await reserveAdmission(ctx, {
    companyId: input.companyId, periodKey: input.periodKey,
    reservationId: input.reservationId, missionId: input.missionId,
    effectId: input.commandId, requestedUnits: input.requestedUnits,
    attempt: { kind: "initial", ordinal: 0 }, expectedVersion: envelope.version,
  });
  if (!result.reservation || result.reservation.status !== "reserved") {
    throw new MissionError(409, "g4_reservation_unavailable", "Durable root reservation is unavailable");
  }
}

async function isOwnedFixtureRuntime(ctx: PluginContext, companyId: string): Promise<boolean> {
  if (process.env.NODE_ENV !== "test") return false;
  const config = await ctx.config.get(companyId);
  return config.n1FixtureMode === "ephemeral-local-sandbox";
}

export async function handleN1AdmissionApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    const companyId = boundedString(input.params.companyId, "companyId", 64);
    if (companyId !== input.companyId) throw new MissionError(403, "company_scope_mismatch", "Company scope mismatch");
    const company = await ctx.companies.get(companyId);
    if (!company || !company.defaultResponsibleUserId || input.actor.actorType !== "user"
        || input.actor.userId !== company.defaultResponsibleUserId) {
      throw new MissionError(403, "owner_required", "Configured company owner required");
    }
    if (input.method === "GET") {
      const periodKey = boundedString(input.query.periodKey, "periodKey", 120);
      return { status: 200, body: { envelope: await readAdmission(ctx, { companyId, periodKey }) } };
    }
    const body = bodyRecord(input.body);
    if (body.command === "configure") {
      const configuration = body.configuration as AdmissionConfigureInput;
      if (!configuration || configuration.companyId !== companyId) {
        throw new MissionError(403, "company_scope_mismatch", "Admission configuration company mismatch");
      }
      const fixtureRuntime = await isOwnedFixtureRuntime(ctx, companyId);
      const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, companyId);
      if (nativeProfile) {
        assertNativeConfigurationRequest(configuration, nativeAdmissionConfiguration(
          nativeProfile,
          companyId,
          configuration.commandId,
        ));
      } else if (configuration.measurement?.status === "known") {
        if (!fixtureRuntime) {
          throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
        }
        if (configuration.measurement.source !== "fixture:local-sandbox"
          || configuration.allowance?.status !== "known"
          || configuration.allowance.source !== "fixture:local-sandbox"
          || configuration.exposure?.status !== "known"
          || configuration.exposure.source !== "fixture:local-sandbox") {
          throw new MissionError(422, "fixture_source_required",
            "Known fixture admission inputs must be labeled fixture:local-sandbox");
        }
      }
      const result = await configureAdmission(ctx, configuration);
      return { status: 200, body: result };
    }
    if (body.command === "settle") {
      const settlement = body.settlement as AdmissionSettleInput;
      if (!settlement || settlement.companyId !== companyId) {
        throw new MissionError(403, "company_scope_mismatch", "Settlement company mismatch");
      }
      if (!await isOwnedFixtureRuntime(ctx, companyId)) {
        throw new MissionError(409, "g4_measurement_unqualified",
          "Native usage settlement must be derived from the expected terminal Paperclip run");
      }
      const result = await settleAdmission(ctx, settlement);
      return { status: 200, body: result };
    }
    throw new MissionError(400, "unknown_command", "Unknown admission command");
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}

export async function handleN1AgentApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) {
      throw new MissionError(403, "agent_run_required", "Authenticated agent run required");
    }
    const body = bodyRecord(input.body);
    const missionId = uuid(body.missionId, "missionId");
    const mission = await getMission(ctx, input.companyId, missionId);
    if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
    const state = n1State(mission);
    if (!state || mission.aggregate.control.status !== "active") {
      throw new MissionError(409, "mission_inactive", "Mission is not active");
    }
    if (input.params.issueId !== mission.rootIssueId
        && !state.contributions.some((slot) => slot.childIssueId === input.params.issueId)) {
      throw new MissionError(404, "mission_issue_not_found", "This issue is not mapped to the mission");
    }
    if (body.command === "inspect") {
      if (input.params.issueId === mission.rootIssueId) {
        await lead(ctx, mission, input);
      } else {
        const slot = state.contributions.find((entry) => entry.childIssueId === input.params.issueId);
        if (!slot || input.actor.agentId !== slot.assigneeAgentId) {
          throw new MissionError(403, "contributor_required", "Assigned contributor on the mapped child issue required");
        }
        if (slot.dispatchState !== "requested" || !slot.dispatchRunId || input.actor.runId !== slot.dispatchRunId) {
          throw new MissionError(409, "dispatch_run_mismatch", "Contribution run does not match its admitted native dispatch");
        }
        await ctx.issues.assertCheckoutOwner({
          issueId: slot.childIssueId!, companyId: mission.companyId,
          actorAgentId: input.actor.agentId, actorRunId: input.actor.runId,
        });
      }
      return {
        status: 200,
        body: { missionId: mission.missionId, version: mission.version, phase: mission.aggregate.phase, n1: inspectN1State(mission) },
      };
    }
    const commandId = uuid(body.commandId, "commandId");
    const hash = canonicalPayloadHash(body);
    const prior = receipt(mission, commandId, input.actor.agentId, hash);
    if (prior) return { status: 200, body: { outcome: "replayed", mission, receipt: prior } };
    if (body.command === "plan") {
      const actor = await lead(ctx, mission, input);
      if (state.contributions.length !== 0) throw new MissionError(409, "plan_exists", "Contribution plan already exists");
      const slots = readSlotPlan(body.contributions, mission);
      for (const slot of slots) {
        const agent = await ctx.agents.get(slot.assigneeAgentId, mission.companyId);
        if (!agent || agent.companyId !== mission.companyId || !["active", "idle", "running"].includes(agent.status)) {
          throw new MissionError(422, "agent_ineligible", "Contributor is no longer eligible");
        }
      }
      const next: MissionAggregate = {
        ...mission.aggregate,
        n1: { ...state, contributions: slots },
        journal: [...mission.aggregate.journal, { action: "contribution_plan_recorded", actorAgentId: actor.agentId, runId: actor.runId, at: new Date().toISOString() }],
      };
      const result = await commandCas(ctx, mission, body, "agent", actor.agentId, next);
      return { status: 200, body: result };
    }
    if (body.command === "materialize") {
      const actor = await lead(ctx, mission, input);
      const contributionId = uuid(body.contributionId, "contributionId");
      const index = state.contributions.findIndex((slot) => slot.contributionId === contributionId);
      if (index < 0) throw new MissionError(404, "contribution_not_found", "Contribution slot not found");
      const slot = state.contributions[index];
      if (slot.issueState !== "planned") {
        throw new MissionError(409, "creation_already_claimed", "Child creation already claimed; inspect and reconcile it");
      }
      const intentId = randomUUID();
      const intent: ContributionIssueIntent = {
        state: "creation_claimed", intentId, companyId: mission.companyId,
        projectId: mission.projectId, rootIssueId: mission.rootIssueId,
        missionId: mission.missionId, contributionId, assigneeAgentId: slot.assigneeAgentId,
        title: slot.title,
        description: contributionDescription({
          missionId: mission.missionId,
          contributionId,
          ownedPaths: slot.ownedPaths,
        }),
        actor: { actorAgentId: actor.agentId, actorRunId: actor.runId },
      };
      const claimed: Slot = { ...slot, issueState: "creation_claimed", intentId };
      const contributions = [...state.contributions];
      contributions[index] = claimed;
      const next: MissionAggregate = {
        ...mission.aggregate,
        n1: { ...state, contributions },
        effectIntents: [...mission.aggregate.effectIntents, { kind: "child_issue_create", ...intent }],
        journal: [...mission.aggregate.journal, { action: "child_creation_claimed", contributionId, actorAgentId: actor.agentId, runId: actor.runId, at: new Date().toISOString() }],
      };
      const claim = await commandCas(ctx, mission, body, "agent", actor.agentId, next);
      if (claim.outcome !== "applied") return { status: 200, body: claim };
      const effect = await createContributionIssueEffect(ctx, intent);
      const afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
      if (!afterClaim) throw new Error("Mission disappeared after effect");
      const afterState = n1State(afterClaim);
      if (!afterState) throw new Error("N1 state disappeared after effect");
      const afterIndex = afterState.contributions.findIndex((entry) => entry.contributionId === contributionId);
      const updatedSlots = [...afterState.contributions];
      updatedSlots[afterIndex] = effect.state === "confirmed"
        ? { ...updatedSlots[afterIndex], issueState: "confirmed", childIssueId: effect.issue.id }
        : { ...updatedSlots[afterIndex], issueState: "unknown", issueUnknown: effect.reason };
      const settled: MissionAggregate = {
        ...afterClaim.aggregate,
        n1: { ...afterState, contributions: updatedSlots },
        effectIntents: afterClaim.aggregate.effectIntents.map((entry) => entry.intentId === intentId
          ? { ...entry, state: effect.state, childIssueId: effect.state === "confirmed" ? effect.issue.id : null,
            unknownReason: effect.state === "unknown" ? effect.reason : null }
          : entry),
      };
      const finalMission = await cas(ctx, afterClaim, settled, afterClaim.version);
      return { status: effect.state === "confirmed" ? 200 : 202, body: { outcome: effect.state, effect, mission: finalMission } };
    }
    if (body.command === "dispatch") {
      const actor = await lead(ctx, mission, input);
      const activatedAt = Date.parse(state.activatedAt);
      if (!Number.isFinite(activatedAt) || Date.now() >= activatedAt + mission.aggregate.mandate.limits.elapsedMinutes * 60_000) {
        throw new MissionError(409, "elapsed_limit_exceeded", "Mission elapsed limit blocks new child dispatch");
      }
      const contributionId = uuid(body.contributionId, "contributionId");
      const index = state.contributions.findIndex((slot) => slot.contributionId === contributionId);
      if (index < 0) throw new MissionError(404, "contribution_not_found", "Contribution slot not found");
      const slot = state.contributions[index];
      if (slot.issueState !== "confirmed" || !slot.childIssueId || slot.dispatchState) {
        throw new MissionError(409, "dispatch_unavailable", "Child issue is not confirmed or dispatch was already claimed");
      }
      const issue = await ctx.issues.get(slot.childIssueId, mission.companyId);
      const agent = await ctx.agents.get(slot.assigneeAgentId, mission.companyId);
      if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
          || issue.parentId !== mission.rootIssueId || issue.assigneeAgentId !== slot.assigneeAgentId
          || issue.status !== "backlog" || !agent || agent.companyId !== mission.companyId
          || !["active", "idle", "running"].includes(agent.status)) {
        throw new MissionError(409, "native_dispatch_ineligible", "Native child or assignee is no longer eligible for dispatch");
      }
      const reservationId = uuid(body.reservationId, "reservationId");
      const requestedUnits = integer(body.requestedUnits, "requestedUnits");
      requireFreshCommand(mission, body);
      const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
      if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
      const fixtureRuntime = await isOwnedFixtureRuntime(ctx, mission.companyId);
      const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, mission.companyId);
      if (!fixtureRuntime && !nativeProfile) {
        throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
      }
      if (nativeProfile) {
        assertNativeEnvelope(envelope, nativeProfile);
        if (requestedUnits !== nativeProfile.runReservationUnits) {
          throw new MissionError(422, "g4_profile_mismatch", "Child dispatch must use the configured run reservation estimate");
        }
        const unsettledPriorChild = state.contributions.find((entry) => {
          if (!entry.dispatchReservationId) return false;
          const reservation = envelope.reservations.find((item) => item.reservationId === entry.dispatchReservationId);
          return reservation?.status !== "settled";
        });
        if (unsettledPriorChild) {
          throw new MissionError(409, "g4_sequential_settlement_required",
            "The previous contribution run must be terminal and its token usage settled before another child launch");
        }
        await assertNativeLaunchAllowed(ctx, { companyId: mission.companyId, issueId: slot.childIssueId });
      }
      const reserved = await reserveAdmission(ctx, {
        companyId: mission.companyId, periodKey: state.periodKey,
        reservationId, missionId: mission.missionId, effectId: contributionId,
        requestedUnits, attempt: { kind: "initial", ordinal: 0 }, expectedVersion: envelope.version,
      });
      if (!reserved.reservation || reserved.reservation.status !== "reserved") {
        throw new MissionError(409, "g4_reservation_unavailable", "Durable child reservation is unavailable");
      }
      const slots = [...state.contributions];
      slots[index] = { ...slot, dispatchState: "claimed", dispatchReservationId: reservationId };
      const next: MissionAggregate = {
        ...mission.aggregate,
        n1: { ...state, contributions: slots },
        effectIntents: [...mission.aggregate.effectIntents, {
          kind: "child_wakeup", state: "claimed", reservationId, contributionId,
          issueId: slot.childIssueId, assigneeAgentId: slot.assigneeAgentId,
          actorAgentId: actor.agentId, actorRunId: actor.runId,
        }],
        journal: [...mission.aggregate.journal, {
          action: "child_dispatch_claimed", contributionId, reservationId,
          actorAgentId: actor.agentId, runId: actor.runId, at: new Date().toISOString(),
        }],
      };
      let claim: Awaited<ReturnType<typeof commandCas>>;
      try {
        claim = await commandCas(ctx, mission, body, "agent", actor.agentId, next);
      } catch (error) {
        // A concurrent request can win the mission CAS using this reservation.
        // Keep the allowance reserved until its actual effect is reconciled.
        throw error;
      }
      if (claim.outcome !== "applied") return { status: 200, body: claim };
      let wake: { queued: boolean; runId: string | null } | null = null;
      try {
        await ctx.issues.update(slot.childIssueId, { status: "todo" }, mission.companyId, {
          actorAgentId: actor.agentId, actorRunId: actor.runId,
        });
        wake = await ctx.issues.requestWakeup(slot.childIssueId, mission.companyId, {
          idempotencyKey: "council:n1:" + reservationId,
          reason: "council_contribution_dispatch",
          actorAgentId: actor.agentId, actorRunId: actor.runId,
        });
      } catch {
        // Native state may have changed even when the response was lost.
      }
      const wakeConfirmed = Boolean(wake?.queued && wake.runId);
      const afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
      if (!afterClaim) throw new Error("Mission disappeared after dispatch effect");
      const afterState = n1State(afterClaim);
      if (!afterState) throw new Error("N1 state disappeared after dispatch effect");
      const updatedSlots = afterState.contributions.map((entry) => entry.contributionId === contributionId
        ? { ...entry, dispatchState: wakeConfirmed ? "requested" as const : "unknown" as const, dispatchRunId: wake?.runId ?? null }
        : entry);
      const settled: MissionAggregate = {
        ...afterClaim.aggregate,
        n1: { ...afterState, contributions: updatedSlots },
        effectIntents: afterClaim.aggregate.effectIntents.map((entry) => entry.kind === "child_wakeup" && entry.reservationId === reservationId
          ? { ...entry, state: wakeConfirmed ? "requested" : "unknown", queued: wake?.queued ?? null, runId: wake?.runId ?? null }
          : entry),
      };
      const finalMission = await cas(ctx, afterClaim, settled, afterClaim.version);
      return { status: wakeConfirmed ? 200 : 202, body: { outcome: wakeConfirmed ? "requested" : "unknown", wake, mission: finalMission } };
    }
    if (body.command === "reconcile-usage") {
      await lead(ctx, mission, input);
      const contributionId = uuid(body.contributionId, "contributionId");
      const slot = state.contributions.find((entry) => entry.contributionId === contributionId);
      if (!slot?.childIssueId || slot.dispatchState !== "requested" || !slot.dispatchReservationId || !slot.dispatchRunId) {
        throw new MissionError(409, "dispatch_not_confirmed", "A confirmed native contribution run is required for usage reconciliation");
      }
      const profile = await readNativeG4Profile(ctx, mission.companyId);
      if (!profile) throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
      const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
      if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
      assertNativeEnvelope(envelope, profile);
      const result = await settleNativeRunUsage(ctx, {
        commandId,
        companyId: mission.companyId,
        issueId: slot.childIssueId,
        runId: slot.dispatchRunId,
        periodKey: state.periodKey,
        reservationId: slot.dispatchReservationId,
        expectedVersion: envelope.version,
      });
      return { status: 200, body: result };
    }
    if (body.command === "record-contribution") {
      const contributionId = uuid(body.contributionId, "contributionId");
      const slot = state.contributions.find((entry) => entry.contributionId === contributionId);
      if (!slot || !slot.childIssueId) throw new MissionError(404, "child_issue_not_found", "Contribution child issue is not confirmed");
      if (input.actor.agentId !== slot.assigneeAgentId || input.params.issueId !== slot.childIssueId) {
        throw new MissionError(403, "contributor_required", "Assigned contributor on the mapped child issue required");
      }
      if (slot.dispatchState !== "requested" || !slot.dispatchReservationId || !slot.dispatchRunId) {
        throw new MissionError(409, "dispatch_not_confirmed", "Contribution cannot be recorded before admitted native dispatch");
      }
      if (input.actor.runId !== slot.dispatchRunId) {
        throw new MissionError(409, "dispatch_run_mismatch", "Contribution run does not match its admitted native dispatch");
      }
      if (slot.commit) throw new MissionError(409, "contribution_recorded", "Contribution was already recorded");
      const issue = await ctx.issues.get(slot.childIssueId, mission.companyId);
      if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
          || issue.parentId !== mission.rootIssueId || issue.assigneeAgentId !== slot.assigneeAgentId
          || issue.status !== "in_progress") {
        throw new MissionError(409, "child_ownership_changed", "Child issue is not in progress under the assigned contributor");
      }
      await ctx.issues.assertCheckoutOwner({
        issueId: slot.childIssueId, companyId: mission.companyId,
        actorAgentId: input.actor.agentId, actorRunId: input.actor.runId,
      });
      const commit = boundedString(body.commit, "commit", 40);
      if (!COMMIT.test(commit)) throw new MissionError(422, "invalid_commit", "Contribution commit must be a Git SHA-1");
      const slots = state.contributions.map((entry) => entry.contributionId === contributionId
        ? { ...entry, commit, authorRunId: input.actor.runId! } : entry);
      const next: MissionAggregate = {
        ...mission.aggregate, n1: { ...state, contributions: slots },
        journal: [...mission.aggregate.journal, { action: "contribution_recorded", contributionId, commit, actorAgentId: input.actor.agentId, runId: input.actor.runId, at: new Date().toISOString() }],
      };
      const result = await commandCas(ctx, mission, body, "agent", input.actor.agentId, next);
      return { status: 200, body: result };
    }
    if (body.command === "publish") {
      const actor = await lead(ctx, mission, input);
      requireFreshCommand(mission, body);
      if (state.candidate) throw new MissionError(409, "candidate_exists", "Integrated candidate already published");
      if (state.contributions.length !== 2 || state.contributions.some((slot) =>
        !slot.commit || !slot.childIssueId || !slot.authorRunId || slot.dispatchState !== "requested" || !slot.dispatchReservationId)) {
        throw new MissionError(409, "contributions_incomplete", "Two attributed contributions and native child mappings are required");
      }
      for (const slot of state.contributions) {
        const issue = await ctx.issues.get(slot.childIssueId!, mission.companyId);
        if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
            || issue.parentId !== mission.rootIssueId || issue.assigneeAgentId !== slot.assigneeAgentId
            || issue.status !== "done") {
          throw new MissionError(409, "child_not_done", "Both mapped native child issues must be done before integration");
        }
      }
      const nativeProfile = await readNativeG4Profile(ctx, mission.companyId);
      if (nativeProfile) {
        const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
        if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
        assertNativeEnvelope(envelope, nativeProfile);
        const unsettled = state.contributions.find((slot) => {
          const reservation = envelope.reservations.find((item) => item.reservationId === slot.dispatchReservationId);
          return reservation?.status !== "settled";
        });
        if (unsettled) {
          throw new MissionError(409, "g4_usage_unsettled", "Both contribution runs need terminal token usage before candidate publication");
        }
      }
      const attachmentId = uuid(body.attachmentId, "attachmentId");
      const baseCommit = boundedString(body.baseCommit, "baseCommit", 40);
      const candidateCommit = boundedString(body.candidateCommit, "candidateCommit", 40);
      const expectedSha256 = boundedString(body.expectedSha256, "expectedSha256", 64);
      if (!COMMIT.test(baseCommit) || !COMMIT.test(candidateCommit) || !DIGEST.test(expectedSha256)) {
        throw new MissionError(422, "invalid_candidate_identity", "Candidate Git and digest identity is malformed");
      }
      let verified: IntegratedCandidateVerification;
      try {
        verified = await verifyIntegratedCandidate(ctx, {
          companyId: mission.companyId, issueId: mission.rootIssueId,
          attachmentId, baseCommit, candidateCommit, expectedSha256,
          contributions: [
            { contributionId: state.contributions[0].contributionId, commit: state.contributions[0].commit!, ownedPaths: state.contributions[0].ownedPaths },
            { contributionId: state.contributions[1].contributionId, commit: state.contributions[1].commit!, ownedPaths: state.contributions[1].ownedPaths },
          ],
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Integrated Git verification failed";
        const failed: MissionAggregate = {
          ...mission.aggregate,
          phase: "integrating",
          n1: { ...state, lastIntegrationFailure: reason },
          journal: [...mission.aggregate.journal, {
            action: "integration_check_failed", actorAgentId: actor.agentId, runId: actor.runId,
            reason, at: new Date().toISOString(),
          }],
        };
        const recorded = await cas(ctx, mission, failed, mission.version);
        throw new MissionError(422, "integration_failed", reason, { currentVersion: recorded.version });
      }
      const next: MissionAggregate = {
        ...mission.aggregate, phase: "ready_for_review", control: { status: "inactive", reason: "candidate_ready_for_review" },
        n1: { ...state, candidate: verified, lastIntegrationFailure: undefined },
        journal: [...mission.aggregate.journal, { action: "integrated_candidate_published", actorAgentId: actor.agentId, runId: actor.runId, candidate: verified.candidate, checks: verified.checks, at: new Date().toISOString() }],
      };
      const result = await commandCas(ctx, mission, body, "agent", actor.agentId, next);
      return { status: 200, body: result };
    }
    throw new MissionError(400, "unknown_command", "Unknown N1 agent command");
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}
