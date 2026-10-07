import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";
import type { ProjectPublication } from "./project-mandate-state.js";

export type CompletionPolicy = { protocol: "council-proof-close-v1"; result: "draft-pr" | "reviewed-pr" | "accepted-candidate" };
export type CompletionState = { state: "closing" | "closed"; proofId: string; documentKey: string; body: string;
  documentRevisionId?: string; closedNodeIds: string[]; qualifiedAt: string; completedAt?: string;
  notification: { body: string; authorAgentId: string; state: "pending" | "claimed" | "confirmed"; commentId?: string } };
export function completionPolicy(m: MissionRecord) { return m.aggregate.projectMandate?.completion; }
export function parseCompletionPolicy(value: unknown, publication: ProjectPublication | null, hierarchy: unknown): CompletionPolicy | undefined {
  if (value === undefined) return undefined;
  const v = value as CompletionPolicy;
  if (!v || Array.isArray(v) || v.protocol !== "council-proof-close-v1" || !["draft-pr", "reviewed-pr", "accepted-candidate"].includes(v.result)
      || Object.keys(v).some(key => !["protocol", "result"].includes(key)) || !hierarchy || (hierarchy as { execution?: string }).execution !== "sequential" || (hierarchy as { adoptExistingChildren?: boolean }).adoptExistingChildren !== true) throw new MissionError(422, "completion_policy", "Explicit bounded result and sequential Council hierarchy required; integrations/deployment are not inferred");
  if (v.result === "accepted-candidate" ? publication !== null : publication?.contract?.result !== v.result) {
    throw new MissionError(422, "completion_result_scope", "The completion result must exactly match the delegated publication contract, or no publication for an accepted candidate");
  }
  return { protocol: v.protocol, result: v.result };
}
