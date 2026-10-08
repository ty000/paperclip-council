import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { configureContinuity } from "../src/continuity-configuration.js";
import { n2CommandCas, runtimeReceipt, runtimeUuid } from "../src/n2-missions.js";
import type { MissionRecord } from "../src/missions.js";
import { assertContinuityDeparture, assertN1DepartureWindow } from "../src/continuity-policy.js";

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

async function suspendedMission() {
  const f = fixture();
  const configured = await configureContinuity(f.ctx, f.m, "owner", f.body, commands);
  const m = configured.mission;
  m.aggregate.phase = "executing";
  m.aggregate.control = { status: "active" };
  m.aggregate.n1 = { activatedAt: new Date(Date.now() - 3600000).toISOString(),
    periodKey: "retained-period", activationReservationId: randomUUID(), contributions: [] };
  m.aggregate.continuity!.deadline = new Date(Date.now() - 1800000).toISOString();
  m.aggregate.continuity!.enabled = false;
  m.aggregate.continuity!.commands = { "start-lead": { commandId: randomUUID() } };
  return { ...f, m, resume: { command: "resume-continuity", commandId: randomUUID(), authorizeProgression: true,
    deadline: new Date(Date.now() + 1200000).toISOString(), reason: "Owner-authorized continuation after controller repair" } };
}

describe("explicit continuation window", () => {
  it("admits a new time window without changing the mandate, activation, budget or historical commands", async () => {
    const f = await suspendedMission();
    const original = structuredClone(f.m.aggregate);
    expect(() => assertN1DepartureWindow(f.m)).toThrowError(/elapsed limit/);
    const result = await configureContinuity(f.ctx, f.m, "owner", f.resume, commands);
    const a = result.mission.aggregate;
    expect(a.mandate).toEqual(original.mandate);
    expect(a.n1).toEqual(original.n1);
    expect(a.nativeWakePolicy).toEqual(original.nativeWakePolicy);
    expect(a.continuity!.commands).toEqual(original.continuity!.commands);
    expect(a.continuity!.authorizedAt).toBe(original.continuity!.authorizedAt);
    expect(a.continuity!.extensions).toEqual([expect.objectContaining({ commandId: f.resume.commandId,
      previousDeadline: original.continuity!.deadline, deadline: f.resume.deadline, authorizedBy: "owner" })]);
    expect(() => assertContinuityDeparture(result.mission)).not.toThrow();
    expect(() => assertN1DepartureWindow(result.mission)).not.toThrow();
    a.continuity!.enabled = false;
    expect(() => assertN1DepartureWindow(result.mission)).toThrowError(/no delegated departure/);
  });
  it("refuses an implicit extension, a different owner and changed mandate", async () => {
    const f = await suspendedMission();
    await expect(configureContinuity(f.ctx, f.m, "owner", { ...f.resume, authorizeProgression: false }, commands))
      .rejects.toMatchObject({ code: "continuity_authorization_required" });
    await expect(configureContinuity(f.ctx, f.m, "stranger", f.resume, commands))
      .rejects.toMatchObject({ code: "continuity_resume_unavailable" });
    f.m.aggregate.mandate.limits.elapsedMinutes += 1;
    await expect(configureContinuity(f.ctx, f.m, "owner", f.resume, commands))
      .rejects.toMatchObject({ code: "continuity_resume_unavailable" });
  });
  it("refuses an expired or overlong window and retains previous extensions", async () => {
    const f = await suspendedMission();
    for (const deadline of ["invalid", new Date(Date.now() - 1).toISOString(), new Date(Date.now() + 3600000).toISOString()]) {
      await expect(configureContinuity(f.ctx, f.m, "owner", { ...f.resume, deadline }, commands))
        .rejects.toMatchObject({ code: "continuity_deadline_invalid" });
    }
    const first = await configureContinuity(f.ctx, f.m, "owner", f.resume, commands);
    first.mission.aggregate.continuity!.enabled = false;
    const next = await configureContinuity(f.ctx, first.mission, "owner", { ...f.resume, commandId: randomUUID(),
      deadline: new Date(Date.parse(f.resume.deadline) + 1000).toISOString() }, commands);
    expect(next.mission.aggregate.continuity!.extensions).toHaveLength(2);
    expect(next.mission.aggregate.continuity!.extensions![0]).toEqual(first.mission.aggregate.continuity!.extensions![0]);
    next.mission.aggregate.continuity!.deadline = new Date(Date.now() - 1).toISOString();
    next.mission.aggregate.continuity!.extensions![1]!.deadline = next.mission.aggregate.continuity!.deadline;
    expect(() => assertN1DepartureWindow(next.mission)).toThrowError(/elapsed bound is exhausted/);
  });
});
