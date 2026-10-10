import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getMission, type MissionRecord, type MissionReceipt } from "./missions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { n2CommandCas, runtimeReceipt } from "./n2-missions.js";
import { releaseReconciledRepository } from "./repository-occupation.js";
import type { AdmissionDocument } from "./admission.js";

const draftKeys = new Set(["schemaVersion", "missionId", "companyId", "rootIssueId", "projectId", "ownerUserId",
  "mandate", "compositions", "responsibilities", "phase", "control", "readiness", "journal", "commandReceipts",
  "effectIntents", "modelSelection", "workspacePreflight", "nativeWakePolicy", "draftAbandonment"]);
const draftCommands = new Set<MissionReceipt["command"]>(["create", "update-mandate", "abandon-unused-draft"]);
const draftActions = new Set(["mission_recorded", "mandate_updated", "unused_draft_abandoned"]);

function unavailable(): never {
  throw new MissionError(409, "unused_draft_unproven", "Only an unused, inactive draft with a complete zero-effect native inventory may be abandoned; retain its original occupation");
}

function assertDraftAggregate(m: MissionRecord) {
  const a = m.aggregate;
  const expectedControl = a.draftAbandonment ? { status: "blocked", reason: "unused_draft_abandoned" }
    : { status: "inactive", reason: "mission_not_enabled" };
  if (a.phase !== "draft" || canonicalPayloadHash(a.control) !== canonicalPayloadHash(expectedControl)
      || Object.keys(a).some(key => !draftKeys.has(key)) || !Array.isArray(a.effectIntents) || a.effectIntents.length
      || !Array.isArray(a.journal) || a.journal.some(e => !draftActions.has(String(e.action)))
      || a.commandReceipts.some(r => !draftCommands.has(r.command))) unavailable();
}

function assertNoExecutionHistory(m: MissionRecord) {
  const a = m.aggregate;
  if (a.modelSelection && (a.modelSelection.protocol !== "native-variants-v1" || !Array.isArray(a.modelSelection.tasks) || a.modelSelection.tasks.length)) unavailable();
  if (a.nativeWakePolicy && (a.nativeWakePolicy.protocol !== "council-native-wake-v2" || !Array.isArray(a.nativeWakePolicy.rootBaseline) || a.nativeWakePolicy.rootBaseline.length)) unavailable();
}

async function assertNoAdmissionHistory(ctx: PluginContext, m: MissionRecord) {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin namespace");
  const documents = await ctx.db.query<{ document: AdmissionDocument }>(
    `SELECT document FROM ${ctx.db.namespace}.admission_envelopes WHERE company_id = $1`, [m.companyId]);
  if (documents.some(({ document: d }) => !Array.isArray(d.reservations)
      || d.reservations.some(r => r.missionId === m.missionId)
      || (d.unadmittedRuns !== undefined && (!Array.isArray(d.unadmittedRuns) || d.unadmittedRuns.some(r => r.missionId === m.missionId))))) unavailable();
}

function assertWaitingRoot(m: MissionRecord, issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>) {
  if (!issue || issue.id !== m.rootIssueId || issue.companyId !== m.companyId || issue.projectId !== m.projectId
      || !["backlog", "blocked"].includes(issue.status) || issue.checkoutRunId || issue.executionRunId) unavailable();
}

function assertEmptyNativeInventory(m: MissionRecord, inventory: Awaited<ReturnType<PluginContext["issues"]["summaries"]["getOrchestration"]>>) {
  if (inventory.companyId !== m.companyId || inventory.issueId !== m.rootIssueId
      || !Array.isArray(inventory.subtreeIssueIds) || inventory.subtreeIssueIds.length !== 1 || inventory.subtreeIssueIds[0] !== m.rootIssueId
      || !Array.isArray(inventory.runs) || inventory.runs.length
      || !Array.isArray(inventory.approvals) || inventory.approvals.length
      || !inventory.costs || [inventory.costs.costCents, inventory.costs.inputTokens, inventory.costs.cachedInputTokens, inventory.costs.outputTokens].some(n => n !== 0)) unavailable();
}

/** Deliberately narrow: previously started work uses its existing cancellation protocol. */
export async function assertUnusedDraft(ctx: PluginContext, m: MissionRecord) {
  assertDraftAggregate(m);
  assertNoExecutionHistory(m);
  await assertNoAdmissionHistory(ctx, m);
  const issue = await ctx.issues.get(m.rootIssueId, m.companyId);
  const inventory = await ctx.issues.summaries.getOrchestration({ companyId: m.companyId, issueId: m.rootIssueId, includeSubtree: true });
  assertWaitingRoot(m, issue);
  assertEmptyNativeInventory(m, inventory);
}

/** Marker first, proof again, then version-fenced release. Replay completes only this original effect. */
export async function abandonUnusedDraft(ctx: PluginContext, companyId: string, missionId: string, ownerId: string,
  body: { command: "abandon-unused-draft"; commandId: string; expectedVersion: number; reason: string }) {
  const m = await getMission(ctx, companyId, missionId);
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  if (m.ownerUserId !== ownerId) throw new MissionError(403, "mission_owner_required", "Exact configured mission owner required");
  const prior = runtimeReceipt(m, body.commandId, ownerId, canonicalPayloadHash(body));
  if (prior) {
    if (m.aggregate.draftAbandonment?.commandId !== body.commandId) throw new MissionError(409, "command_identity_conflict", "Retain the original abandonment identity");
    await assertUnusedDraft(ctx, m);
    await releaseReconciledRepository(ctx, m);
    return { outcome: "replayed" as const, mission: m, receipt: prior };
  }
  if (m.aggregate.draftAbandonment) throw new MissionError(409, "mission_abandoned", "Replay the original abandonment command to reconcile its release");
  if (m.version !== body.expectedVersion) throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: m.version });
  await assertUnusedDraft(ctx, m);
  const marker = { commandId: body.commandId, actorUserId: ownerId, reason: body.reason, recordedAt: new Date().toISOString() };
  const result = await n2CommandCas(ctx, m, body, "user", ownerId, { ...m.aggregate,
    draftAbandonment: marker, control: { status: "blocked", reason: "unused_draft_abandoned" },
    journal: [...m.aggregate.journal, { action: "unused_draft_abandoned", ...marker }] });
  // The reservation CAS locks the same mission row. Any earlier concurrent reservation
  // must now be visible; a later reservation cannot cross the committed marker.
  await assertUnusedDraft(ctx, result.mission);
  await releaseReconciledRepository(ctx, result.mission);
  return result;
}
