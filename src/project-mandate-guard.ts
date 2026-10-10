import { assertDeliveryPredecessor } from "./delivery-leaves.js";
import { ensureMissionRepository } from "./repository-occupation.js";
import { assertLinearContinuityDeparture } from "./linear-continuity-control.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { operatingProfileHash } from "./project-mandate-state.js";
import { readProjectMandate } from "./project-mandate-state.js";
import { assertHierarchySources } from "./hierarchy-runtime.js";
import { campaignRoot } from "./repository-campaign.js";
import { readTaskIntake } from "./project-intake-rebind.js";
import { repositoryIntakeHeld } from "./project-intake-recovery.js";
import { assertRepositoryResumptionPlan } from "./repository-resumption-publication.js";

export async function assertProjectDeparture(ctx: PluginContext, m: MissionRecord, cancellationReservationId?: string, terminalIntent?: { intentId: string; payloadSha256: string }, requireFreshLinearSource = true) {
  const control = await campaignRoot(ctx, m);
  await assertLinearContinuityDeparture(ctx, control, cancellationReservationId, terminalIntent, requireFreshLinearSource);
  if (control.aggregate.projectMandate) {
    const intake = await readTaskIntake(ctx, control.companyId, control.projectId, control.rootIssueId);
    if (intake?.mission_id === control.missionId && repositoryIntakeHeld(intake.state)) {
      throw new MissionError(409, "repository_intake_held", "The owner must explicitly resume the original occupied intake before a new departure");
    }
    if (intake?.mission_id === control.missionId) assertRepositoryResumptionPlan(control, intake.state);
  }
  await ensureMissionRepository(ctx, control);
  const pinned = m.aggregate.projectMandate;
  if (!pinned) return;
  const policy = await readProjectMandate(ctx, m.companyId, m.projectId);
  const company = await ctx.companies.get(m.companyId);
  if (!policy?.content.enabled || policy.revisionId !== pinned.revisionId || policy.authorizedBy !== m.ownerUserId
      || company?.defaultResponsibleUserId !== m.ownerUserId
      || pinned.operatingProfileHash !== operatingProfileHash(await ctx.config.get(m.companyId))
      || pinned.mandateHash !== canonicalPayloadHash(m.aggregate.mandate)) {
    throw new MissionError(409, "project_authority_changed", "Retain the pinned project revision and existing effects; no new departure is delegated");
  }
  const hierarchy = m.aggregate.hierarchy;
  const actual = hierarchy ? { protocol: hierarchy.protocol, maxContributions: hierarchy.maxContributions,
    execution: hierarchy.execution, adoptExistingChildren: hierarchy.adoptExistingChildren } : null;
  if (canonicalPayloadHash(actual) !== canonicalPayloadHash(policy.content.hierarchy ?? null)) {
    throw new MissionError(409, "hierarchy_authority_changed", "Hierarchy policy exceeds the original project authority");
  }
  if (canonicalPayloadHash(pinned.completion ?? null) !== canonicalPayloadHash(policy.content.completion ?? null)) {
    throw new MissionError(409, "completion_authority_changed", "Completion must retain the exact pinned result authority");
  }
  await assertDeliveryPredecessor(ctx, m);
  await assertHierarchySources(ctx, m);
}

export function assertProjectPaths(m: MissionRecord, paths: string[]) {
  const policy = m.aggregate.projectMandate;
  if (!policy) return;
  for (const path of paths) {
    const normalized = path.replace(/\/$/, "");
    if (!policy.allowedPaths.some(allowed => allowed === "." || normalized === allowed || normalized.startsWith(`${allowed}/`))) {
      throw new MissionError(422, "project_write_scope", "Contribution ownership exceeds the pinned project paths");
    }
  }
}

export function assertProjectPublication(m: MissionRecord, actual: { publisherAgentId: string; repository: string; baseRef: string; headRef: string; contract?: import("./pr-contract.js").PrContract }) {
  const pinned = m.aggregate.projectMandate;
  if (!pinned) return;
  const allowed = pinned.publication;
  if (!allowed || allowed.publisherAgentId !== actual.publisherAgentId || allowed.repository !== actual.repository
      || allowed.baseRef !== actual.baseRef || actual.headRef !== `${allowed.headRefPrefix}-${m.missionId}`
      || canonicalPayloadHash(actual.contract ?? null) !== canonicalPayloadHash(allowed.contract ?? null)) {
    throw new MissionError(403, "project_publication_scope", "Publication exceeds the explicit project authority; merge and deployment are not delegated");
  }
}
