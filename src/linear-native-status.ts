import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { queueLinearPublication } from "./linear-continuity-transport.js";
import type { ContinuityObservation } from "./continuity-observation.js";

/** Reconcile the original native status before its writer advances to another observation. */
export async function retainLinearNativeStatus(ctx: PluginContext, original: MissionRecord,
  status: { sequence: number; documentKey: string; body: string; observation: ContinuityObservation }) {
  if (!original.aggregate.linearContinuity) return;
  const m = await (await import("./missions.js")).getMission(ctx, original.companyId, original.missionId);
  if (!m?.aggregate.linearContinuity) throw new MissionError(409, "linear_status_binding", "Original status handoff binding cannot disappear");
  const doc = await ctx.issues.documents.get(m.rootIssueId, status.documentKey, m.companyId);
  if (!doc?.id || !doc.latestRevisionId || doc.body !== status.body) throw new MissionError(409, "linear_status_readback", "Read back the exact native status before retaining its publication");
  await queueLinearPublication(ctx, m, status.observation.state === "blocked" ? "blocker" : "progress", {
    nativeSequence: status.sequence, observation: status.observation,
    evidence: { key: status.documentKey, documentId: doc.id, revisionId: doc.latestRevisionId, bodySha256: canonicalPayloadHash(doc.body) },
    workResultAcquired: false });
}
