import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas } from "./n2-missions.js";
import { FIXED_CAMPAIGN_MODE, SOURCE_INVALIDATION_EVENT, SOURCE_INVALIDATION_KEY,
  sourceInvalidationSchema, sourceInvalidationNoticeSchema } from "./linear-continuity-contract.js";

/** One native document read recovers lost hints; it never reads Linear. */
export async function readSourceInvalidation(ctx: PluginContext, m: MissionRecord) {
  const state = m.aggregate.linearContinuity;
  if (state?.mode !== FIXED_CAMPAIGN_MODE) return m;
  const doc = await ctx.issues.documents.get(m.rootIssueId, SOURCE_INVALIDATION_KEY, m.companyId);
  if (!doc) return m;
  if (!doc.latestRevisionId || Buffer.byteLength(doc.body) > 64_000) throw new MissionError(409, "linear_invalidation_document", "A bounded current native invalidation document is required");
  const parsed = sourceInvalidationSchema.parse(JSON.parse(doc.body));
  if (canonicalPayloadHash(parsed.binding) !== canonicalPayloadHash(state.binding) || parsed.sourceSha256 !== state.sourceSha256) {
    throw new MissionError(409, "linear_invalidation_binding", "Source invalidation must retain the exact campaign binding");
  }
  if (parsed.generation <= (state.sourceInvalidationVersion ?? 0)) return m;
  return n2Cas(ctx, m, { ...m.aggregate, linearContinuity: { ...state, sourceInvalidationVersion: parsed.generation } });
}

export async function handleSourceInvalidation(ctx: PluginContext, event: PluginEvent) {
  if (event.eventType !== SOURCE_INVALIDATION_EVENT || event.actorType !== "plugin" || event.actorId !== "ty000.linear-intake") return;
  const result = sourceInvalidationNoticeSchema.safeParse(event.payload);
  if (!result.success || result.data.companyId !== event.companyId) return;
  const notice = result.data, m = await getMission(ctx, event.companyId, notice.missionId);
  if (!m || m.rootIssueId !== notice.nativeRootId || m.aggregate.linearContinuity?.mode !== FIXED_CAMPAIGN_MODE
      || canonicalPayloadHash(m.aggregate.linearContinuity.binding) !== notice.bindingSha256
      || notice.invalidation.key !== SOURCE_INVALIDATION_KEY) return;
  // A later coalesced revision may supersede the notified reference. Read the
  // current native document, never infer source freshness from the event.
  await readSourceInvalidation(ctx, m);
}
