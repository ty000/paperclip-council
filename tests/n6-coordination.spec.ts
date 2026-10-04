import { syncN6HandoffContext } from "../src/n6-context.js";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { coordinationMandate, coordinationTask, type N6Coordination } from "../src/n6-coordination-state.js";
import { coordinationReport, transferCoordinator } from "../src/n6-work-api.js";
import { n2CommandCas } from "../src/n2-missions.js";
import { rebindN6Result } from "../src/n6-rebind.js";
import { readN6Guard, readN6Handoff, assertN6Owner } from "../src/n6-guards.js";
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2CommandCas: vi.fn() }));
vi.mock("../src/n6-guards.js", async original => ({ ...await original(), readN6Guard: vi.fn(), readN6Handoff: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const pm = randomUUID(), facilitator = randomUUID(), lead = randomUUID();
  const task = coordinationTask("coordinator", pm);
  const c: N6Coordination = { protocol: "delegated-coordination-v1", coordinatorAgentId: pm, facilitatorAgentId: facilitator,
    authorizedBy: "owner", authorizedAt: "now", mandate: "A then B", allowedPriorities: ["medium", "high"], participantAgentIds: [lead],
    periodKey: "period", requestedUnits: 1000, state: "working", reason: "handoff", nextActor: pm, priority: "medium", tasks: [task] };
  const m = { companyId: "company", projectId: "project", missionId: randomUUID(), rootIssueId: randomUUID(), ownerUserId: "owner", version: 1,
    aggregate: { journal: [], responsibilities: { integrationLeadAgentId: lead }, n6: { sourceMissionId: randomUUID(), sourceRootIssueId: randomUUID(),
      expectedResult: { submissionId: randomUUID(), mandateHash: "a".repeat(64) }, coordination: c, periodKey: "period", intentId: randomUUID(), guardIssueId: randomUUID(),
      activationCommandId: randomUUID(), startCommandId: randomUUID(), reservationId: randomUUID() } } } as unknown as MissionRecord;
  const ctx = { companies: { get: vi.fn().mockResolvedValue({ defaultResponsibleUserId: "owner" }) }, agents: { get: vi.fn().mockImplementation(async id => ({ id, companyId: "company", adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" })) },
    issues: { update: vi.fn(), get: vi.fn().mockResolvedValue({ priority: "medium" }) } } as any;
  vi.mocked(n2CommandCas).mockImplementation(async (_ctx, current, _body, _type, _actor, aggregate) => ({ outcome: "applied", mission: { ...current, aggregate } }) as never);
  vi.mocked(readN6Guard).mockResolvedValue({ status: "backlog" } as never);
  vi.mocked(readN6Handoff).mockImplementation(async (_ctx, current) => ({ expectedResult: current.aggregate.n6!.expectedResult }) as never);
  return { m, c, task, ctx, pm, facilitator, lead };
}
it("requires the current owner before delegation and pins finite actors/priorities/budget", async () => {
  const f = fixture(); await expect(assertN6Owner(f.ctx, f.m, "intruder")).rejects.toMatchObject({ code: "n6_owner_required" });
  const c = await coordinationMandate(f.ctx, f.m, { coordinatorAgentId: f.pm, facilitatorAgentId: f.facilitator,
    mandate: "Order accepted handoff", allowedPriorities: ["high"], participantAgentIds: [f.lead], requestedUnits: 1000 });
  expect(c).toMatchObject({ authorizedBy: "owner", allowedPriorities: ["high"], periodKey: "period", state: "working" }); expect(c.tasks).toHaveLength(1);
});
it("permits delegated priority and release but rejects reserved priority and source mutation", () => {
  const f = fixture(); const body = { command: "n6-coordinate", action: "release", priority: "high", reason: "Exact artifact handoff clear" };
  expect(coordinationReport(f.m, f.task, body)).toMatchObject({ action: "release", priority: "high", nextActor: "owner" });
  expect(() => coordinationReport(f.m, f.task, { ...body, priority: "critical" })).toThrowError(expect.objectContaining({ code: "n6_reserved_priority" }));
  expect(() => coordinationReport(f.m, f.task, { ...body, sourceMissionId: randomUUID() })).toThrowError(expect.objectContaining({ code: "n6_reserved_decision" }));
});
it("transfers idle coordination without losing work and rejects the old coordinator", async () => {
  const f = fixture(); const successor = randomUUID();
  await expect(transferCoordinator(f.ctx, f.m, { coordinatorAgentId: successor, reason: "take over" }, "owner")).rejects.toMatchObject({ code: "n6_transfer_wait" });
  f.task.closedAt = f.task.settledAt = "now";
  const result = await transferCoordinator(f.ctx, f.m, { coordinatorAgentId: successor, reason: "take over" }, "owner");
  expect(result.mission.aggregate.n6!.coordination!.tasks).toEqual([f.task]);
  expect(() => coordinationReport(result.mission, f.task, { command: "n6-coordinate", action: "release", reason: "old actor" })).toThrowError(expect.objectContaining({ code: "n6_coordinator_required" }));
});
it("bounds facilitation to its question/participants and prevents acceptance or priority authority", () => {
  const f = fixture(); const report = coordinationReport(f.m, f.task, { command: "n6-coordinate", action: "facilitate", reason: "handoff disagreement", question: "Which artifact?", expectedOutcome: "exact reference", participants: [f.lead] });
  expect(report.nextActor).toBe(f.facilitator); expect(report.question).toBe("Which artifact?");
  const task = coordinationTask("facilitator", f.facilitator);
  expect(coordinationReport(f.m, task, { command: "n6-facilitation-outcome", action: "resolved", reason: "reference clarified" })).toMatchObject({ nextActor: f.pm, action: "resolved" });
  expect(() => coordinationReport(f.m, task, { command: "n6-facilitation-outcome", action: "release", priority: "high", reason: "illicit" })).toThrow();
  expect(() => coordinationReport(f.m, task, { command: "ordinary-verdict", action: "approved", reason: "illicit" })).toThrow();
  f.c.tasks.push(task);
  expect(() => coordinationReport(f.m, f.task, { command: "n6-coordinate", action: "facilitate", reason: "repeat" })).toThrowError(expect.objectContaining({ code: "n6_facilitation_bound" }));
});
it("rebinds an accepted same-mandate correction only with explicit owner carry-forward and stable unused identities", async () => {
  const f = fixture(); f.task.closedAt = f.task.settledAt = "now"; f.c.state = "released";
  const expectedResult = { ...f.m.aggregate.n6!.expectedResult, submissionId: randomUUID() };
  const body = { expectedResult, reason: "A correction accepted", preserveCoordinationRelease: true };
  const result = await rebindN6Result(f.ctx, f.m, body, "owner");
  expect(result.mission.aggregate.n6).toMatchObject({ expectedResult, intentId: f.m.aggregate.n6!.intentId, guardIssueId: f.m.aggregate.n6!.guardIssueId, startCommandId: f.m.aggregate.n6!.startCommandId, coordination: { state: "released" } });
  const held = await rebindN6Result(f.ctx, f.m, { ...body, preserveCoordinationRelease: false }, "owner"); expect(held.mission.aggregate.n6!.coordination!.state).toBe("held");
  await expect(rebindN6Result(f.ctx, f.m, { ...body, expectedResult: { ...expectedResult, mandateHash: "other" } }, "owner")).rejects.toMatchObject({ code: "n6_rebind_scope" });
  f.m.aggregate.n6!.activationBody = {};
  await expect(rebindN6Result(f.ctx, f.m, body, "owner")).rejects.toMatchObject({ code: "n6_rebind_unavailable" });
});

it("repairs a context effect lost after rebind CAS without replacing its decision or gate", async () => {
  const f = fixture(); f.task.closedAt = f.task.settledAt = "now";
  f.ctx.issues.update.mockRejectedValueOnce(new Error("lost native context update"));
  const body = { expectedResult: { ...f.m.aggregate.n6!.expectedResult, submissionId: randomUUID() }, reason: "accepted correction" };
  await expect(rebindN6Result(f.ctx, f.m, body, "owner")).rejects.toThrow("lost native context update");
  const durable = { ...f.m, aggregate: vi.mocked(n2CommandCas).mock.calls[0]![5] };
  await syncN6HandoffContext(f.ctx, durable);
  expect(n2CommandCas).toHaveBeenCalledTimes(1);
  expect(f.ctx.issues.update).toHaveBeenLastCalledWith(f.m.rootIssueId, expect.objectContaining({ description: expect.stringContaining("SUPERSEDED") }), f.m.companyId, expect.anything());
  expect(durable.aggregate.n6!.guardIssueId).toBe(f.m.aggregate.n6!.guardIssueId);
});
