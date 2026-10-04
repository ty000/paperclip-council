import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/admission.js", async original => ({ ...await original(), readAdmission: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readNativeG4Profile: vi.fn() }));
vi.mock("../src/n5-preflight.js", () => ({ acceptedN5Submission: vi.fn() }));
vi.mock("../src/n1-missions.js", async original => ({ ...await original(), executeN1BoardCommand: vi.fn() }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2Cas: vi.fn() }));
import { getMission, MissionError, type MissionRecord } from "../src/missions.js";
import { readNativeG4Profile } from "../src/g4-native.js";
import { readAdmission } from "../src/admission.js";
import { acceptedN5Submission } from "../src/n5-preflight.js";
import { executeN1BoardCommand } from "../src/n1-missions.js";
import { n2Cas } from "../src/n2-missions.js";
import { assertN6AcceptedSource, assertN6Acyclic, assertN6LaunchReady, guardOriginId, N6_GUARD_ORIGIN } from "../src/n6-guards.js";
import { reconcileN6 } from "../src/n6-runtime.js";
import { inspectN6 } from "../src/n6-state.js";

beforeEach(() => vi.resetAllMocks());
function fixture() {
  const id = randomUUID();
  let target = { companyId: "company", projectId: "project", missionId: "B", rootIssueId: "rootB", ownerUserId: "owner", version: 1,
    aggregate: { schemaVersion: 1, commandReceipts: [], journal: [], n6: { protocol: "accepted-result-v1", sourceMissionId: "A", sourceRootIssueId: "rootA", expectedResult: {
      submissionId: id, candidateCommit: "a".repeat(40), bundleSha256: "b".repeat(64), evidenceRevision: 1, mandateHash: "c".repeat(64) },
    authorizedBy: "owner", authorizedAt: "now", intentId: "intent", guardIssueId: "gate", guardCreation: "confirmed", relationConfirmed: true,
    periodKey: "period", requestedUnits: 1000, reservationId: "reservation", activationCommandId: "activate", startCommandId: "start" } } } as unknown as MissionRecord;
  const source = { companyId: "company", projectId: "project", missionId: "A", rootIssueId: "rootA", version: 1, aggregate: { schemaVersion: 1, commandReceipts: [], n1: { periodKey: "period" }, n2: { ordinary: { tasks: [] } } } } as unknown as MissionRecord;
  const accepted = { ...target.aggregate.n6!.expectedResult, sha256: "b".repeat(64) };
  vi.mocked(acceptedN5Submission).mockReturnValue(accepted as never);
  vi.mocked(readNativeG4Profile).mockResolvedValue({ periodKey: "period" } as never);
  const reservations = [{ missionId: "A", status: "settled", usage: { status: "known", units: 150 }, remainingExposure: { status: "known", units: 0 } }];
  vi.mocked(readAdmission).mockImplementation(async () => ({ reservations }) as never);
  const gate = { id: "gate", companyId: "company", projectId: "project", status: "backlog", originKind: N6_GUARD_ORIGIN, originId: guardOriginId(target) };
  const blockedBy = [gate]; const effects: string[] = [];
  const ctx = { db: { namespace: "test", query: vi.fn().mockImplementation(async (_q, params) => {
    const m = params[1] === "A" ? source : target;
    return [{ company_id: m.companyId, project_id: m.projectId, mission_id: m.missionId, root_issue_id: m.rootIssueId,
      owner_user_id: m.ownerUserId, version: m.version, aggregate: m.aggregate, created_at: new Date(), updated_at: new Date() }];
  }) }, companies: { get: vi.fn().mockResolvedValue({ defaultResponsibleUserId: "owner" }) }, issues: {
    get: vi.fn().mockResolvedValue(gate), list: vi.fn().mockResolvedValue([gate]), create: vi.fn(),
    relations: { get: vi.fn().mockImplementation(async () => ({ blockedBy })), addBlockers: vi.fn() },
    update: vi.fn().mockImplementation(async (_id, body) => { effects.push(`gate:${body.status}`); Object.assign(gate, body); }),
  } };
  vi.mocked(n2Cas).mockImplementation(async (_c, _m, aggregate) => { target = { ...target, version: target.version + 1, aggregate }; return target; });
  vi.mocked(executeN1BoardCommand).mockImplementation(async (_c, input) => {
    effects.push(String(input.body.command));
    if (input.body.command === "activate") target.aggregate.n1 = { activationReservationId: input.body.reservationId };
    else target.aggregate.n1 = { ...target.aggregate.n1, rootDispatchState: "requested", rootDispatchRunId: "runB" };
    return { mission: target } as never;
  });
  return { ctx: ctx as never, target, source, accepted, reservations, gate, blockedBy, effects, current: () => target };
}

it("does not treat source issue done as acceptance and keeps an explained durable wait", async () => {
  const f = fixture(); vi.mocked(acceptedN5Submission).mockImplementation(() => { throw new MissionError(409, "n5_accepted_candidate_required", "Not accepted"); });
  const m = await reconcileN6(f.ctx, f.target);
  expect(inspectN6(m)).toMatchObject({ state: "waiting", nextActor: "owner", blockage: "n5_accepted_candidate_required" });
  expect(executeN1BoardCommand).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
});
it.each(["candidateCommit", "mandateHash", "submissionId", "evidenceRevision", "sha256"])("does not release changed %s", async key => {
  const f = fixture(); Object.assign(f.accepted, { [key]: key === "evidenceRevision" ? 2 : "different" });
  await expect(assertN6AcceptedSource(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_result_mismatch" });
});
it.each(["unsettled", "unknownUsage", "unknownExposure", "remainingExposure"])("retains source accounting boundary %s", async condition => {
  const f = fixture(); const r = f.reservations[0]!;
  if (condition === "unsettled") r.status = "unsettled";
  if (condition === "unknownUsage") r.usage.status = "unknown";
  if (condition === "unknownExposure") r.remainingExposure.status = "unknown";
  if (condition === "remainingExposure") r.remainingExposure.units = 1;
  await expect(assertN6AcceptedSource(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_source_usage_pending" });
});
it("rejects cross-project source and a simple result-dependency cycle", async () => {
  const f = fixture(); f.source.projectId = "elsewhere";
  await expect(assertN6AcceptedSource(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_source_scope" });
  f.source.projectId = "project"; f.source.aggregate.n6 = { ...f.target.aggregate.n6!, sourceMissionId: "B", sourceRootIssueId: "rootB" };
  await expect(assertN6Acyclic(f.ctx, f.target, f.source)).rejects.toMatchObject({ code: "n6_cycle" });
});
it("uses one gate completion then persisted N1 activation/start, and replay adds no wake", async () => {
  const f = fixture(); const m = await reconcileN6(f.ctx, f.target);
  expect(f.effects).toEqual(["gate:done", "activate", "start-lead"]);
  const calls = vi.mocked(executeN1BoardCommand).mock.calls.map(([, input]) => input.body);
  expect(calls[0]).toEqual(m.aggregate.n6!.activationBody); expect(calls[1]).toEqual(m.aggregate.n6!.startBody);
  expect(m.aggregate.journal).toContainEqual(expect.objectContaining({ actorType: "automation", authorizedBy: "owner" }));
  await reconcileN6(f.ctx, m); expect(executeN1BoardCommand).toHaveBeenCalledTimes(2);
});
it("refuses an altered launch command or missing native blocker even after verification", async () => {
  const f = fixture(); const m = await reconcileN6(f.ctx, f.target); const body = m.aggregate.n6!.startBody!;
  await expect(assertN6LaunchReady(f.ctx, m, { ...body, commandId: "replacement" })).rejects.toMatchObject({ code: "n6_launch_authority" });
  f.blockedBy.length = 0;
  await expect(assertN6LaunchReady(f.ctx, m, body)).rejects.toMatchObject({ code: "n6_gate_pending" });
});
it("never recreates an ambiguous native gate or a claimed downstream wake", async () => {
  const f = fixture(); f.target.aggregate.n6!.guardIssueId = null;
  const ctx = f.ctx as any; ctx.issues.list.mockResolvedValue([]);
  await expect(reconcileN6(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_guard_effect_unknown" });
  expect(ctx.issues.create).not.toHaveBeenCalled(); expect(executeN1BoardCommand).not.toHaveBeenCalled();
  f.target.aggregate.n1 = { rootDispatchState: "unknown" };
  await reconcileN6(f.ctx, f.target); expect(executeN1BoardCommand).not.toHaveBeenCalled();
});
it("revokes automated execution when the configured owner changes", async () => {
  const f = fixture(); (f.ctx as any).companies.get.mockResolvedValue({ defaultResponsibleUserId: "other" });
  await expect(reconcileN6(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_owner_required" });
  expect(executeN1BoardCommand).not.toHaveBeenCalled();
});
it("checks the known publisher reservation in the native period distinct from legacy N1", async () => {
  const f = fixture(); vi.mocked(readNativeG4Profile).mockResolvedValue({ periodKey: "native-period" } as never);
  f.source.aggregate.n5 = { publication: { reservationId: "publisher" } } as never;
  const publisher = { ...f.reservations[0], reservationId: "publisher", status: "reserved" };
  vi.mocked(readAdmission).mockImplementation(async (_ctx, input) => ({ reservations: input.periodKey === "native-period" ? [publisher] : f.reservations }) as never);
  await expect(assertN6AcceptedSource(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_source_usage_pending" });
  publisher.status = "settled";
  await expect(assertN6AcceptedSource(f.ctx, f.target)).resolves.toMatchObject({ missionId: "A" });
  vi.mocked(readAdmission).mockResolvedValue({ reservations: f.reservations } as never);
  await expect(assertN6AcceptedSource(f.ctx, f.target)).rejects.toMatchObject({ code: "n6_source_usage_pending" });
});
