import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configureContinuity } from "../src/continuity-configuration.js";
import { n2CommandCas, runtimeReceipt, runtimeUuid } from "../src/n2-missions.js";
import type { MissionRecord } from "../src/missions.js";

vi.mock("../src/n2-missions.js", () => ({ runtimeReceipt: () => null, runtimeUuid: (value: string) => value,
  n2CommandCas: async (_ctx: unknown, m: MissionRecord, _body: unknown, _type: unknown, _id: unknown, aggregate: MissionRecord["aggregate"]) => ({ mission: { ...m, aggregate } }) }));

const commands = { n2CommandCas, runtimeReceipt, runtimeUuid };

function fixture() {
  const lead = randomUUID(), reviewer = randomUUID();
  const slots = ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective, specialistAgentId: randomUUID(), required: true, question: "Inspect the exact candidate independently" }));
  const m = { companyId: randomUUID(), ownerUserId: "owner", aggregate: { phase: "draft", journal: [],
    mandate: { limits: { elapsedMinutes: 30 } }, nativeWakePolicy: { protocol: "council-native-wake-v2" },
    compositions: { team: { members: [{ agentId: lead }] } }, responsibilities: { finalReviewerAgentId: reviewer } } } as unknown as MissionRecord;
  const get = vi.fn(async () => ({ adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }));
  const ctx = { agents: { get } } as unknown as PluginContext;
  const body = { command: "configure-continuity", commandId: randomUUID(), authorizeProgression: true, n3Slots: slots };
  return { m, ctx, body, get, lead };
}
describe("owner delegation before activation", () => {
  it("requires explicit delegation and selected independent perspectives before writing a policy", async () => {
    const f = fixture(); f.body.authorizeProgression = false;
    await expect(configureContinuity(f.ctx, f.m, "owner", f.body, commands)).rejects.toMatchObject({ code: "continuity_authorization_required" });
    f.body.authorizeProgression = true; f.body.n3Slots[0]!.specialistAgentId = f.lead;
    await expect(configureContinuity(f.ctx, f.m, "owner", f.body, commands)).rejects.toMatchObject({ code: "continuity_slots_invalid" });
    expect(f.get).not.toHaveBeenCalled();
  });
  it("pins the existing elapsed bound and all selected slots once, without activating or reserving work", async () => {
    const f = fixture(); const before = Date.now();
    const result = await configureContinuity(f.ctx, f.m, "owner", f.body, commands);
    const policy = result.mission.aggregate.continuity!;
    expect(policy.n3Slots).toEqual(f.body.n3Slots); expect(policy.commands).toEqual({});
    expect(Date.parse(policy.deadline) - Date.parse(policy.authorizedAt)).toBe(30 * 60000);
    expect(Date.parse(policy.authorizedAt)).toBeGreaterThanOrEqual(before);
    expect(result.mission.aggregate.phase).toBe("draft"); expect(result.mission.aggregate.n1).toBeUndefined();
    await expect(configureContinuity(f.ctx, result.mission, "owner", f.body, commands)).rejects.toMatchObject({ code: "continuity_configuration_frozen" });
  });
  it("leaves historical missions and activated missions outside the delegated contract", async () => {
    const f = fixture(); f.m.aggregate.nativeWakePolicy = { protocol: "council-native-wake-v1" };
    await expect(configureContinuity(f.ctx, f.m, "owner", f.body, commands)).rejects.toMatchObject({ code: "continuity_configuration_frozen" });
    f.m.aggregate.nativeWakePolicy = { protocol: "council-native-wake-v2", rootBaseline: [] }; f.m.aggregate.phase = "executing";
    await expect(configureContinuity(f.ctx, f.m, "owner", f.body, commands)).rejects.toMatchObject({ code: "continuity_configuration_frozen" });
    expect(f.get).not.toHaveBeenCalled();
  });
});
