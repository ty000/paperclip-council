import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export async function coordinateFixture({ api, call, config, runId, issueId, agentId, observe }) {
  let state = await call({ command: "n6-inspect" });
  if (agentId === config.actors.facilitator) {
    await writeFile(resolve(config.runtime, "n6-facilitator-running"), JSON.stringify({ runId, issueId, missionId: state.missionId }));
    await observe(async () => { try { await readFile(resolve(config.runtime, "n6-coordinator-transferred")); return true; } catch { return false; } }, Boolean, "owner coordinator transfer");
    state = await call({ command: "n6-inspect" });
    const route = `/api/plugins/private.paperclip-council/api/issues/${issueId}/council/commands`;
    const refused = await api("POST", route, { missionId: state.missionId, command: "n6-facilitation-outcome", commandId: randomUUID(), expectedVersion: state.version,
      action: "release", priority: "critical", reason: "Fixture verifies facilitator has no priority/release authority" }, 403);
    assert.equal(refused.code, "n6_reserved_decision");
    const result = await call({ command: "n6-facilitation-outcome", commandId: randomUUID(), expectedVersion: state.version,
      action: "resolved", reason: "Fixture participants' native records identify the same accepted-result handoff: B consumes A's immutable attachment, not an unmerged branch. No consensus or model judgment claimed; coordinator retains ordering authority." });
    return result.finishReport;
  }
  const route = `/api/plugins/private.paperclip-council/api/issues/${issueId}/council/commands`;
  const refused = await api("POST", route, { missionId: state.missionId, command: "n6-coordinate", commandId: randomUUID(), expectedVersion: state.version,
    action: "release", priority: "critical", reason: "Reserved priority fixture refusal" }, 403);
  assert.equal(refused.code, "n6_reserved_priority");
  const successor = agentId === config.actors.pmSuccessor;
  if (successor) assert(state.dependency.coordination.tasks.some(t => t.kind === "facilitator" && t.settledAt && t.report.action === "resolved"));
  const body = { command: "n6-coordinate", commandId: randomUUID(), expectedVersion: state.version, action: successor ? "release" : "facilitate",
    priority: "high", reason: successor ? "Successor read the durable outcome and releases B after the exact accepted artifact and accounting gate" : "A precedes B; clarify the accepted artifact handoff before continuation",
    ...!successor ? { question: "Which immutable artifact should B consume while A's branch is unmerged?", expectedOutcome: "An exact accepted bundle and accountable next actor",
      participants: [config.actors.lead, config.actors.quality] } : {} };
  const result = await call(body);
  const replay = await call(body); assert.equal(replay.outcome, "replayed");
  return result.finishReport;
}
