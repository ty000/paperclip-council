import type { MissionRecord } from "./missions.js";
import type { ProfileId, TaskFamily, MODEL_CATALOGUE } from "./model-catalogue.js";

export class ModelSelectionError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message); this.name = "ModelSelectionError";
  }
}
export type ModelChoice = { taskKey: string; interventionKey: string; family: TaskFamily; profileId: ProfileId;
  rationale: string; authority: "user" | "lead"; actorId: string; at: string };
export type ModelMeasurement = { runId: string; status: string; inputTokens: number | null; outputTokens: number | null;
  durationMs: number | null; observedAt: string };
export type ModelLaunch = { taskKey: string; interventionKey: string; launchKey: string; logicalAgentId: string;
  agentId: string; roleKey: string; profileId: ProfileId; requestedProfileId: ProfileId; family: TaskFamily; rationale: string;
  authority: "user" | "lead" | "default"; choiceAt?: string; mappingRevision: string; variantRevision: string; selectedAt: string;
  state: "selected" | "assignment_claimed" | "ready" | "wake_claimed" | "bound" | "unknown";
  issueId: string | null; runId: string | null; previousLaunchKey?: string; ascent: boolean;
  fallback?: { from: ProfileId; reason: string }; measurement?: ModelMeasurement;
  historyArchive?: import("./model-history.js").HistoryArchive;
  history?: { indexKey: string; indexSha256: string; gapCount: number; cutoff: string } };
export type ModelTask = { taskKey: string; mapping: typeof MODEL_CATALOGUE; variantRevision: string;
  ascentLaunchKey?: string; launches: ModelLaunch[] };
export type ModelSelectionState = { protocol: "native-variants-v1"; choices: ModelChoice[]; tasks: ModelTask[] };

export function modelLaunch(m: MissionRecord, launchKey: string): ModelLaunch | undefined {
  return m.aggregate.modelSelection?.tasks.flatMap(t => t.launches).find(l => l.launchKey === launchKey);
}

/** Keep host principals physical. Only exact persisted launch bindings resolve a logical role. */
export function physicalAgent(m: MissionRecord, logicalId: string,
  target: { issueId?: string | null; runId?: string | null; launchKey?: string } = {}): string {
  const matches = m.aggregate.modelSelection?.tasks.flatMap(t => t.launches).filter(l => l.logicalAgentId === logicalId
    && (!target.issueId || l.issueId === target.issueId) && (!target.runId || l.runId === target.runId)
    && (!target.launchKey || l.launchKey === target.launchKey)) ?? [];
  if (!matches.length) {
    if (m.aggregate.modelSelection && (target.runId || target.launchKey)) throw new ModelSelectionError("model_binding_missing", "An opted-in mission requires an exact persisted physical launch binding");
    return logicalId;
  }
  if (target.runId && matches.length !== 1) throw new ModelSelectionError("model_binding_ambiguous", "Run must identify exactly one physical launch");
  return matches.at(-1)!.agentId;
}

export function isLogicalActor(m: MissionRecord, logicalId: string, actorId: string, runId: string): boolean {
  try { return physicalAgent(m, logicalId, { runId }) === actorId; }
  catch (error) { if (error instanceof ModelSelectionError) return false; throw error; }
}

export function modelMeasurements(m: MissionRecord) {
  return (m.aggregate.modelSelection?.tasks ?? []).map(task => {
    const runs = task.launches.flatMap(l => l.measurement ? [l.measurement] : []);
    const total = (field: "inputTokens" | "outputTokens" | "durationMs") => runs.length && runs.every(r => r[field] !== null)
      ? runs.reduce((n, r) => n + r[field]!, 0) : null;
    return { taskKey: task.taskKey, runCount: runs.length, inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), durationMs: total("durationMs") };
  });
}
