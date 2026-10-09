import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";

export type ContinuityObservation = { state: "waiting" | "progressed" | "blocked" | "complete"; code: string; nextAction: string };
type StoredObservation = { companyId: string; missionId: string; sequence: number; documentKey: string;
  body: string; observation: ContinuityObservation; documentObserved: boolean };
const scope = (m: MissionRecord) => ({ scopeKind: "issue" as const, scopeId: m.rootIssueId, namespace: "continuity", stateKey: "observation" });

async function retainLinearStatus(ctx: PluginContext, m: MissionRecord, stored: StoredObservation) {
  if (m.aggregate.linearContinuity) await (await import("./linear-native-status.js")).retainLinearNativeStatus(ctx, m, stored);
}

export async function readContinuityObservation(ctx: PluginContext, m: MissionRecord): Promise<StoredObservation | null> {
  if (!m.aggregate.continuity) return null;
  const stored = await ctx.state.get(scope(m)) as StoredObservation | null;
  if (stored && (stored.companyId !== m.companyId || stored.missionId !== m.missionId
      || !Number.isSafeInteger(stored.sequence) || stored.sequence < 1
      || !/^council-status-[0-9]+-[a-f0-9]{16}$/.test(stored.documentKey)
      || typeof stored.body !== "string" || stored.body.length > 8000 || typeof stored.documentObserved !== "boolean")) {
    throw new MissionError(409, "continuity_status_identity", "Retain the original status intent; its durable binding is unqualified");
  }
  return stored;
}

async function finishDocument(ctx: PluginContext, m: MissionRecord, stored: StoredObservation) {
  let doc = await ctx.issues.documents.get(m.rootIssueId, stored.documentKey, m.companyId);
  if (!doc) {
    if (stored.documentObserved) throw new MissionError(409, "continuity_status_missing", "A previously confirmed status document is missing; do not replace its identity");
    await ctx.issues.documents.upsert({ companyId: m.companyId, issueId: m.rootIssueId, key: stored.documentKey, body: stored.body,
      title: `Progression Council ${stored.sequence} — ${stored.observation.nextAction}`, format: "markdown", changeSummary: stored.observation.nextAction });
    doc = await ctx.issues.documents.get(m.rootIssueId, stored.documentKey, m.companyId);
  }
  if (doc?.body !== stored.body) throw new MissionError(409, "continuity_status_conflict", "Native status body differs from its original intent; no overwrite");
  if (!stored.documentObserved) await ctx.state.set(scope(m), { ...stored, documentObserved: true });
}

/** Single writer: the native scheduled job prevents overlap; events never write this state. */
export async function publishContinuityObservation(ctx: PluginContext, m: MissionRecord, observation: ContinuityObservation) {
  const labels = { waiting: "En attente", progressed: "En cours", blocked: "Décision requise", complete: "Parcours autorisé terminé" };
  const body = `# Progression Council\n\n**État :** ${labels[observation.state]}\n\n${observation.nextAction}\n\nRéférence de diagnostic : \`${observation.code}\`\n`;
  const old = await readContinuityObservation(ctx, m);
  if (old) { await finishDocument(ctx, m, old); await retainLinearStatus(ctx, m, old); }
  if (old?.body === body) return;
  const sequence = (old?.sequence ?? 0) + 1;
  if (!Number.isSafeInteger(sequence)) throw new MissionError(409, "continuity_status_bound", "Status sequence cannot be safely represented");
  const documentKey = `council-status-${sequence}-${createHash("sha256").update(body).digest("hex").slice(0, 16)}`;
  const next: StoredObservation = { companyId: m.companyId, missionId: m.missionId, sequence, documentKey, body, observation, documentObserved: false };
  await ctx.state.set(scope(m), next);
  const readback = await readContinuityObservation(ctx, m);
  if (!isDeepStrictEqual(readback, next)) throw new MissionError(409, "continuity_status_state_conflict", "Status intent changed before publication; retain its observed identity");
  await finishDocument(ctx, m, next);
  await retainLinearStatus(ctx, m, next);
}
