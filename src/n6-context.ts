import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";

/** Recoverable context projection after CAS; no business decision or new effect identity. */
export async function syncN6HandoffContext(ctx: PluginContext, m: MissionRecord) {
  const dep = m.aggregate.n6!;
  if (!dep.verifiedArtifact) return;
  const rebound = [...m.aggregate.journal].reverse().find(entry => entry.action === "result_dependency_rebound");
  const binding = rebound ? `OWNER RESULT REBIND: initial tuple ${JSON.stringify(rebound.oldResult)} is SUPERSEDED. Owner ${dep.authorizedBy}: ${String(rebound.reason)}. ` : "";
  const handoff = `${binding}Accepted source artifact: ${JSON.stringify(dep.verifiedArtifact)}. Consume only this current authenticated inspect handoff.`;
  const root = await ctx.issues.get(m.rootIssueId, m.companyId);
  if (!root?.description?.includes(handoff)) await ctx.issues.update(m.rootIssueId,
    { description: `${root?.description ?? ""}\n\n${handoff}` }, m.companyId, { actorUserId: dep.authorizedBy });
}
