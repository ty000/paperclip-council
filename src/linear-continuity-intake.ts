import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import type { ProjectMandate } from "./project-mandate-state.js";
import { n2Cas } from "./n2-missions.js";
import { LINEAR_CONTINUITY_PROTOCOL, linearAuthorityHash } from "./linear-continuity-contract.js";
import { LINEAR_READINESS_KEY, parseLinearReadiness } from "./linear-intake-contract.js";
import { MissionError } from "./mission-primitives.js";
import { reconcileLinearContinuity } from "./linear-continuity-runtime.js";
import { assertLinearContinuityDeparture } from "./linear-continuity-control.js";

/** Owner opt-in is pinned before admission; the initial source protocol remains compatible. */
export function parseLinearContinuityPolicy(value: unknown, imported: unknown) {
  if (value === undefined) return undefined;
  if (!imported || !value || typeof value !== "object" || Object.keys(value).length !== 1
      || (value as { protocol: string }).protocol !== LINEAR_CONTINUITY_PROTOCOL) throw new MissionError(422, "linear_continuity_policy", "Explicit v1 continuity policy requires the native Linear intake contract");
  return { protocol: LINEAR_CONTINUITY_PROTOCOL };
}
export async function prepareLinearContinuity(ctx: PluginContext, initial: MissionRecord, policy: ProjectMandate) {
  let m = initial;
  if (!policy.content.linearContinuity || !m.aggregate.projectMandate?.linearIntake) return m;
  if (!m.aggregate.linearContinuity) {
    if (m.aggregate.phase !== "draft" || m.aggregate.n1) throw new MissionError(409, "linear_continuity_late_opt_in", "Existing execution is not retroactively upgraded");
    const subject = m.aggregate.projectMandate.linearIntake.subject;
    const doc = await ctx.issues.documents.get(subject.nativeRootId, LINEAR_READINESS_KEY, m.companyId);
    if (!doc || doc.id !== subject.readinessDocumentId || doc.latestRevisionId !== subject.readinessRevisionId) throw new MissionError(409, "linear_continuity_original_source", "Original readiness revision must remain exact");
    const readiness = parseLinearReadiness(doc.body);
    const binding = { companyId: m.companyId, projectId: m.projectId, missionId: m.missionId, nativeRootId: m.rootIssueId,
      campaignId: subject.activationId, sourceRootId: readiness.sourceRootId, subject, authoritySha256: linearAuthorityHash(m) };
    m = await n2Cas(ctx, m, { ...m.aggregate, linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, binding,
      authorizedBy: policy.authorizedBy, sourceSha256: subject.sourceSha256, sequence: 0, control: "running", consumed: [], publications: [], safeSettlementIds: {} } });
  }
  m = await reconcileLinearContinuity(ctx, m);
  await assertLinearContinuityDeparture(ctx, m);
  return m;
}
