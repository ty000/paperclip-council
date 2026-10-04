import { syncN6HandoffContext } from "./n6-context.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { n2CommandCas } from "./n2-missions.js";
import type { N3CandidateSubject } from "./n3-opinions.js";
import { readN6Guard, readN6Handoff } from "./n6-guards.js";
import { coordinationText } from "./n6-coordination-state.js";

/** Owner explicitly carries a same-mandate accepted correction across the unconsumed gate. */
export async function rebindN6Result(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const dep = m.aggregate.n6;
  if (!dep || m.aggregate.n1 || dep.activationBody || dep.startBody || dep.verifiedAt
      || dep.coordination?.tasks.some(t => !t.closedAt)) throw new MissionError(409, "n6_rebind_unavailable", "Rebind requires an unconsumed dependency and no active coordination work");
  const guard = await readN6Guard(ctx, m);
  if (guard.status === "done") throw new MissionError(409, "n6_rebind_unavailable", "A consumed native gate cannot be rebound");
  const expected = body.expectedResult as N3CandidateSubject;
  if (!expected || expected.mandateHash !== dep.expectedResult.mandateHash || expected.submissionId === dep.expectedResult.submissionId) {
    throw new MissionError(409, "n6_rebind_scope", "A different accepted submission of the same source and mandate is required");
  }
  if (Object.keys(body).some(k => !["companyId", "command", "commandId", "expectedVersion", "expectedResult", "reason", "preserveCoordinationRelease"].includes(k))) {
    throw new MissionError(403, "n6_rebind_scope", "Rebind cannot replace source, root, mandate, budget or authority");
  }
  const next = { ...dep, expectedResult: expected, blockage: undefined };
  const artifact = await readN6Handoff(ctx, { ...m, aggregate: { ...m.aggregate, n6: next } });
  // Canonical tuple comes from immutable accepted submission, not caller-supplied additional fields.
  if (canonicalPayloadHash(artifact.expectedResult) !== canonicalPayloadHash(expected)) throw new MissionError(409, "n6_rebind_scope", "Exact accepted tuple required");
  if (next.coordination && body.preserveCoordinationRelease !== true) next.coordination = { ...next.coordination,
    state: "held", reason: "Owner rebound the accepted source; prior coordinator release was not carried forward", nextActor: actorId };
  const result = await n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n6: { ...next, verifiedArtifact: artifact },
    journal: [...m.aggregate.journal, { action: "result_dependency_rebound", actorUserId: actorId, oldResult: dep.expectedResult,
      newResult: expected, preserveCoordinationRelease: body.preserveCoordinationRelease === true,
      reason: coordinationText(body.reason, "reason"), at: new Date().toISOString() }] });
  await syncN6HandoffContext(ctx, result.mission);
  return result;
}
