import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { NativeProofReference } from "./linear-continuity-contract.js";

export async function readLinearProof(ctx: PluginContext, m: MissionRecord, ref: NativeProofReference) {
  const doc = await ctx.issues.documents.get(m.rootIssueId, ref.key, m.companyId);
  if (!doc || doc.id !== ref.documentId || doc.latestRevisionId !== ref.revisionId || canonicalPayloadHash(doc.body) !== ref.bodySha256) {
    throw new MissionError(409, "linear_continuity_document_changed", "Exact native document and revision must be read back; never replace an uncertain proof");
  }
  return doc;
}
function matchesPayload(body: string, payload: Record<string, unknown>) {
  try { return canonicalPayloadHash(JSON.parse(body)) === canonicalPayloadHash(payload); }
  catch { return false; }
}
export async function ensureLinearDocument(ctx: PluginContext, m: MissionRecord, key: string, payload: Record<string, unknown>, pinned?: NativeProofReference) {
  const body = JSON.stringify(payload);
  if (pinned) {
    const doc = await readLinearProof(ctx, m, pinned);
    if (!matchesPayload(doc.body, payload)) throw new MissionError(409, "linear_continuity_payload_changed", "The original exchange payload must retain its canonical content");
    return pinned;
  }
  let doc = await ctx.issues.documents.get(m.rootIssueId, key, m.companyId);
  if (!doc) {
    await ctx.issues.documents.upsert({ companyId: m.companyId, issueId: m.rootIssueId, key, title: "Council — échange Linear", format: "markdown", body });
    doc = await ctx.issues.documents.get(m.rootIssueId, key, m.companyId);
  }
  if (!doc?.latestRevisionId || !matchesPayload(doc.body, payload)) throw new MissionError(409, "linear_continuity_document_unknown", "Original durable exchange must be observed, without another document key");
  return { key, documentId: doc.id, revisionId: doc.latestRevisionId, bodySha256: canonicalPayloadHash(doc.body) };
}
