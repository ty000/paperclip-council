import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { getMission } from "../src/missions.js";
import { reserveN2Run } from "../src/n2-missions.js";
import { reconcileN5, startN5Publication } from "../src/n5-runtime.js";

// Keep claimVariantWake, project/repository guards, native bindings and mission CAS
// real. Admission is already authorized; emulate only the host's storage and effects.
vi.mock("../src/n2-missions.js", async original => ({ ...await original<any>(), reserveN2Run: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), missionId = randomUUID(), rootIssueId = randomUUID();
  const issueId = randomUUID(), intentId = randomUUID(), reservationId = randomUUID();
  let current = { companyId, projectId, missionId, rootIssueId, ownerUserId: randomUUID(), version: 1, aggregate: {
    schemaVersion: 1, commandReceipts: [], n5: {
      authority: { publisherAgentId: randomUUID(), repository: "owner/repo", baseRef: "main", headRef: "codex/delivery" },
      publication: { intentId, reservationId, issueId, runId: null, creation: "confirmed", wake: "pending", state: "pending" },
    },
  } } as unknown as MissionRecord;
  const timeline: string[] = [];
  let driftOnGuard = false, failClaim = false;
  const row = () => ({ company_id: companyId, project_id: projectId, mission_id: missionId, root_issue_id: rootIssueId,
    owner_user_id: current.ownerUserId, version: current.version, aggregate: structuredClone(current.aggregate),
    created_at: new Date(), updated_at: new Date() });
  const ctx = {
    db: { namespace: "test", query: vi.fn(async (sql: string) => {
      if (sql.includes("repository_occupation")) return [{ version: 1, document: { initialized: true, holders: {
        [`${companyId}:${missionId}`]: { companyId, projectId, missionId, repository: "github.com/owner/repo", exclusive: false },
      } } }];
      if (sql.includes("SELECT version, aggregate")) {
        timeline.push(`guard:${current.aggregate.n5!.publication!.wake}`);
        if (driftOnGuard) { driftOnGuard = false; current = { ...current, version: current.version + 1 }; }
      }
      return [row()];
    }), execute: vi.fn(async (_sql: string, parameters: unknown[]) => {
      const aggregate = JSON.parse(parameters[0] as string) as MissionRecord["aggregate"];
      if (parameters[3] !== current.version) return { rowCount: 0 };
      if (failClaim && aggregate.n5!.publication!.wake === "claimed") { failClaim = false; return { rowCount: 0 }; }
      timeline.push(`cas:${aggregate.n5!.publication!.wake}`);
      current = { ...current, version: current.version + 1, aggregate };
      return { rowCount: 1 };
    }) },
    projects: { getPrimaryWorkspace: vi.fn(async () => ({ repoUrl: "https://github.com/owner/repo" })) },
    issues: {
      update: vi.fn(async () => {
        expect(current.aggregate.n5!.publication!.wake).toBe("claimed");
        timeline.push("todo");
      }),
      requestWakeup: vi.fn(async () => {
        expect(current.aggregate.n5!.publication!.wake).toBe("claimed");
        timeline.push("wake");
        return { runId: randomUUID() };
      }),
    },
  } as any;
  return { ctx, mission: () => current, timeline, issueId, intentId, reservationId,
    drift: () => { driftOnGuard = true; }, failClaim: () => { failClaim = true; } };
}

it("retries a fixed-profile publisher under its original identity after the native repository guard rejects a stale mission", async () => {
  const f = fixture(); f.drift();
  await expect(startN5Publication(f.ctx, f.mission())).rejects.toMatchObject({ code: "repository_mission_changed" });
  expect(f.mission().aggregate.n5!.publication).toMatchObject({ wake: "pending", runId: null,
    intentId: f.intentId, reservationId: f.reservationId, issueId: f.issueId });
  expect(f.ctx.db.execute).not.toHaveBeenCalled();
  expect(f.ctx.issues.update).not.toHaveBeenCalled();
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();

  const fresh = await getMission(f.ctx, f.mission().companyId, f.mission().missionId);
  const resumed = await reconcileN5(f.ctx, fresh!);
  expect(resumed.aggregate.n5!.publication).toMatchObject({ intentId: f.intentId, reservationId: f.reservationId, issueId: f.issueId, wake: "claimed" });
  expect(resumed.aggregate.n5!.publication!.runId).toBeTruthy();
  expect(resumed.aggregate.modelSelection).toBeUndefined();
  expect(f.timeline).toEqual(["guard:pending", "guard:pending", "cas:claimed", "todo", "wake", "cas:claimed"]);
  expect(f.ctx.issues.requestWakeup).toHaveBeenCalledExactlyOnceWith(f.issueId, resumed.companyId,
    expect.objectContaining({ idempotencyKey: `council:n5:${f.intentId}` }));
  expect(vi.mocked(reserveN2Run).mock.calls.every(call => call[2].reservationId === f.reservationId && call[2].effectId === f.intentId)).toBe(true);
});

it("retains a pending publisher when its pre-effect claim CAS fails and can retry that same intent", async () => {
  const f = fixture(); f.failClaim();
  await expect(startN5Publication(f.ctx, f.mission())).rejects.toMatchObject({ code: "version_conflict" });
  expect(f.mission().aggregate.n5!.publication!.wake).toBe("pending");
  expect(f.ctx.issues.update).not.toHaveBeenCalled();
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  await reconcileN5(f.ctx, f.mission());
  expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  expect(f.mission().aggregate.n5!.publication!.intentId).toBe(f.intentId);
});

it.each(["todo response lost", "wake response lost", "null wake readback"])("never rewakes an uncertain fixed-profile publisher after %s", async failure => {
  const f = fixture();
  if (failure === "todo response lost") f.ctx.issues.update.mockRejectedValueOnce(new Error(failure));
  if (failure === "wake response lost") f.ctx.issues.requestWakeup.mockRejectedValueOnce(new Error(failure));
  if (failure === "null wake readback") f.ctx.issues.requestWakeup.mockResolvedValueOnce({ runId: null });
  if (failure === "null wake readback") await startN5Publication(f.ctx, f.mission());
  else await expect(startN5Publication(f.ctx, f.mission())).rejects.toThrow(failure);
  expect(f.mission().aggregate.n5!.publication).toMatchObject({ wake: "claimed", runId: null });
  const wakeCount = f.ctx.issues.requestWakeup.mock.calls.length;
  await reconcileN5(f.ctx, f.mission());
  await startN5Publication(f.ctx, f.mission());
  expect(f.ctx.issues.update).toHaveBeenCalledTimes(1);
  expect(f.ctx.issues.requestWakeup).toHaveBeenCalledTimes(wakeCount);
  expect(reserveN2Run).toHaveBeenCalledTimes(1);
});

it("does not reinterpret a historical fixed-profile claim without a run as permission to wake", async () => {
  const f = fixture(); f.mission().aggregate.n5!.publication!.wake = "claimed";
  await reconcileN5(f.ctx, f.mission());
  expect(f.ctx.issues.update).not.toHaveBeenCalled();
  expect(f.ctx.issues.requestWakeup).not.toHaveBeenCalled();
  expect(reserveN2Run).not.toHaveBeenCalled();
});
