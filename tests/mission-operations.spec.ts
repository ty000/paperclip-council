import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { executeMissionCommand, type MissionRecord } from "../src/missions.js";
import { inspectMissionOperations, missionAssistanceEvent } from "../src/mission-operations.js";

function mission(): MissionRecord {
  return { companyId: "company", missionId: "mission", version: 1, aggregate: { schemaVersion: 1, commandReceipts: [], journal: [],
    modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: "task", mapping: [], variantRevision: "1", launches: [
      { roleKey: "lead", runId: "run-1", previousLaunchKey: undefined, measurement: { runId: "run-1", status: "succeeded", inputTokens: 100, outputTokens: 20, durationMs: 1, observedAt: new Date(0).toISOString() } },
      { roleKey: "lead", runId: "run-2", previousLaunchKey: "launch-1" },
    ] }] } } } as unknown as MissionRecord;
}

it("reports runs by role without inventing cache, output excess or missing usage", () => {
  const m = mission();
  m.aggregate.journal.push(missionAssistanceEvent(m, "owner", { command: "record-assistance", commandId: randomUUID(), expectedVersion: 1,
    category: "technical_repair", cause: "Audit command missing in the admitted shell", role: "contributor" }));
  const report = inspectMissionOperations(m);
  expect(report.roles).toEqual([expect.objectContaining({ roleKey: "lead", runCount: 2, repeatedLaunchCount: 1,
    inputTokens: null, cachedInputTokens: null, outputTokens: null, unknownUsageRunIds: ["run-2"],
    cacheProvenance: "unavailable_in_persisted_model_measurement" })]);
  expect(report.assistance).toEqual([expect.objectContaining({ sequence: 1, category: "technical_repair", role: "contributor" })]);
  expect(report.outputAssessment.state).toBe("unknown");
});

it("persists and idempotently replays owner assistance in the existing mission journal", async () => {
  const m = mission();
  const row: any = { company_id: "company", mission_id: "mission", root_issue_id: "root", project_id: "project", owner_user_id: "owner",
    team_roster_id: "team", team_revision: "tr", council_roster_id: "council", council_revision: "cr", version: 1,
    aggregate: m.aggregate, created_at: new Date(0), updated_at: new Date(0) };
  const execute = vi.fn(async (_sql: string, params: unknown[]) => {
    row.aggregate = JSON.parse(String(params[0])); row.version += 1; return { rowCount: 1 };
  });
  const ctx = { companies: { get: async () => ({ id: "company", defaultResponsibleUserId: "owner" }) },
    db: { namespace: "council", query: async () => [row], execute } } as unknown as PluginContext;
  const body = { command: "record-assistance", commandId: randomUUID(), expectedVersion: 1,
    category: "human_validation", cause: "Owner accepted the product wording", role: "council" };
  const input = { companyId: "company", missionId: "mission", actorUserId: "owner", body };
  const applied = await executeMissionCommand(ctx, input);
  expect(applied).toMatchObject({ outcome: "applied", mission: { version: 2 } });
  expect(applied.mission.aggregate.journal.at(-1)).toMatchObject({ action: "operator_assistance_recorded", sequence: 1,
    category: "human_validation", cause: body.cause });
  const replayed = await executeMissionCommand(ctx, input);
  expect(replayed.outcome).toBe("replayed"); expect(execute).toHaveBeenCalledTimes(1);
});

it("rejects unclassified assistance and extra fields", () => {
  const m = mission();
  expect(() => missionAssistanceEvent(m, "owner", { command: "record-assistance", commandId: randomUUID(), expectedVersion: 1,
    category: "other", cause: "unknown", role: "lead" })).toThrow(/supported assistance category/);
  expect(() => missionAssistanceEvent(m, "owner", { command: "record-assistance", commandId: randomUUID(), expectedVersion: 1,
    category: "normal_preparation", cause: "checkout", role: "lead", secret: "no" })).toThrow(/no extra fields/);
});
