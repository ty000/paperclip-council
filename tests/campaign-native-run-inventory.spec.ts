import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { readAdmission, recordUnadmittedRun } from "../src/admission.js";
import { readNativeG4Profile } from "../src/g4-native.js";
import { nativeRunBindings } from "../src/native-run-bindings.js";
import { settleLinearSafePoint } from "../src/linear-continuity-control.js";
import { nativeN2Profile } from "../src/n2-missions.js";
import { prepareVariantLaunch } from "../src/model-runtime.js";

vi.mock("../src/admission.js", async original => ({ ...await original<any>(), readAdmission: vi.fn(), recordUnadmittedRun: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original<any>(), readNativeG4Profile: vi.fn() }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original<any>(), nativeN2Profile: vi.fn() }));
// Authority is exercised separately. Keep the complete native inventory and membership path real here.
vi.mock("../src/project-mandate-guard.js", async original => ({ ...await original<any>(), assertProjectDeparture: vi.fn() }));

beforeEach(() => vi.resetAllMocks());

function campaignFixture() {
  const companyId = randomUUID(), projectId = randomUUID(), rootId = randomUUID(), reviewer = randomUUID();
  const members = [1, 2].map(() => ({ companyId, projectId, missionId: randomUUID(), rootIssueId: randomUUID(), aggregate: {
    schemaVersion: 1, commandReceipts: [], repositoryCampaign: { campaignRootMissionId: rootId }, completion: { state: "closed", notification: { state: "confirmed" } },
    nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] },
    n2: { ordinary: { tasks: Array.from({ length: 40 }, () => ({ issueId: randomUUID(), agentId: randomUUID(),
      reservationId: randomUUID(), runId: randomUUID(), wake: "confirmed", creation: "confirmed" })) } },
  } } as unknown as MissionRecord));
  const root = { companyId, projectId, missionId: rootId, rootIssueId: randomUUID(), aggregate: {
    nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [], runLimit: 1 },
    hierarchy: { nodes: members.map(member => ({ issueId: member.rootIssueId })) },
    campaignClosure: { task: { issueId: null } },
    linearContinuity: { mode: "milestone-fixed-v1", publications: [{ payload: { campaignPlan: { schema: "council-linear-delivery-plan-v1",
      campaignRootMissionId: rootId, leaves: members.map(member => ({ sourceId: randomUUID(), nativeId: member.rootIssueId })) } } }] },
  } } as unknown as MissionRecord;
  const reservations = members.flatMap(member => nativeRunBindings(member).map(binding => ({
    missionId: member.missionId, reservationId: binding.reservationId, status: "settled",
    usage: { status: "known", units: 100 }, remainingExposure: { status: "known", units: 0 },
  })));
  const envelope = { reservations, unadmittedRuns: [] };
  type ObservedRun = { id: string; issueId: string; agentId: string; status: string };
  const runs = new Map(members.flatMap(member => nativeRunBindings(member).map((binding): [string, ObservedRun[]] => [binding.issueId,
    [{ id: binding.runId!, issueId: binding.issueId, agentId: binding.agentId, status: "succeeded" }]])));
  const getOrchestration = vi.fn(async ({ issueId }: { issueId: string }) => ({ companyId, issueId, runs: runs.get(issueId) ?? [] }));
  const ctx = { db: { namespace: "test", query: async (sql: string, parameters: string[]) => sql.includes("admission_envelopes")
    ? [{ document: envelope }] : members.filter(member => sql.includes("aggregate->") || member.missionId === parameters[1])
      .map(member => ({ company_id: companyId, mission_id: member.missionId, project_id: projectId,
        root_issue_id: member.rootIssueId, aggregate: member.aggregate, version: 1, created_at: new Date(), updated_at: new Date() })) },
    issues: { get: async (id: string) => ({ id, companyId, projectId, status: "done", checkoutRunId: null, executionRunId: null }),
      summaries: { getOrchestration } } } as any;
  vi.mocked(readAdmission).mockResolvedValue(envelope as never);
  vi.mocked(readNativeG4Profile).mockResolvedValue({ periodKey: "period" } as never);
  vi.mocked(nativeN2Profile).mockResolvedValue({ envelope, profile: { periodKey: "period" } } as never);
  const launch = () => prepareVariantLaunch(ctx, root, { taskKey: "campaign-global-review", interventionKey: "reviewer",
    launchKey: randomUUID(), logicalAgentId: reviewer, family: "review", expectedRoles: ["generalist-reviewer"] });
  return { ctx, root, members, envelope, runs, getOrchestration, launch };
}

it("allows a root review only after observing actual settled member runs under their original reservations", async () => {
  const f = campaignFixture();
  await expect(f.launch()).resolves.toMatchObject({ binding: null });
  for (const issueId of [...f.runs.keys(), ...f.members.map(member => member.rootIssueId), f.root.rootIssueId]) {
    expect(f.getOrchestration).toHaveBeenCalledWith(expect.objectContaining({ issueId, includeSubtree: false }));
  }
  expect(recordUnadmittedRun).not.toHaveBeenCalled();
});

it.each(["missing reservation", "active run", "foreign run"])("holds root review for a member with %s", async failure => {
  const f = campaignFixture(), [issueId, runs] = [...f.runs.entries()][0]!;
  if (failure === "missing reservation") f.envelope.reservations.shift();
  if (failure === "active run") runs[0]!.status = "running";
  if (failure === "foreign run") runs.push({ ...runs[0]!, id: randomUUID(), issueId });
  await expect(f.launch()).rejects.toMatchObject({ code: failure === "active run" ? "campaign_review_members" : "unadmitted_native_run" });
});

it("recognizes the admitted first leaf during a pause before the remaining planned leaf exists", async () => {
  const f = campaignFixture();
  delete f.root.aggregate.campaignClosure;
  f.root.aggregate.linearContinuity!.control = "pause_requested";
  f.members.pop();
  const runs = [...f.runs.values()][0]!;
  runs[0]!.status = "running";
  await expect(settleLinearSafePoint(f.ctx, f.root)).resolves.toMatchObject({ safe: false });
  expect(f.getOrchestration).toHaveBeenCalledWith(expect.objectContaining({ issueId: runs[0]!.issueId }));
  expect(recordUnadmittedRun).not.toHaveBeenCalled();
});
