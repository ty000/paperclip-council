import { candidateAttachmentTarget } from "./candidate-attachment.js";
import { assertN1DepartureWindow, assertContinuityDeparture } from "./continuity-policy.js";
import { n1LeadExecution, type N1Integration } from "./n1-integration-state.js";
import { contributionStatusBeforeIntegration } from "./integration-contract.js";
import { completionPolicy } from "./completion-contract.js";
import { sourceBase, recordContributionProof, closeQualifiedContribution } from "./contribution-proof.js";
import { recoverContribution } from "./contribution-recovery.js";
import { prepareN1Resume, verifyResumedLeadRun } from "./n1-resume.js";
import { finishN1Disposition, restoreRecoveredCandidateWait } from "./native-wake-policy.js";
import { settledResumeReservation, n1ResumeGrants, n1ResumeOrdinal, priorLeadRunIds, type N1Resume, type ResumeTarget } from "./n1-resume-state.js";
import { physicalAgent, isLogicalActor } from "./model-state.js";
import { contributionModelFamily, prepareVariantLaunch, bindVariantIssue, claimVariantWake, recordVariantWake, observeVariantRun } from "./model-runtime.js";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { assertProjectDeparture, assertProjectPaths } from "./project-mandate-guard.js";
import { assertLinearAdmissionFresh } from "./linear-intake-admission-guard.js";
import { contributionCountAllowed, leadIssueId } from "./hierarchy-contract.js";
import { leadCommandsFor } from "./lead-command.js";
import { prepareHierarchyCoordinator, type N1Coordination } from "./hierarchy-coordinator.js";
import { assertHierarchySources, assertHierarchyDependencies, materializeHierarchyGuidance } from "./hierarchy-runtime.js";
import { ensureHierarchyLaunchGuidance } from "./hierarchy-guidance.js";
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
import { contributionCommand } from "./contribution-command.js";
import { readContributionContext } from "./contribution-context.js";
import {
  assertNativeConfigurationRequest,
  assertNativeEnvelope,
  assertNativeLaunchAllowed,
  nativeAdmissionConfiguration,
  readNativeG4Profile,
  settleNativeRunUsage,
  settleOrdinaryRunUsage,
  readOrdinaryRun,
} from "./g4-native.js";
import { ownershipsOverlap, verifyIntegratedCandidate, type IntegratedCandidateInput, type IntegratedCandidateVerification } from "./integration.js";

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
  parentIssueId?: string | null;
  issueUnknown?: string;
  dispatchState?: "claimed" | "requested" | "unknown";
  dispatchReservationId?: string;
  dispatchRunId?: string | null;
  dispatchUsageBaselineUnits?: number;
  proof?: import("./integration.js").ContributionBundleProof;
  nativeWait?: { state: "claimed" | "confirmed"; issueId?: string };
  commit?: string;
  authorRunId?: string;
  referenceRecovery?: { previousCommit: string; actorUserId: string; commandId: string };
  contributionRecovery?: { actorUserId: string; commandId: string; workProductId: string };
};

export type N1State = {
  integration?: N1Integration;
  hierarchyCommands?: Record<string, Record<string, unknown>>;
  sourceBaseCommit?: string;
  coordination?: N1Coordination;
  resume?: N1Resume;
  resumeHistory?: N1Resume[];
  periodKey: string;
  activationReservationId: string;
  activatedAt: string;
  rootDispatchState?: "claimed" | "requested" | "unknown";
  rootDispatchRunId?: string | null;
  rootDispatchMode?: "native" | "fixture";
  rootUsageBaselineUnits?: number;
  contributions: Slot[];
  candidate?: IntegratedCandidateVerification;
  candidateRecordedVersion?: number;
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
    "UPDATE " + table(ctx) + " SET aggregate = $1::jsonb, owner_user_id = $1::jsonb->>'ownerUserId', version = version + 1, updated_at = now() " +
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
  preparedVersion?: number,
) {
  const commandId = uuid(body.commandId, "commandId");
  const expectedVersion = preparedVersion ?? integer(body.expectedVersion, "expectedVersion");
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

async function recoveredCommandCas(
  ctx: PluginContext,
  mission: MissionRecord,
  body: Record<string, unknown>,
  actorType: "user" | "agent",
  actorId: string,
  next: MissionAggregate,
) {
  const commandId = uuid(body.commandId, "commandId");
  const requestedVersion = integer(body.expectedVersion, "expectedVersion");
  const payloadHash = canonicalPayloadHash(body);
  const old = receipt(mission, commandId, actorId, payloadHash);
  if (old) return { outcome: "replayed" as const, mission, receipt: old };
  if (mission.version !== requestedVersion + 1) {
    throw new MissionError(409, "version_conflict", "Mission recovery requires exactly one intervening version", {
      currentVersion: mission.version,
    });
  }
  if (mission.aggregate.commandReceipts.length >= 100) {
    throw new MissionError(409, "command_limit_reached", "Mission command receipt limit reached");
  }
  const command = boundedString(body.command, "command") as MissionReceipt["command"];
  const nextVersion = mission.version + 1;
  const item: MissionReceipt = {
    commandId, command, actorType, actorId, payloadHash, appliedVersion: nextVersion,
    result: { missionId: mission.missionId, version: nextVersion }, recordedAt: new Date().toISOString(),
  };
  next.commandReceipts = [...mission.aggregate.commandReceipts, item];
  const after = await cas(ctx, mission, next, mission.version);
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

async function owner(ctx: PluginContext, mission: MissionRecord, actorUserId: string | null, transfer = false) {
  const company = await ctx.companies.get(mission.companyId);
  if (!company || company.id !== mission.companyId || !company.defaultResponsibleUserId) {
    throw new MissionError(422, "owner_not_configured", "Company owner is not configured");
  }
  if (!actorUserId || actorUserId !== company.defaultResponsibleUserId || !transfer && actorUserId !== mission.ownerUserId) {
    throw new MissionError(403, "owner_required", "Configured mission owner required");
  }
}

async function lead(ctx: PluginContext, mission: MissionRecord, input: PluginApiRequestInput) {
  const actor = input.actor;
  const execution = n1LeadExecution(mission);
  if (actor.actorType !== "agent" || !actor.agentId || !actor.runId || !isLogicalActor(mission, mission.aggregate.responsibilities.integrationLeadAgentId, actor.agentId, actor.runId)) {
    throw new MissionError(403, "integration_lead_required", "Active integration lead run required");
  }
  if (!execution.issueId || input.params.issueId !== execution.issueId) {
    throw new MissionError(403, "root_issue_required", "Command must address the mission root issue");
  }
  const dispatch = n1State(mission);
  if (dispatch?.rootDispatchState !== "requested" || !execution.runId
      || actor.runId !== execution.runId) {
    throw new MissionError(409, "root_dispatch_run_mismatch", "Integration Lead command requires its confirmed admitted run");
  }
  const issue = await ctx.issues.get(execution.issueId, mission.companyId);
  if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
      || issue.assigneeAgentId !== actor.agentId || issue.status !== "in_progress") {
    throw new MissionError(409, "root_ownership_changed", "Root issue is not in progress under the integration lead");
  }
  await ctx.issues.assertCheckoutOwner({
    issueId: execution.issueId, companyId: mission.companyId,
    actorAgentId: actor.agentId, actorRunId: actor.runId,
  });
  return { agentId: actor.agentId, runId: actor.runId };
}

function readSlotPlan(value: unknown, mission: MissionRecord): Slot[] {
  if (!Array.isArray(value) || !contributionCountAllowed(mission, value.length)) {
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
  if (new Set(slots.map(slot => slot.contributionId)).size !== slots.length || !mission.aggregate.hierarchy && new Set(slots.map(slot => slot.assigneeAgentId)).size !== slots.length) {
    throw new MissionError(422, "distinct_contributors_required", "Contribution IDs and assignees must be distinct");
  }
  for (const slot of slots) {
    assertProjectPaths(mission, slot.ownedPaths);
    if (!allowed.has(slot.assigneeAgentId) || slot.assigneeAgentId === integrationLead || slot.assigneeAgentId === reviewer) {
      throw new MissionError(422, "contributor_ineligible", "Contributor must be a distinct pinned team member");
    }
  }
  for (const [index, slot] of slots.entries()) for (const other of slots.slice(index + 1)) {
    for (const left of slot.ownedPaths) for (const right of other.ownedPaths) {
      if (ownershipsOverlap(left, right)) throw new MissionError(422, "ownership_overlap", "Contribution write ownership overlaps");
    }
  }
  const leaves = mission.aggregate.hierarchy?.leaves;
  if (!leaves) return slots;
  if (leaves.length !== slots.length || leaves.some((leaf, index) => {
    const slot = slots[index]!;
    return leaf.contributionId !== slot.contributionId || leaf.assigneeAgentId !== slot.assigneeAgentId || leaf.title !== slot.title
      || canonicalPayloadHash(leaf.ownedPaths) !== canonicalPayloadHash(slot.ownedPaths);
  })) throw new MissionError(409, "hierarchy_plan_changed", "Use exactly the pinned existing leaves in dependency order; no replacement or inferred scope");
  return slots.map((slot, index) => ({ ...slot, childIssueId: leaves[index]!.issueId, parentIssueId: leaves[index]!.parentId }));
}

export function contributionDescription(input: {
  missionId: string;
  contributionId: string;
  ownedPaths: string[];
  context?: string;
  closeThroughCouncil?: boolean;
}): string {
  return [
    "Council N1 contribution. Complete only this bounded child issue.",
    `Mission ID: ${input.missionId}`,
    `Contribution ID: ${input.contributionId}`,
    `Owned paths: ${input.ownedPaths.join(", ")}`,
    ...(input.context ? ["", input.context, "", "## Contribution reporting"] : []),
    "Do not modify files outside the owned paths. Commit the completed change on the current shared branch.",
    `The command below first sends {"command":"inspect","missionId":"${input.missionId}"}, then records the contribution through the authenticated Council endpoint.`,
    "After committing, run this complete command unchanged from your repository. It reads the full SHA directly from Git and constructs the UUID/payload itself. Never expand an abbreviated SHA, copy a SHA into JSON, or replace this with a handwritten record-contribution request. It sends no retries; retain its printed request for any uncertain-effect readback.",
    "```sh",
    contributionCommand(input.missionId, input.contributionId),
    "```",
    input.closeThroughCouncil
      ? "Council manages this child through its SDK. If inspect.n1.proofPolicy exists, record the verified child bundle with the supplied command; Council parks it blocked until the admitted run succeeds and exact usage settles, then closes it. Finish your run; do not issue another status/comment wake."
      : "Mark this Paperclip child issue done only after record-contribution succeeds.",
    "For any non-2xx response, preserve the HTTP status and sanitized JSON response body in your final report without exposing credentials.",
    "",
    "Plugins/skills à utiliser",
    "Use the Paperclip skill injected by the host for issue context, authenticated API calls, and status updates. No additional plugin is required.",
    "",
    "Modele et effort recommandes",
    "Target: bounded implementation contributor. Use the exact persisted Council profile when this issue carries a profile launch binding. Otherwise the recommendation is gpt-5.6-sol / medium for bounded implementation; reconsider high for substantial difficulty. Source: independent model-effort-mapping.md, 2026-09-05. Recommendation is not an observed setting; never silently substitute.",
  ].join("\n");
}

export function inspectN1State(mission: MissionRecord) {
  const state = n1State(mission);
  if (!state) return null;
  const unresolved = state.contributions.find((slot) => slot.issueState === "unknown" || slot.issueState === "creation_claimed");
  const nextAction = state.candidate
    ? mission.aggregate.phase === "ready_for_review"
      ? "Integration Lead has published a checked candidate; eligible final reviewer may begin N2 review."
      : "Owner must reconcile terminal Integration Lead usage before the checked candidate becomes review-ready."
    : unresolved
      ? "Manual native issue reconciliation is required before any further creation or dispatch."
      : state.contributions.length === 0
        ? state.rootDispatchState === "unknown" || state.rootDispatchState === "claimed"
          ? "Owner must reconcile the root lead wakeup before any further launch."
          : "The admitted Integration Lead must use inspect.n1.leadCommands to record the pinned hierarchy or business contribution plan; the owner starts it only if no admitted run exists."
        : state.contributions.some((slot) => slot.issueState === "planned")
          ? "Integration Lead must complete the native parent plan with outcomes, interfaces, sources and acceptance checks, then materialize and read back the child descriptions before dispatch."
          : state.contributions.some((slot) => !slot.dispatchState)
            ? "Integration Lead must dispatch each mapped child issue. Reuse each exact reservationId in inspect.n1.resume.preparedContributions; never allocate a replacement for a prepared child."
            : state.contributions.some((slot) => slot.dispatchState === "unknown" || slot.dispatchState === "claimed")
              ? "Manual dispatch reconciliation is required before further launch."
              : state.contributions.some((slot) => !slot.commit)
                ? "Assigned contributors must report their Git commits through their child issues."
            : "Integration Lead must publish a verified integrated Git bundle.";
  return {
    integration: state.integration,
    resume: state.resume ?? null,
    resumeHistory: state.resumeHistory,
    ...(mission.aggregate.hierarchy ? { hierarchy: mission.aggregate.hierarchy, coordinationIssueId: leadIssueId(mission), rootIssueId: mission.rootIssueId } : {}),
    prerequisites: mission.aggregate.readiness.blockers,
    ...(mission.aggregate.projectMandate ? { projectMandate: mission.aggregate.projectMandate } : {}),
    nextAction,
    participants: state.contributions,
    ...leadCommandsFor(mission.missionId, state),
    ...(completionPolicy(mission) ? { proofPolicy: completionPolicy(mission), sourceBaseCommit: state.sourceBaseCommit } : {}),
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

async function reconcileContributionUsage(
  ctx: PluginContext,
  mission: MissionRecord,
  input: { commandId: string; contributionId: string },
) {
  const state = n1State(mission);
  const slot = state?.contributions.find((entry) => entry.contributionId === input.contributionId);
  if (!state || !slot?.childIssueId || slot.dispatchState !== "requested" || !slot.dispatchReservationId
      || !slot.dispatchRunId || !Number.isSafeInteger(slot.dispatchUsageBaselineUnits)
      || slot.dispatchUsageBaselineUnits! < 0) {
    throw new MissionError(409, "dispatch_not_confirmed", "A confirmed native contribution run is required for usage reconciliation");
  }
  const profile = await readNativeG4Profile(ctx, mission.companyId);
  if (!profile) throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
  const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
  if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
  assertNativeEnvelope(envelope, profile);
  if (state.resume?.contributions.some(t => t.contributionId === slot.contributionId)) {
    return settleOrdinaryRunUsage(ctx, { commandId: input.commandId, companyId: mission.companyId,
      issueId: slot.childIssueId, runId: slot.dispatchRunId,
      agentId: physicalAgent(mission, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.dispatchRunId }),
      periodKey: state.periodKey, reservationId: slot.dispatchReservationId, expectedVersion: envelope.version });
  }
  return settleNativeRunUsage(ctx, {
    commandId: input.commandId,
    companyId: mission.companyId,
    issueId: slot.childIssueId,
    runId: slot.dispatchRunId,
    baselineUsageUnits: slot.dispatchUsageBaselineUnits!,
    periodKey: state.periodKey,
    reservationId: slot.dispatchReservationId,
    expectedVersion: envelope.version,
  });
}

async function assertRecoverySettled(ctx: PluginContext, mission: MissionRecord, state: N1State) {
  const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
  const bindings = [
    { issueId: leadIssueId(mission), runId: state.rootDispatchRunId, reservationId: state.activationReservationId },
    ...state.contributions.map(slot => ({ issueId: slot.childIssueId, runId: slot.dispatchRunId, reservationId: slot.dispatchReservationId })),
  ];
  for (const binding of bindings) {
    const priors = n1ResumeGrants(state).flatMap(grant => [grant.lead, ...grant.contributions])
      .filter(target => target.issueId === binding.issueId);
    await assertSettledRecoveryRun(ctx, mission, envelope, binding, priors);
  }
}

async function assertSettledRecoveryRun(
  ctx: PluginContext, mission: MissionRecord, envelope: Awaited<ReturnType<typeof readAdmission>>,
  binding: { issueId?: string; runId?: string | null; reservationId?: string },
  priors: ResumeTarget[],
) {
  const reservation = envelope?.reservations.find(item => item.reservationId === binding.reservationId);
  if (!binding.issueId || !binding.runId || reservation?.missionId !== mission.missionId
      || reservation.status !== "settled" || reservation.usage?.status !== "known"
      || reservation.remainingExposure.status !== "known" || reservation.remainingExposure.units !== 0) {
    throw new MissionError(409, "recovery_usage_unsettled", "Recovery requires all original runs settled without exposure");
  }
  for (const prior of priors) {
    const previous = envelope?.reservations.find(item => item.reservationId === prior.priorReservationId);
    if (!previous || previous.missionId !== mission.missionId || !settledResumeReservation(previous)) {
      throw new MissionError(409, "recovery_usage_unsettled", "Resumed recovery also requires the original reservation settled without exposure");
    }
  }
  const summary = await ctx.issues.summaries.getOrchestration({ companyId: mission.companyId, issueId: binding.issueId, includeSubtree: false });
  const expected = [binding.runId, ...priors.map(prior => prior.priorRunId)];
  if (summary.runs.length !== expected.length || new Set(summary.runs.map(run => run.id)).size !== expected.length
      || summary.runs.some(run => !expected.includes(run.id) || run.status !== "succeeded")) {
    throw new MissionError(409, "recovery_run_not_terminal", "Recovery requires only the exact successful original and explicitly resumed runs");
  }
}

function requireRecoveryState(mission: MissionRecord): N1State {
  const state = n1State(mission);
  if (!state || state.candidate || mission.aggregate.n2 || mission.aggregate.n5
      || !["executing", "integrating"].includes(mission.aggregate.phase)
      || mission.aggregate.control.status !== "active" || state.rootDispatchMode !== "native"
      || state.rootDispatchState !== "requested" || !contributionCountAllowed(mission, state.contributions.length)) {
    throw new MissionError(409, "recovery_unavailable", "Only a native mission stopped before its first candidate may recover");
  }
  return state;
}

async function assertRecoveryChildren(ctx: PluginContext, mission: MissionRecord, state: N1State) {
  for (const contribution of state.contributions) await assertRecoveryChild(ctx, mission, contribution);
}

async function assertRecoveryChild(ctx: PluginContext, mission: MissionRecord, contribution: Slot) {
  const child = contribution.childIssueId ? await ctx.issues.get(contribution.childIssueId, mission.companyId) : null;
  if (!contribution.commit || !contribution.authorRunId || contribution.authorRunId !== contribution.dispatchRunId
    || contribution.dispatchState !== "requested" || contribution.issueState !== "confirmed" || child?.status !== "done"
    || child.companyId !== mission.companyId || child.projectId !== mission.projectId || child.parentId !== (contribution.parentIssueId !== undefined ? contribution.parentIssueId : mission.rootIssueId)
    || child.assigneeAgentId !== physicalAgent(mission, contribution.assigneeAgentId, { issueId: contribution.childIssueId })) {
    throw new MissionError(409, "recovery_child_incomplete", "Recovery retains two attributed, completed native children");
  }
}

async function recoverIntegration(ctx: PluginContext, mission: MissionRecord, body: Record<string, unknown>, actorUserId: string) {
  const state = requireRecoveryState(mission);
  const contributionId = uuid(body.contributionId, "contributionId");
  const previousCommit = boundedString(body.previousCommit, "previousCommit", 40);
  const replacementCommit = boundedString(body.replacementCommit, "replacementCommit", 40);
  const reason = boundedString(body.reason, "reason", 1000);
  const slot = state.contributions.find(item => item.contributionId === contributionId);
  if (!COMMIT.test(previousCommit) || !COMMIT.test(replacementCommit) || previousCommit === replacementCommit
      || !slot || slot.commit !== previousCommit) {
    throw new MissionError(409, "recovery_reference_mismatch", "Recovery must name the exact recorded erroneous SHA and one replacement");
  }
  await assertRecoveryChildren(ctx, mission, state);
  await assertRecoverySettled(ctx, mission, state);
  const baseCommit = boundedString(body.baseCommit, "baseCommit", 40);
  if (mission.aggregate.n6 && baseCommit !== mission.aggregate.n6.expectedResult.candidateCommit) {
    throw new MissionError(409, "recovery_source_mismatch", "Dependent recovery must retain its accepted source base");
  }
  const contributions = state.contributions.map(item => item.contributionId === contributionId
    ? { ...item, commit: replacementCommit, referenceRecovery: { previousCommit, actorUserId, commandId: uuid(body.commandId, "commandId") } }
    : item);
  let candidate: IntegratedCandidateVerification;
  try {
    candidate = await verifyIntegratedCandidate(ctx, {
      companyId: mission.companyId, issueId: mission.rootIssueId,
      attachmentIssueId: candidateAttachmentTarget(mission, n1LeadExecution(mission).issueId),
      attachmentId: uuid(body.attachmentId, "attachmentId"),
      expectedSha256: boundedString(body.expectedSha256, "expectedSha256", 64),
      baseCommit, candidateCommit: boundedString(body.candidateCommit, "candidateCommit", 40),
      contributions: contributions.map(item => ({ contributionId: item.contributionId, commit: item.commit!, ownedPaths: item.ownedPaths })) as IntegratedCandidateInput["contributions"],
      missingReference: previousCommit,
      ...(mission.aggregate.hierarchy ? { contributionPolicy: mission.aggregate.hierarchy } : {}),
    });
  } catch (error) {
    throw new MissionError(422, "recovery_git_verification_failed", error instanceof Error ? error.message : "Recovery Git proof failed");
  }
  const result = await commandCas(ctx, mission, body, "user", actorUserId, {
    ...mission.aggregate,
    phase: "ready_for_review", control: { status: "inactive", reason: "candidate_ready_for_review" },
    n1: { ...state, contributions, candidate, candidateRecordedVersion: mission.version + 1, lastIntegrationFailure: undefined },
    journal: [...mission.aggregate.journal, {
      action: "owner_recovered_integration", actorUserId, contributionId, previousCommit, replacementCommit,
      reason, candidate: candidate.candidate, originalAuthorRunId: slot.authorRunId, at: new Date().toISOString(),
    }],
  });
  result.mission = await restoreRecoveredCandidateWait(ctx, result.mission);
  return result;
}

async function recoverCandidate(ctx: PluginContext, mission: MissionRecord, body: Record<string, unknown>, actorUserId: string) {
  const state = requireRecoveryState(mission);
  const reason = boundedString(body.reason, "reason", 1000);
  if (body.integrationAdjustedPaths !== undefined && !Array.isArray(body.integrationAdjustedPaths)) {
    throw new MissionError(400, "malformed_request", "integrationAdjustedPaths must be an explicit list of changed files");
  }
  const integrationAdjustedPaths = body.integrationAdjustedPaths as string[] | undefined;
  await assertRecoveryChildren(ctx, mission, state);
  await assertRecoverySettled(ctx, mission, state);
  const baseCommit = boundedString(body.baseCommit, "baseCommit", 40);
  if (mission.aggregate.n6 && baseCommit !== mission.aggregate.n6.expectedResult.candidateCommit) {
    throw new MissionError(409, "recovery_source_mismatch", "Dependent recovery must retain its accepted source base");
  }
  let candidate: IntegratedCandidateVerification;
  try {
    candidate = await verifyIntegratedCandidate(ctx, {
      companyId: mission.companyId, issueId: mission.rootIssueId,
      attachmentIssueId: candidateAttachmentTarget(mission, n1LeadExecution(mission).issueId),
      attachmentId: uuid(body.attachmentId, "attachmentId"),
      expectedSha256: boundedString(body.expectedSha256, "expectedSha256", 64),
      baseCommit, candidateCommit: boundedString(body.candidateCommit, "candidateCommit", 40),
      contributions: state.contributions.map(item => ({ contributionId: item.contributionId, commit: item.commit!, ownedPaths: item.ownedPaths })) as IntegratedCandidateInput["contributions"],
      integrationAdjustedPaths,
      ...(mission.aggregate.hierarchy ? { contributionPolicy: mission.aggregate.hierarchy } : {}),
    });
  } catch (error) {
    throw new MissionError(422, "recovery_git_verification_failed", error instanceof Error ? error.message : "Recovery Git proof failed");
  }
  const result = await commandCas(ctx, mission, body, "user", actorUserId, {
    ...mission.aggregate,
    phase: "ready_for_review", control: { status: "inactive", reason: "candidate_ready_for_review" },
    n1: { ...state, candidate, candidateRecordedVersion: mission.version + 1, lastIntegrationFailure: undefined },
    journal: [...mission.aggregate.journal, {
      action: "owner_recovered_candidate", actorUserId, reason, candidate: candidate.candidate,
      integrationAdjustedPaths: integrationAdjustedPaths ?? [],
      originalLeadRunId: state.rootDispatchRunId, at: new Date().toISOString(),
    }],
  });
  result.mission = await restoreRecoveredCandidateWait(ctx, result.mission);
  return result;
}

export async function executeN1BoardCommand(ctx: PluginContext, input: {
  companyId: string;
  missionId: string;
  actorUserId: string | null;
  body: Record<string, unknown>;
}) {
  let mission = await getMission(ctx, input.companyId, input.missionId);
  if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
  await owner(ctx, mission, input.actorUserId, input.body.command === "prepare-n1-resume");
  if (input.body.command === "bind-resumed-lead-run") {
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    requireFreshCommand(mission, input.body);
    const runId = uuid(input.body.runId, "runId");
    const state = await verifyResumedLeadRun(ctx, mission, runId);
    return recordVariantWake(ctx, mission, state.activationReservationId, runId, async (before, aggregate) =>
      commandCas(ctx, before, input.body, "user", input.actorUserId!, { ...aggregate,
        n1: { ...state, rootDispatchState: "requested", rootDispatchRunId: runId },
        effectIntents: aggregate.effectIntents.map(e => e.kind === "root_wakeup" && e.reservationId === state.activationReservationId
          ? { ...e, state: "requested", runId, observedByOwner: input.actorUserId } : e),
        journal: [...aggregate.journal, { action: "resumed_lead_run_observed", runId,
          reservationId: state.activationReservationId, actorUserId: input.actorUserId, at: new Date().toISOString() }] }));
  }
  if (input.body.command === "prepare-n1-resume") {
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    requireFreshCommand(mission, input.body);
    const next = await prepareN1Resume(ctx, mission, input.body, input.actorUserId!);
    return commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
  }
  if (["recover-integration", "recover-candidate", "recover-contribution"].includes(String(input.body.command))) {
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) {
      const recoveredCandidate = n1State(mission)?.candidate?.candidate.candidateCommit;
      if (input.body.command !== "recover-contribution" && mission.aggregate.phase === "ready_for_review"
          && recoveredCandidate === input.body.candidateCommit) {
        mission = await restoreRecoveredCandidateWait(ctx, mission);
      }
      return { outcome: "replayed" as const, mission, receipt: replay };
    }
    requireFreshCommand(mission, input.body);
    if (input.body.command === "recover-contribution") {
      const next = await recoverContribution(ctx, mission, {
        contributionId: uuid(input.body.contributionId, "contributionId"), commit: boundedString(input.body.commit, "commit", 40),
        workProductId: uuid(input.body.workProductId, "workProductId"), proof: input.body.proof,
        actorUserId: input.actorUserId!, commandId, reason: boundedString(input.body.reason, "reason", 1000),
      });
      return commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
    }
    return input.body.command === "recover-candidate"
      ? recoverCandidate(ctx, mission, input.body, input.actorUserId!)
      : recoverIntegration(ctx, mission, input.body, input.actorUserId!);
  }
  if (input.body.command === "reconcile-contribution-usage") {
    const result = await reconcileContributionUsage(ctx, mission, {
      commandId: uuid(input.body.commandId, "commandId"),
      contributionId: uuid(input.body.contributionId, "contributionId"),
    });
    const contribution = n1State(mission)!.contributions.find(slot => slot.contributionId === input.body.contributionId)!;
    mission = await observeVariantRun(ctx, mission, contribution.dispatchReservationId!);
    if (contribution.proof) mission = await closeQualifiedContribution(ctx, mission, contribution.contributionId, (current, aggregate) => cas(ctx, current, aggregate, current.version));
    return { ...result, mission };
  }
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
  if (input.body.command === "fixture-bind-contribution-run") {
    if (!await isOwnedFixtureRuntime(ctx, mission.companyId) || input.body.fixtureSource !== "fixture:local-sandbox") {
      throw new MissionError(403, "fixture_only", "Synthetic run binding is confined to the owned local sandbox");
    }
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    requireFreshCommand(mission, input.body);
    const state = n1State(mission);
    const contributionId = uuid(input.body.contributionId, "contributionId");
    const index = state?.contributions.findIndex((entry) => entry.contributionId === contributionId) ?? -1;
    const slot = index >= 0 ? state!.contributions[index] : undefined;
    if (!state || mission.aggregate.control.status !== "active" || !slot?.childIssueId
        || slot.issueState !== "confirmed" || slot.dispatchState) {
      throw new MissionError(409, "dispatch_unavailable", "Synthetic binding requires one confirmed undispatched contribution");
    }
    for (const prior of state.contributions.slice(0, index)) {
      const priorIssue = prior.childIssueId
        ? await ctx.issues.get(prior.childIssueId, mission.companyId)
        : null;
      if (!prior.commit || !prior.authorRunId || prior.dispatchState !== "requested"
          || !prior.dispatchReservationId || !prior.dispatchRunId
          || prior.authorRunId !== prior.dispatchRunId || priorIssue?.status !== "done") {
        throw new MissionError(409, "prior_contribution_incomplete",
          "Every earlier fixture contribution must be recorded and done before the next binding");
      }
    }
    const runId = uuid(input.body.runId, "runId");
    const reservationId = uuid(input.body.reservationId, "reservationId");
    const requestedUnits = integer(input.body.requestedUnits, "requestedUnits");
    const issue = await ctx.issues.get(slot.childIssueId, mission.companyId);
    if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
        || issue.parentId !== (slot.parentIssueId !== undefined ? slot.parentIssueId : mission.rootIssueId) || issue.assigneeAgentId !== physicalAgent(mission, slot.assigneeAgentId, { issueId: slot.childIssueId })
        || issue.status !== "in_progress") {
      throw new MissionError(409, "child_ownership_changed", "Synthetic contribution run needs its mapped in-progress child issue");
    }
    await ctx.issues.assertCheckoutOwner({
      issueId: slot.childIssueId, companyId: mission.companyId,
      actorAgentId: slot.assigneeAgentId, actorRunId: runId,
    });
    const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
    if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
    const reserved = await reserveAdmission(ctx, {
      companyId: mission.companyId, periodKey: state.periodKey,
      reservationId, missionId: mission.missionId, effectId: contributionId,
      requestedUnits, attempt: { kind: "initial", ordinal: 0 }, expectedVersion: envelope.version,
    });
    if (!reserved.reservation || reserved.reservation.status !== "reserved") {
      throw new MissionError(409, "g4_reservation_unavailable", "Synthetic contribution reservation is unavailable");
    }
    const contributions = [...state.contributions];
    contributions[index] = {
      ...slot,
      dispatchState: "requested",
      dispatchReservationId: reservationId,
      dispatchRunId: runId,
    };
    const next: MissionAggregate = {
      ...mission.aggregate,
      n1: { ...state, contributions },
      journal: [...mission.aggregate.journal, {
        action: "fixture_contribution_run_bound_without_wakeup", contributionId, reservationId, runId,
        actorUserId: input.actorUserId, at: new Date().toISOString(),
      }],
    };
    return commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
  }
  if (input.body.command === "start-lead") {
    if (mission.aggregate.n6) await (await import("./n6-guards.js")).assertN6LaunchReady(ctx, mission, input.body);
    const fixtureRuntime = await isOwnedFixtureRuntime(ctx, mission.companyId);
    const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, mission.companyId);
    if (!fixtureRuntime && !nativeProfile) {
      throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
    }
    const commandId = uuid(input.body.commandId, "commandId");
    const replay = receipt(mission, commandId, input.actorUserId!, canonicalPayloadHash(input.body));
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    let state = n1State(mission);
    if (!state || mission.aggregate.control.status !== "active" || state.rootDispatchState) {
      throw new MissionError(409, "root_dispatch_unavailable", "Root dispatch is unavailable or already claimed");
    }
    assertN1DepartureWindow(mission);
    const coordination = state.coordination;
    const reuseCoordinator = Boolean(coordination && state.resume);
    if (reuseCoordinator) {
      requireFreshCommand(mission, input.body);
      if (coordination!.state !== "confirmed" || coordination!.issueId !== state.resume!.lead.issueId
          || coordination!.ownerUserId !== input.actorUserId || state.resume!.contributions.length) {
        throw new MissionError(409, "hierarchy_coordinator_command", "Resume only the exact confirmed coordinator from the owner grant");
      }
    } else if (coordination) {
      if (coordination.commandHash !== canonicalPayloadHash(input.body) || coordination.commandId !== commandId
          || coordination.ownerUserId !== input.actorUserId || coordination.preparedVersion !== mission.version) {
        throw new MissionError(409, "hierarchy_coordinator_command", "Resume only the exact original coordinator command at its recorded version");
      }
    } else requireFreshCommand(mission, input.body);
    let admission = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
    if (state.resume && admission) {
      requireFreshCommand(mission, input.body);
      if (!nativeProfile) throw new MissionError(409, "g4_measurement_unqualified", "Resume requires native per-run accounting");
      const reserved = await reserveAdmission(ctx, {
        companyId: mission.companyId, periodKey: state.periodKey, missionId: mission.missionId,
        reservationId: state.activationReservationId, effectId: state.resume.commandId,
        requestedUnits: nativeProfile!.runReservationUnits, attempt: { kind: "resume", ordinal: n1ResumeOrdinal(state) },
        ownerReplacementCommandId: state.resume.commandId, expectedVersion: admission.version,
      });
      admission = reserved.envelope;
    }
    const activationReservationId = state.activationReservationId;
    const reservation = admission?.reservations.find((item) => item.reservationId === activationReservationId);
    if (!reservation || reservation.missionId !== mission.missionId || reservation.status !== "reserved"
        || Date.now() < Date.parse(admission!.periodStart) || Date.now() >= Date.parse(admission!.periodEnd)) {
      throw new MissionError(409, "g4_reservation_unavailable", "Root launch requires its durable unsettled reservation");
    }
    await assertProjectDeparture(ctx, mission);
    if (!reuseCoordinator) mission = await prepareHierarchyCoordinator(ctx, mission, input.body, async (before, coordination) =>
      cas(ctx, before, { ...before.aggregate, n1: { ...n1State(before)!, coordination } }, before.version));
    state = n1State(mission)!;
    const launchState = state;
    const leadIssue = leadIssueId(mission);
    let rootUsageBaselineUnits: number | undefined;
    if (nativeProfile) {
      assertNativeEnvelope(admission!, nativeProfile);
      rootUsageBaselineUnits = await assertNativeLaunchAllowed(ctx, {
        companyId: mission.companyId,
        issueId: leadIssue,
        ...(state.resume ? { priorRunIds: priorLeadRunIds(state) } : {}),
      });
    }
    const root = await ctx.issues.get(leadIssue, mission.companyId);
    const leadAgentId = mission.aggregate.responsibilities.integrationLeadAgentId;
    const leadAgent = await ctx.agents.get(leadAgentId, mission.companyId);
    if (!root || root.companyId !== mission.companyId || root.projectId !== mission.projectId
        || root.assigneeAgentId !== physicalAgent(mission, leadAgentId, { issueId: leadIssue }) || !["backlog", "todo", ...(mission.aggregate.n6 || state.resume ? ["blocked"] : [])].includes(root.status)
        || !leadAgent || leadAgent.companyId !== mission.companyId
        || !["active", "idle", "running"].includes(leadAgent.status)) {
      throw new MissionError(409, "root_dispatch_ineligible", "Root issue or lead is no longer eligible");
    }
    if (nativeProfile && !isNativeCliAgent(leadAgent)) {
      throw new MissionError(409, "native_agent_adapter_required",
        "Native N1 dispatch requires a codex_local agent configured with the cli engine");
    }
    const prepared = await prepareVariantLaunch(ctx, mission, { taskKey: mission.rootIssueId, interventionKey: "lead",
      launchKey: state.activationReservationId, logicalAgentId: leadAgentId, family: "orchestration", issueId: leadIssue, expectedRoles: ["lead"] });
    mission = await bindVariantIssue(ctx, prepared.mission, state.activationReservationId, leadIssue);
    const claim = await claimVariantWake(ctx, mission, launchState.activationReservationId, async (readyMission, claimedAggregate) => {
      const readyState = n1State(readyMission);
      if (!readyState) throw new Error("N1 state disappeared before root dispatch claim");
      const next: MissionAggregate = {
        ...claimedAggregate,
        n1: { ...readyState, rootDispatchState: "claimed", rootUsageBaselineUnits },
        effectIntents: [...claimedAggregate.effectIntents, {
          kind: "root_wakeup", state: "claimed", reservationId: launchState.activationReservationId,
          issueId: leadIssueId(readyMission), assigneeAgentId: leadAgentId,
        }],
        journal: [...claimedAggregate.journal, {
          action: "root_dispatch_claimed", reservationId: launchState.activationReservationId,
          actorUserId: input.actorUserId, at: new Date().toISOString(),
        }],
      };
      return commandCas(ctx, readyMission, input.body, "user", input.actorUserId!, next, readyMission.version);
    });
    if (claim.outcome !== "applied") return claim;
    let wake: { queued: boolean; runId: string | null } | null = null;
    try {
      if (root.status === "backlog" || root.status === "blocked" && (mission.aggregate.n6 || launchState.resume)) {
        await ctx.issues.update(leadIssue, { status: "todo" }, mission.companyId, { actorUserId: input.actorUserId! });
      }
      wake = await ctx.issues.requestWakeup(leadIssue, mission.companyId, {
        idempotencyKey: "council:n1:" + launchState.activationReservationId,
        reason: "council_integration_lead_dispatch",
        actorUserId: input.actorUserId!,
      });
    } catch {
      // A lost response cannot authorize a second wakeup.
    }
    let afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
    if (!afterClaim) throw new Error("Mission disappeared after root dispatch effect");
    const finalMission = await recordVariantWake(ctx, afterClaim, launchState.activationReservationId, wake?.runId ?? null,
      async (before, aggregate, effectiveRunId) => {
        const afterState = n1State({ ...before, aggregate });
        if (!afterState) throw new Error("N1 state disappeared after root dispatch effect");
        const priorLaunch = before.aggregate.modelSelection && before.aggregate.modelSelection.tasks
          .flatMap(task => task.launches).find(item => item.launchKey === launchState.activationReservationId);
        const confirmed = Boolean(effectiveRunId && (wake?.queued || priorLaunch?.state === "bound" && priorLaunch.runId === effectiveRunId));
        return cas(ctx, before, {
          ...aggregate,
          n1: { ...afterState, rootDispatchState: confirmed ? "requested" : "unknown", rootDispatchRunId: effectiveRunId, rootDispatchMode: "native" },
          effectIntents: aggregate.effectIntents.map((entry) =>
            entry.kind === "root_wakeup" && entry.reservationId === launchState.activationReservationId
              ? { ...entry, state: confirmed ? "requested" : "unknown", queued: wake?.queued ?? null, runId: effectiveRunId }
              : entry),
        }, before.version);
      });
    const confirmed = n1State(finalMission)?.rootDispatchState === "requested";
    return { outcome: confirmed ? "requested" as const : "unknown" as const, mission: finalMission, receipt: claim.receipt };
  }
  if (input.body.command === "reconcile-lead-usage") {
    const commandId = uuid(input.body.commandId, "commandId");
    const payloadHash = canonicalPayloadHash(input.body);
    const replay = receipt(mission, commandId, input.actorUserId!, payloadHash);
    if (replay) return { outcome: "replayed" as const, mission, receipt: replay };
    const requestedVersion = integer(input.body.expectedVersion, "expectedVersion");
    const recoveringSettledCommand = mission.version !== requestedVersion;
    if (!recoveringSettledCommand) requireFreshCommand(mission, input.body);
    const state = n1State(mission);
    if (!state?.rootDispatchRunId || state.rootDispatchState !== "requested" || state.rootDispatchMode !== "native"
        || !Number.isSafeInteger(state.rootUsageBaselineUnits) || state.rootUsageBaselineUnits! < 0) {
      throw new MissionError(409, "root_dispatch_unavailable", "A confirmed native lead run is required for usage reconciliation");
    }
    if (state.candidate && (mission.aggregate.phase !== "integrating" || mission.aggregate.control.status !== "active")) {
      throw new MissionError(409, "candidate_not_integrating", "Only an active integrating candidate can become review-ready");
    }
    const profile = await readNativeG4Profile(ctx, mission.companyId);
    if (!profile) throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
    const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
    if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
    assertNativeEnvelope(envelope, profile);
    if (recoveringSettledCommand) {
      const settlementAlreadyRecorded = envelope.reservations
        .find((item) => item.reservationId === state.activationReservationId)
        ?.settlementReceipts?.some((item) => item.commandId === commandId);
      if (mission.version !== requestedVersion + 1
          || !state.candidate
          || state.candidateRecordedVersion !== requestedVersion
          || !settlementAlreadyRecorded) {
        throw new MissionError(409, "version_conflict", "Mission changed incompatibly with lead usage settlement recovery", {
          currentVersion: mission.version,
        });
      }
    }
    const settlement = state.resume
      ? await settleOrdinaryRunUsage(ctx, { commandId, companyId: mission.companyId,
        issueId: leadIssueId(mission), runId: state.rootDispatchRunId,
        agentId: physicalAgent(mission, mission.aggregate.responsibilities.integrationLeadAgentId, { issueId: leadIssueId(mission), runId: state.rootDispatchRunId }),
        periodKey: state.periodKey, reservationId: state.activationReservationId, expectedVersion: envelope.version })
      : await settleNativeRunUsage(ctx, {
      commandId,
      companyId: mission.companyId,
      issueId: leadIssueId(mission),
      runId: state.rootDispatchRunId,
      baselineUsageUnits: state.rootUsageBaselineUnits!,
      periodKey: state.periodKey,
      reservationId: state.activationReservationId,
      expectedVersion: envelope.version,
    });
    if (recoveringSettledCommand && settlement.outcome !== "replayed") {
      throw new MissionError(409, "version_conflict", "Lead usage settlement recovery requires an exact admission replay", {
        currentVersion: mission.version,
      });
    }
    if (!state.candidate || state.integration) return { ...settlement, mission: await observeVariantRun(ctx, mission, state.activationReservationId) };
    const next: MissionAggregate = {
      ...mission.aggregate,
      phase: "ready_for_review",
      control: { status: "inactive", reason: "candidate_ready_for_review" },
      journal: [...mission.aggregate.journal, {
        action: "lead_usage_settled_candidate_ready",
        actorUserId: input.actorUserId,
        runId: state.rootDispatchRunId,
        candidate: state.candidate.candidate,
        at: new Date().toISOString(),
      }],
    };
    const promotion = recoveringSettledCommand
      ? await recoveredCommandCas(ctx, mission, input.body, "user", input.actorUserId!, next)
      : await commandCas(ctx, mission, input.body, "user", input.actorUserId!, next);
    return { ...settlement, mission: await observeVariantRun(ctx, promotion.mission, state.activationReservationId), missionReceipt: promotion.receipt };
  }
  if (input.body.command !== "activate") throw new MissionError(400, "unknown_command", "Unsupported N1 board command");
  const commandId = uuid(input.body.commandId, "commandId");
  const hash = canonicalPayloadHash(input.body);
  const prior = receipt(mission, commandId, input.actorUserId!, hash);
  if (prior) return { outcome: "replayed" as const, mission, receipt: prior };
  await assertProjectDeparture(ctx, mission);
  await assertLinearAdmissionFresh(ctx, mission, input.body);
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
  if (eligibleTeam.length < (mission.aggregate.hierarchy ? 1 : 2)) {
    throw new MissionError(422, "two_contributors_required", "Pinned team needs two contributors in addition to the lead");
  }
  if (mission.aggregate.n6) await (await import("./n6-guards.js")).assertN6LaunchReady(ctx, mission, input.body);
  const root = await ctx.issues.get(mission.rootIssueId, mission.companyId);
  const rootLeaf = mission.aggregate.projectMandate?.completion?.result === "integrated-verified" ? mission.aggregate.hierarchy?.leaves?.find(l => l.issueId === mission.rootIssueId) : undefined;
  if (!root || root.companyId !== mission.companyId || root.projectId !== mission.projectId
      || root.assigneeAgentId !== (rootLeaf?.assigneeAgentId ?? mission.aggregate.responsibilities.integrationLeadAgentId)
      || !["backlog", "todo", ...(mission.aggregate.n6 || mission.aggregate.hierarchy?.leaves ? ["blocked"] : [])].includes(root.status)) {
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
  }, () => assertLinearAdmissionFresh(ctx, mission, input.body));
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
  await assertLinearAdmissionFresh(ctx, mission, input.body);
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
  beforeReserve: () => Promise<void>,
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
  await beforeReserve();
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

function isNativeCliAgent(agent: unknown): boolean {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
  const record = agent as Record<string, unknown>;
  const adapterConfig = record.adapterConfig;
  return record.adapterType === "codex_local"
    && Boolean(adapterConfig)
    && typeof adapterConfig === "object"
    && !Array.isArray(adapterConfig)
    && (adapterConfig as Record<string, unknown>).engine === "cli";
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

type N1DispatchActor = { type: "agent" | "user"; id: string; native: { actorAgentId: string; actorRunId: string } | { actorUserId: string } };

function integrationPaths(mission: MissionRecord, body: Record<string, unknown>) {
  if (body.integrationAdjustedPaths === undefined) return undefined;
  if (!(mission.aggregate.n1 as N1State).integration || !Array.isArray(body.integrationAdjustedPaths)) {
    throw new MissionError(422, "integration_paths_unavailable", "Only the admitted final integration stage declares its bounded shared-file changes");
  }
  const paths = body.integrationAdjustedPaths.map(path => boundedString(path, "integrationAdjustedPath", 512));
  assertProjectPaths(mission, paths);
  const childPaths = (mission.aggregate.n1 as N1State).contributions.flatMap(slot => slot.ownedPaths);
  if (paths.some(path => childPaths.some(owned => ownershipsOverlap(path, owned)))) {
    throw new MissionError(422, "integration_child_ownership", "Shared integration changes cannot replace the attributed child contributions");
  }
  return paths.length ? paths : undefined;
}

/** The owner delegates the already pinned plan, never the identity of a terminal agent. */
export async function dispatchHierarchyContribution(ctx: PluginContext, mission: MissionRecord, body: Record<string, unknown>) {
  const state = n1State(mission)!;
  const policy = mission.aggregate.continuity;
  await owner(ctx, mission, policy?.authorizedBy ?? null);
  assertContinuityDeparture(mission);
  if (!mission.aggregate.hierarchy?.leaves || !completionPolicy(mission) || !state?.coordination
      || state.rootDispatchState !== "requested" || !state.rootDispatchRunId || state.candidate || state.integration
      || mission.aggregate.phase !== "executing" || mission.aggregate.control.status !== "active") {
    throw new MissionError(409, "hierarchy_progression_unavailable", "Delegated dispatch requires the completed planner and its unchanged materialized hierarchy");
  }
  const run = await readOrdinaryRun(ctx, { companyId: mission.companyId, issueId: leadIssueId(mission), runId: state.rootDispatchRunId,
    agentId: physicalAgent(mission, mission.aggregate.responsibilities.integrationLeadAgentId, { issueId: leadIssueId(mission), runId: state.rootDispatchRunId }) });
  const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
  const reservation = envelope?.reservations.find(r => r.reservationId === state.activationReservationId);
  if (run.status !== "succeeded" || !reservation || !settledResumeReservation(reservation)) {
    throw new MissionError(409, "hierarchy_planner_unsettled", "Successful planning and exact terminal usage must precede delegated dispatch");
  }
  const prior = receipt(mission, uuid(body.commandId, "commandId"), policy!.authorizedBy, canonicalPayloadHash(body));
  if (prior) return { status: 200, body: { outcome: "replayed", mission, receipt: prior } };
  return dispatchN1Contribution(ctx, mission, body, { type: "user", id: policy!.authorizedBy, native: { actorUserId: policy!.authorizedBy } });
}

async function assertPriorContributions(ctx: PluginContext, mission: MissionRecord, slots: Slot[]) {
  for (const prior of slots) {
    if (completionPolicy(mission) && !prior.proof?.closedAt) throw new MissionError(409, "prior_contribution_proof", "Observe the previous child verified proof and terminal closure before dispatch");
    const priorIssue = prior.childIssueId ? await ctx.issues.get(prior.childIssueId, mission.companyId) : null;
    const attributed = [prior.commit, prior.authorRunId, prior.dispatchState === "requested", prior.dispatchReservationId,
      prior.dispatchRunId, prior.authorRunId === prior.dispatchRunId].every(Boolean);
    const expected = { companyId: mission.companyId, projectId: mission.projectId, parentId: prior.parentIssueId !== undefined ? prior.parentIssueId : mission.rootIssueId,
      assigneeAgentId: physicalAgent(mission, prior.assigneeAgentId, { issueId: prior.childIssueId }), status: "done" };
    if (!attributed || !priorIssue || Object.entries(expected).some(([key, value]) => priorIssue[key as keyof typeof priorIssue] !== value)) {
      throw new MissionError(409, "prior_contribution_incomplete", "Every earlier contribution must be attributed to its confirmed native run and its mapped child issue must be done");
    }
  }
}

async function childNativeBaseline(ctx: PluginContext, mission: MissionRecord, state: N1State, slot: Slot,
  agent: NonNullable<Awaited<ReturnType<PluginContext["agents"]["get"]>>>, requestedUnits: number, resumed?: ResumeTarget) {
  const envelope = await readAdmission(ctx, { companyId: mission.companyId, periodKey: state.periodKey });
  if (!envelope) throw new MissionError(422, "g4_not_configured", "No task/period admission envelope is configured");
  const fixtureRuntime = await isOwnedFixtureRuntime(ctx, mission.companyId);
  const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, mission.companyId);
  let dispatchUsageBaselineUnits: number | undefined;
  if (!fixtureRuntime && !nativeProfile) {
    throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
  }
  if (nativeProfile) {
    if (!isNativeCliAgent(agent)) {
      throw new MissionError(409, "native_agent_adapter_required",
        "Native N1 dispatch requires a codex_local agent configured with the cli engine");
    }
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
    dispatchUsageBaselineUnits = await assertNativeLaunchAllowed(ctx, {
      companyId: mission.companyId,
      issueId: slot.childIssueId!,
      priorRunId: resumed?.priorRunId,
    });
  }
  return { envelope, dispatchUsageBaselineUnits };
}

async function eligibleDispatchAgent(ctx: PluginContext, mission: MissionRecord, slot: Slot, resumed?: ResumeTarget) {
  const issue = await ctx.issues.get(slot.childIssueId!, mission.companyId);
  const agent = await ctx.agents.get(slot.assigneeAgentId, mission.companyId);
  if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
      || issue.parentId !== (slot.parentIssueId !== undefined ? slot.parentIssueId : mission.rootIssueId) || issue.assigneeAgentId !== physicalAgent(mission, slot.assigneeAgentId, { issueId: slot.childIssueId })
      || !["backlog", ...(resumed || slot.parentIssueId ? ["blocked"] : [])].includes(issue.status) || !agent || agent.companyId !== mission.companyId
      || !["active", "idle", "running"].includes(agent.status)) {
    throw new MissionError(409, "native_dispatch_ineligible", "Native child or assignee is no longer eligible for dispatch");
  }
  return agent;
}

async function wakeDispatchedChild(ctx: PluginContext, mission: MissionRecord,
  input: { slot: Slot; reservationId: string; contributionId: string; actor: N1DispatchActor }) {
  const { slot, reservationId, contributionId, actor } = input;
  let wake: { queued: boolean; runId: string | null } | null = null;
  try {
    await ctx.issues.update(slot.childIssueId!, { status: "todo" }, mission.companyId, {
      ...actor.native,
    });
    wake = await ctx.issues.requestWakeup(slot.childIssueId!, mission.companyId, {
      idempotencyKey: "council:n1:" + reservationId,
      reason: "council_contribution_dispatch",
      ...actor.native,
    });
  } catch {
    // Native state may have changed even when the response was lost.
  }
  let afterClaim = await getMission(ctx, mission.companyId, mission.missionId);
  if (!afterClaim) throw new Error("Mission disappeared after dispatch effect");
  const finalMission = await recordVariantWake(ctx, afterClaim, reservationId, wake?.runId ?? null,
    async (before, aggregate, effectiveRunId) => {
      const afterState = n1State({ ...before, aggregate });
      if (!afterState) throw new Error("N1 state disappeared after dispatch effect");
      const priorLaunch = before.aggregate.modelSelection && before.aggregate.modelSelection.tasks
        .flatMap(task => task.launches).find(item => item.launchKey === reservationId);
      const wakeConfirmed = Boolean(effectiveRunId && (wake?.queued || priorLaunch?.state === "bound" && priorLaunch.runId === effectiveRunId));
      const updatedSlots = afterState.contributions.map((entry) => entry.contributionId === contributionId
        ? { ...entry, dispatchState: wakeConfirmed ? "requested" as const : "unknown" as const, dispatchRunId: effectiveRunId }
        : entry);
      return cas(ctx, before, {
        ...aggregate,
        n1: { ...afterState, contributions: updatedSlots },
        effectIntents: aggregate.effectIntents.map((entry) => entry.kind === "child_wakeup" && entry.reservationId === reservationId
          ? { ...entry, state: wakeConfirmed ? "requested" : "unknown", queued: wake?.queued ?? null, runId: effectiveRunId }
          : entry),
      }, before.version);
    });
  const finalSlot = n1State(finalMission)?.contributions.find(entry => entry.contributionId === contributionId);
  const wakeConfirmed = finalSlot?.dispatchState === "requested";
  return { status: wakeConfirmed ? 200 : 202, body: { outcome: wakeConfirmed ? "requested" : "unknown", wake, mission: finalMission } };
}

function childReservationIdentity(state: N1State, body: Record<string, unknown>, contributionId: string, resumed?: ResumeTarget) {
  const reservationId = uuid(body.reservationId, "reservationId");
  const requestedUnits = integer(body.requestedUnits, "requestedUnits");
  const preparedChild = state.resume?.preparedContributions?.find(target => target.contributionId === contributionId);
  if (preparedChild && reservationId !== preparedChild.reservationId) {
    throw new MissionError(409, "n1_prepared_reservation_mismatch", "Reuse the exact prepared child reservation from inspect.n1.resume.preparedContributions");
  }
  if (resumed && reservationId !== resumed.reservationId) {
    throw new MissionError(409, "n1_resume_reservation_mismatch", "Use the exact owner-authorized resume reservation from inspect.n1.resume");
  }
  return { reservationId, requestedUnits };
}

async function dispatchN1Contribution(ctx: PluginContext, initial: MissionRecord, body: Record<string, unknown>, actor: N1DispatchActor) {
  let mission = initial;
  const state = n1State(mission)!;
  assertN1DepartureWindow(mission);
  const contributionId = uuid(body.contributionId, "contributionId");
  const index = state.contributions.findIndex((slot) => slot.contributionId === contributionId);
  if (index < 0) throw new MissionError(404, "contribution_not_found", "Contribution slot not found");
  const slot = state.contributions[index];
  const resumed = state.resume?.contributions.find(t => t.contributionId === contributionId);
  if (slot.issueState !== "confirmed" || !slot.childIssueId || slot.dispatchState) {
    throw new MissionError(409, "dispatch_unavailable", "Child issue is not confirmed or dispatch was already claimed");
  }
  const agent = await eligibleDispatchAgent(ctx, mission, slot, resumed);
  await assertPriorContributions(ctx, mission, state.contributions.slice(0, index));
  await assertHierarchySources(ctx, mission);
  await assertHierarchyDependencies(ctx, mission, slot.childIssueId!);
  await ensureHierarchyLaunchGuidance(ctx, mission, slot.childIssueId!);
  const { reservationId, requestedUnits } = childReservationIdentity(state, body, contributionId, resumed);
  requireFreshCommand(mission, body);
  const { envelope, dispatchUsageBaselineUnits } = await childNativeBaseline(ctx, mission, state, slot, agent, requestedUnits, resumed);
  const prepared = await prepareVariantLaunch(ctx, mission, { taskKey: contributionId, interventionKey: contributionId,
    launchKey: reservationId, logicalAgentId: slot.assigneeAgentId, family: await contributionModelFamily(ctx, mission, slot.assigneeAgentId), issueId: slot.childIssueId, expectedRoles: ["executor", "contributor-1", "contributor-2", "test", "design"] });
  mission = prepared.mission;
  const reserved = await reserveAdmission(ctx, {
    companyId: mission.companyId, periodKey: state.periodKey,
    reservationId, missionId: mission.missionId, effectId: contributionId,
    requestedUnits, attempt: resumed ? { kind: "resume", ordinal: 1 } : { kind: "initial", ordinal: 0 },
    ...(resumed ? { ownerReplacementCommandId: state.resume!.commandId } : {}), expectedVersion: envelope.version,
  });
  if (!reserved.reservation || reserved.reservation.status !== "reserved") {
    throw new MissionError(409, "g4_reservation_unavailable", "Durable child reservation is unavailable");
  }
  mission = await bindVariantIssue(ctx, mission, reservationId, slot.childIssueId!);
  const claim = await claimVariantWake(ctx, mission, reservationId, async (readyMission, claimedAggregate) => {
    const readyState = n1State(readyMission);
    if (!readyState) throw new Error("N1 state disappeared before child dispatch claim");
    const slots = [...readyState.contributions];
    slots[index] = {
      ...slots[index]!,
      dispatchState: "claimed",
      dispatchReservationId: reservationId,
      dispatchUsageBaselineUnits,
    };
    const next: MissionAggregate = {
      ...claimedAggregate,
      n1: { ...readyState, contributions: slots },
      effectIntents: [...claimedAggregate.effectIntents, {
        kind: "child_wakeup", state: "claimed", reservationId, contributionId,
        issueId: slot.childIssueId, assigneeAgentId: slot.assigneeAgentId,
        ...actor.native,
      }],
      journal: [...claimedAggregate.journal, {
        action: "child_dispatch_claimed", contributionId, reservationId,
        ...actor.native, at: new Date().toISOString(),
      }],
    };
    return commandCas(ctx, readyMission, body, actor.type, actor.id, next, readyMission.version);
  });
  if (claim.outcome !== "applied") return { status: 200, body: claim };
  return wakeDispatchedChild(ctx, mission, { slot, reservationId, contributionId, actor });
}

export async function handleN1AgentApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    if (input.actor.actorType !== "agent" || !input.actor.agentId || !input.actor.runId) {
      throw new MissionError(403, "agent_run_required", "Authenticated agent run required");
    }
    const body = bodyRecord(input.body);
    const missionId = uuid(body.missionId, "missionId");
    let mission = await getMission(ctx, input.companyId, missionId);
    if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
    const state = n1State(mission);
    if (!state || mission.aggregate.control.status !== "active") {
      throw new MissionError(409, "mission_inactive", "Mission is not active");
    }
    if (input.params.issueId !== n1LeadExecution(mission).issueId
        && !state.contributions.some((slot) => slot.childIssueId === input.params.issueId)) {
      throw new MissionError(404, "mission_issue_not_found", "This issue is not mapped to the mission");
    }
    if (body.command === "inspect") {
      if (input.params.issueId === n1LeadExecution(mission).issueId) {
        await lead(ctx, mission, input);
      } else {
        const slot = state.contributions.find((entry) => entry.childIssueId === input.params.issueId);
        if (!slot || !input.actor.agentId || !input.actor.runId || !isLogicalActor(mission, slot.assigneeAgentId, input.actor.agentId, input.actor.runId)) {
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
        body: { missionId: mission.missionId, version: mission.version, phase: mission.aggregate.phase, n1: inspectN1State(mission),
          ...(mission.aggregate.n6 ? { n6Handoff: await (await import("./n6-guards.js")).readN6Handoff(ctx, mission) } : {}) },
      };
    }
    const commandId = uuid(body.commandId, "commandId");
    const hash = canonicalPayloadHash(body);
    const prior = receipt(mission, commandId, input.actor.agentId, hash);
    if (prior) {
      mission = await finishN1Disposition(ctx, mission, input, body, (current, aggregate) => cas(ctx, current, aggregate, current.version));
      return { status: 200, body: { outcome: "replayed", mission, receipt: prior } };
    }
    if (body.command === "plan") {
      const actor = await lead(ctx, mission, input);
      if (state.contributions.length !== 0) throw new MissionError(409, "plan_exists", "Contribution plan already exists");
      await assertHierarchySources(ctx, mission);
      const sourceBaseCommit = sourceBase(mission, body.sourceBaseCommit);
      const slots = readSlotPlan(body.contributions, mission);
      for (const slot of slots) {
        const agent = await ctx.agents.get(slot.assigneeAgentId, mission.companyId);
        if (!agent || agent.companyId !== mission.companyId || !["active", "idle", "running"].includes(agent.status)) {
          throw new MissionError(422, "agent_ineligible", "Contributor is no longer eligible");
        }
      }
      const next: MissionAggregate = {
        ...mission.aggregate,
        n1: { ...state, contributions: slots, ...(sourceBaseCommit ? { sourceBaseCommit } : {}) },
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
      if (mission.aggregate.hierarchy?.leaves && slot.childIssueId) {
        requireFreshCommand(mission, body);
        await assertHierarchySources(ctx, mission);
        await materializeHierarchyGuidance(ctx, mission, slot.childIssueId, contributionDescription({ missionId: mission.missionId,
          contributionId, ownedPaths: slot.ownedPaths, closeThroughCouncil: true, context: mission.aggregate.mandate.objective }));
        const contributions = state.contributions.map(item => item.contributionId === contributionId ? { ...item, issueState: "confirmed" as const } : item);
        const result = await commandCas(ctx, mission, body, "agent", actor.agentId, { ...mission.aggregate, n1: { ...state, contributions } });
        return { status: 200, body: result };
      }
      const intentId = randomUUID();
      const intent: ContributionIssueIntent = {
        state: "creation_claimed", intentId, companyId: mission.companyId,
        projectId: mission.projectId, rootIssueId: mission.rootIssueId,
        missionId: mission.missionId, contributionId, assigneeAgentId: slot.assigneeAgentId,
        title: slot.title,
        description: contributionDescription({
          missionId: mission.missionId,
          closeThroughCouncil: Boolean(mission.aggregate.nativeWakePolicy),
          contributionId,
          ownedPaths: slot.ownedPaths,
          context: await readContributionContext(ctx, mission).catch(() => {
            throw new MissionError(409, "contribution_context_unavailable",
              "Native plan read failed; no child was created. Read the parent plan before materializing again.");
          }),
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
      const claim = await commandCas(ctx, mission, body, "agent", actor.agentId, next, mission.version);
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
      return await dispatchN1Contribution(ctx, mission, body, { type: "agent", id: actor.agentId,
        native: { actorAgentId: actor.agentId, actorRunId: actor.runId } });
    }
    if (body.command === "reconcile-usage") {
      await lead(ctx, mission, input);
      const result = await reconcileContributionUsage(ctx, mission, {
        commandId,
        contributionId: uuid(body.contributionId, "contributionId"),
      });
      const contribution = state.contributions.find(slot => slot.contributionId === body.contributionId)!;
      mission = await observeVariantRun(ctx, mission, contribution.dispatchReservationId!);
      mission = await closeQualifiedContribution(ctx, mission, contribution.contributionId, (current, aggregate) => cas(ctx, current, aggregate, current.version));
      return { status: 200, body: { ...result, mission } };
    }
    if (body.command === "record-contribution") {
      const contributionId = uuid(body.contributionId, "contributionId");
      const slot = state.contributions.find((entry) => entry.contributionId === contributionId);
      if (!slot || !slot.childIssueId) throw new MissionError(404, "child_issue_not_found", "Contribution child issue is not confirmed");
      if (!input.actor.agentId || !input.actor.runId || !isLogicalActor(mission, slot.assigneeAgentId, input.actor.agentId, input.actor.runId) || input.params.issueId !== slot.childIssueId) {
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
          || issue.parentId !== (slot.parentIssueId !== undefined ? slot.parentIssueId : mission.rootIssueId) || issue.assigneeAgentId !== physicalAgent(mission, slot.assigneeAgentId, { issueId: slot.childIssueId })
          || issue.status !== "in_progress") {
        throw new MissionError(409, "child_ownership_changed", "Child issue is not in progress under the assigned contributor");
      }
      await ctx.issues.assertCheckoutOwner({
        issueId: slot.childIssueId, companyId: mission.companyId,
        actorAgentId: input.actor.agentId, actorRunId: input.actor.runId,
      });
      const commit = boundedString(body.commit, "commit", 40);
      if (!COMMIT.test(commit)) throw new MissionError(422, "invalid_commit", "Contribution commit must be a Git SHA-1");
      const proof = await recordContributionProof(ctx, mission, contributionId, commit, body.proof);
      const slots = state.contributions.map((entry) => entry.contributionId === contributionId
        ? { ...entry, commit, authorRunId: input.actor.runId!, ...(proof ? { proof } : {}) } : entry);
      const next: MissionAggregate = {
        ...mission.aggregate, n1: { ...state, contributions: slots },
        journal: [...mission.aggregate.journal, { action: "contribution_recorded", contributionId, commit, actorAgentId: input.actor.agentId, runId: input.actor.runId, at: new Date().toISOString() }],
      };
      const result = await commandCas(ctx, mission, body, "agent", input.actor.agentId, next);
      result.mission = await finishN1Disposition(ctx, result.mission, input, body, (current, aggregate) => cas(ctx, current, aggregate, current.version));
      return { status: 200, body: result };
    }
    if (body.command === "publish") {
      const actor = await lead(ctx, mission, input);
      requireFreshCommand(mission, body);
      if (state.candidate) throw new MissionError(409, "candidate_exists", "Integrated candidate already published");
      if (!contributionCountAllowed(mission, state.contributions.length) || state.contributions.some((slot) =>
        !slot.commit || !slot.childIssueId || !slot.authorRunId || slot.dispatchState !== "requested" || !slot.dispatchReservationId)) {
        throw new MissionError(409, "contributions_incomplete", "Two attributed contributions and native child mappings are required");
      }
      for (const slot of state.contributions) {
        const issue = await ctx.issues.get(slot.childIssueId!, mission.companyId);
        if (!issue || issue.companyId !== mission.companyId || issue.projectId !== mission.projectId
            || issue.parentId !== (slot.parentIssueId !== undefined ? slot.parentIssueId : mission.rootIssueId) || issue.assigneeAgentId !== physicalAgent(mission, slot.assigneeAgentId, { issueId: slot.childIssueId })
            || issue.status !== contributionStatusBeforeIntegration(mission)) {
          throw new MissionError(409, "child_not_done", "Both mapped native child issues must be done before integration");
        }
      }
      const fixtureRuntime = await isOwnedFixtureRuntime(ctx, mission.companyId);
      const nativeProfile = fixtureRuntime ? null : await readNativeG4Profile(ctx, mission.companyId);
      if (!fixtureRuntime && !nativeProfile) {
        throw new MissionError(409, "g4_measurement_unqualified", "No supported native N1 operating profile is configured");
      }
      if (nativeProfile) {
        if (state.rootDispatchMode !== "native" || !state.rootDispatchRunId
            || !Number.isSafeInteger(state.rootUsageBaselineUnits) || state.rootUsageBaselineUnits! < 0
            || state.contributions.some((slot) => !slot.dispatchRunId
              || !Number.isSafeInteger(slot.dispatchUsageBaselineUnits) || slot.dispatchUsageBaselineUnits! < 0)) {
          throw new MissionError(409, "g4_measurement_unqualified",
            "Native candidate publication requires pre-wakeup usage baselines for the lead and both contribution runs");
        }
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
      const integrationAdjustedPaths = integrationPaths(mission, body);
      if (!COMMIT.test(baseCommit) || !COMMIT.test(candidateCommit) || !DIGEST.test(expectedSha256)) {
        throw new MissionError(422, "invalid_candidate_identity", "Candidate Git and digest identity is malformed");
      }
      if (completionPolicy(mission) && (state.sourceBaseCommit !== baseCommit || state.contributions.some(s => !(s.proof?.closedAt || completionPolicy(mission)?.result === "integrated-verified" && s.proof?.readyAt)))) {
        throw new MissionError(409, "contribution_proof_pending", "All closed child proofs and the original source base must bind integration");
      }
      let verified: IntegratedCandidateVerification;
      try {
        verified = await verifyIntegratedCandidate(ctx, {
          companyId: mission.companyId, issueId: mission.rootIssueId,
          attachmentId, baseCommit, candidateCommit, expectedSha256,
          attachmentIssueId: candidateAttachmentTarget(mission, n1LeadExecution(mission).issueId),
          integrationAdjustedPaths,
          contributions: state.contributions.map(slot => ({ contributionId: slot.contributionId, commit: slot.commit!, ownedPaths: slot.ownedPaths })),
          ...(mission.aggregate.hierarchy ? { contributionPolicy: mission.aggregate.hierarchy } : {}),
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
        ...mission.aggregate,
        phase: nativeProfile ? "integrating" : "ready_for_review",
        control: nativeProfile ? mission.aggregate.control : { status: "inactive", reason: "candidate_ready_for_review" },
        n1: {
          ...state,
          candidate: verified,
          candidateRecordedVersion: integer(body.expectedVersion, "expectedVersion") + 1,
          lastIntegrationFailure: undefined,
        },
        journal: [...mission.aggregate.journal, {
          action: nativeProfile ? "integrated_candidate_verified" : "integrated_candidate_published",
          actorAgentId: actor.agentId,
          runId: actor.runId,
          candidate: verified.candidate,
          checks: verified.checks,
          at: new Date().toISOString(),
        }],
      };
      const result = await commandCas(ctx, mission, body, "agent", actor.agentId, next);
      result.mission = await finishN1Disposition(ctx, result.mission, input, body, (current, aggregate) => cas(ctx, current, aggregate, current.version));
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
