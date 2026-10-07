import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import { operatingProfileHash } from "./project-mandate-state.js";
import { readProjectMandate } from "./project-mandate-state.js";

export async function assertProjectDeparture(ctx: PluginContext, m: MissionRecord) {
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

export function assertProjectPublication(m: MissionRecord, actual: { publisherAgentId: string; repository: string; baseRef: string; headRef: string }) {
  const pinned = m.aggregate.projectMandate;
  if (!pinned) return;
  const allowed = pinned.publication;
  if (!allowed || allowed.publisherAgentId !== actual.publisherAgentId || allowed.repository !== actual.repository
      || allowed.baseRef !== actual.baseRef || actual.headRef !== `${allowed.headRefPrefix}-${m.missionId}`) {
    throw new MissionError(403, "project_publication_scope", "Publication exceeds the explicit project authority; merge and deployment are not delegated");
  }
}
