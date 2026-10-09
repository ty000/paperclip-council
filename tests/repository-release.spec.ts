import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { nativeRunBindings } from "../src/native-run-bindings.js";
import { releaseReconciledRepository } from "../src/repository-occupation.js";
import { reconcileRepositoryRelease } from "../src/repository-release.js";

// Keep membership reads, native bindings, uncertainty and all inventory checks real.
// Only the final registry CAS is replaced; its SQL behavior has separate receipt tests.
vi.mock("../src/repository-occupation.js", async original => ({
  ...await original<any>(), releaseReconciledRepository: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

function campaignFixture(taskCount = 2) {
  const companyId = randomUUID(), projectId = randomUUID(), rootId = randomUUID();
  const task = (issueId = randomUUID()) => ({ issueId, agentId: randomUUID(), reservationId: randomUUID(),
    runId: randomUUID(), wake: "confirmed", creation: "confirmed" });
  const members = [1, 2].map(() => {
    const rootIssueId = randomUUID();
    return { companyId, projectId, rootIssueId, missionId: randomUUID(), version: 1, aggregate: {
      schemaVersion: 1, commandReceipts: [], repositoryCampaign: { campaignRootMissionId: rootId },
      completion: { state: "closed", notification: { state: "confirmed" } },
      nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] },
      n2: { ordinary: { tasks: Array.from({ length: taskCount }, (_, i) => task(i === 0 ? rootIssueId : undefined)) } },
    } } as unknown as MissionRecord;
  });
  const root = { companyId, projectId, missionId: rootId, rootIssueId: randomUUID(), version: 1, aggregate: {
    completion: { state: "closed", notification: { state: "confirmed" } },
    nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] },
    hierarchy: { nodes: members.map(member => ({ issueId: member.rootIssueId })) },
    campaignClosure: { task: task() },
    linearContinuity: { mode: "milestone-fixed-v1", control: "active", publications: [{ acknowledgement: {}, payload: {
      campaignPlan: { schema: "council-linear-delivery-plan-v1", campaignRootMissionId: rootId,
        leaves: members.map(member => ({ sourceId: randomUUID(), nativeId: member.rootIssueId })) },
    } }] },
  } } as unknown as MissionRecord;
  const reservations = [root, ...members].flatMap(member => nativeRunBindings(member).map(binding => ({
    missionId: member.missionId, reservationId: binding.reservationId, status: "settled",
    usage: { status: "known", units: 10 }, remainingExposure: { status: "known", units: 0 },
  })));
  const envelope = { reservations, unadmittedRuns: [] as any[] };
  type Run = { id: string; issueId: string; agentId: string; status: string };
  const runs = new Map([root, ...members].flatMap(member => nativeRunBindings(member).map((binding): [string, Run[]] => [binding.issueId,
    [{ id: binding.runId!, issueId: binding.issueId, agentId: binding.agentId, status: "succeeded" }]])));
  const issues = new Map([root.rootIssueId, ...runs.keys()].map(id => [id,
    { id, companyId, projectId, status: "done", checkoutRunId: null as string | null, executionRunId: null as string | null }]));
  const getOrchestration = vi.fn(async ({ issueId }: { issueId: string }) => ({ companyId, issueId, runs: runs.get(issueId) ?? [] }));
  const ctx = { db: { namespace: "test", query: async (sql: string, parameters: string[]) => sql.includes("admission_envelopes")
    ? [{ document: envelope }] : members.filter(member => sql.includes("aggregate->") || member.missionId === parameters[1])
      .map(member => ({ company_id: member.companyId, mission_id: member.missionId, project_id: member.projectId,
        root_issue_id: member.rootIssueId, aggregate: member.aggregate, version: member.version, created_at: new Date(), updated_at: new Date() })) },
    issues: { get: async (id: string) => issues.get(id), summaries: { getOrchestration } } } as any;
  return { ctx, root, members, envelope, runs, issues, getOrchestration };
}

it("releases only the closed campaign after proving its reviewer and both members under their own reservations", async () => {
  const f = campaignFixture();
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
  for (const issueId of f.issues.keys()) {
    expect(f.getOrchestration).toHaveBeenCalledWith(expect.objectContaining({ issueId, includeSubtree: false }));
  }
  expect(releaseReconciledRepository).toHaveBeenCalledExactlyOnceWith(f.ctx, f.root);
});

it("retains the per-mission inventory bound when the complete campaign exceeds 64 native issues", async () => {
  const f = campaignFixture(40);
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
  expect(new Set(f.getOrchestration.mock.calls.map(([input]) => input.issueId)).size).toBe(82);
});

it.each([
  "active run", "foreign run", "missing run", "wrong agent", "duplicate run", "wrong issue",
  "missing reservation", "wrong reservation owner", "unsettled reservation", "unknown usage", "remaining exposure",
  "unadmitted run", "native lock", "uncertain effect", "pending wake", "unacknowledged publication", "incomplete member",
])("retains campaign occupation when a member has %s", async failure => {
  const f = campaignFixture(), member = f.members[0]!, binding = nativeRunBindings(member)[0]!;
  const runs = f.runs.get(binding.issueId)!, reservation = f.envelope.reservations.find(r => r.reservationId === binding.reservationId)!;
  const firstTask = member.aggregate.n2!.ordinary!.tasks[0]!;
  const mutations: Record<string, () => unknown> = {
    "active run": () => { runs[0]!.status = "running"; },
    "foreign run": () => runs.push({ ...runs[0]!, id: randomUUID() }),
    "missing run": () => runs.pop(),
    "wrong agent": () => { runs[0]!.agentId = randomUUID(); },
    "duplicate run": () => runs.push({ ...runs[0]! }),
    "wrong issue": () => { runs[0]!.issueId = f.root.rootIssueId; },
    "missing reservation": () => f.envelope.reservations.splice(f.envelope.reservations.indexOf(reservation), 1),
    "wrong reservation owner": () => { reservation.missionId = f.root.missionId; },
    "unsettled reservation": () => { reservation.status = "unsettled"; },
    "unknown usage": () => { reservation.usage.status = "unknown"; },
    "remaining exposure": () => { reservation.remainingExposure.units = 1; },
    "unadmitted run": () => f.envelope.unadmittedRuns.push({ missionId: member.missionId, runId: randomUUID() }),
    "native lock": () => { f.issues.get(member.rootIssueId)!.checkoutRunId = binding.runId!; },
    "uncertain effect": () => { member.aggregate.n5 = { publication: { creation: "claimed", issueId: null } } as any; },
    "pending wake": () => { firstTask.runId = null; firstTask.wake = "claimed"; },
    "unacknowledged publication": () => { member.aggregate.linearContinuity = { publications: [{ payload: {} }] } as any; },
    "incomplete member": () => { member.aggregate.completion!.state = "closing"; },
  };
  mutations[failure]!();
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(false);
  expect(releaseReconciledRepository).not.toHaveBeenCalled();
});

it.each(["missing member", "foreign member", "duplicate member", "wrong project", "wrong campaign"])("refuses release for %s", async failure => {
  const f = campaignFixture();
  if (failure === "missing member") f.members.pop();
  if (failure === "foreign member") f.members[0]!.rootIssueId = randomUUID();
  if (failure === "duplicate member") f.members[1] = f.members[0]!;
  if (failure === "wrong project") f.members[0]!.projectId = randomUUID();
  if (failure === "wrong campaign") f.members[0]!.aggregate.repositoryCampaign!.campaignRootMissionId = randomUUID();
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(false);
  expect(releaseReconciledRepository).not.toHaveBeenCalled();
});

it.each(["foreign run", "missing reviewer run"])("keeps root inventory strict after delegating member issues: %s", async failure => {
  const f = campaignFixture();
  const binding = nativeRunBindings(f.root)[0]!;
  if (failure === "foreign run") f.runs.set(f.root.rootIssueId, [{ id: randomUUID(), issueId: f.root.rootIssueId, agentId: randomUUID(), status: "succeeded" }]);
  if (failure === "missing reviewer run") f.runs.delete(binding.issueId);
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(false);
  expect(releaseReconciledRepository).not.toHaveBeenCalled();
});

it("releases a cancelled campaign with only the already admitted, safely stopped subset of its plan", async () => {
  const f = campaignFixture();
  delete f.root.aggregate.completion;
  f.root.aggregate.linearContinuity!.control = "cancelled";
  const removed = f.members.pop()!;
  // The other planned leaf has never been admitted and has no runs or reservations.
  for (const binding of nativeRunBindings(removed)) f.runs.delete(binding.issueId);
  f.envelope.reservations = f.envelope.reservations.filter(r => r.missionId !== removed.missionId);
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
  expect(releaseReconciledRepository).toHaveBeenCalledExactlyOnceWith(f.ctx, f.root);
});

it.each(["done", "blocked"])("releases partial cancellation with historical %s technical tasks without rewriting their status", async status => {
  const f = campaignFixture();
  delete f.root.aggregate.completion;
  f.root.aggregate.linearContinuity!.control = "cancelled";
  const partial = f.members[1]!;
  delete partial.aggregate.completion;
  f.issues.get(partial.rootIssueId)!.status = "cancelled";
  const historical = nativeRunBindings(partial)[1]!.issueId;
  f.issues.get(historical)!.status = status;
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
  expect(f.issues.get(historical)!.status).toBe(status);
  expect(releaseReconciledRepository).toHaveBeenCalledExactlyOnceWith(f.ctx, f.root);
});

it.each(["pending task", "active run", "unknown run", "unknown usage", "remaining exposure", "uncertain merge"])("retains cancelled campaign occupation for %s", async reason => {
  const f = campaignFixture();
  delete f.root.aggregate.completion;
  f.root.aggregate.linearContinuity!.control = "cancelled";
  const partial = f.members[1]!;
  delete partial.aggregate.completion;
  f.issues.get(partial.rootIssueId)!.status = "cancelled";
  const binding = nativeRunBindings(partial)[1]!;
  f.issues.get(binding.issueId)!.status = "blocked";
  if (reason === "pending task") f.issues.get(partial.rootIssueId)!.status = "blocked";
  if (reason === "active run") f.runs.get(binding.issueId)![0]!.status = "running";
  if (reason === "unknown run") f.runs.get(binding.issueId)!.push({ id: randomUUID(), issueId: binding.issueId, agentId: binding.agentId, status: "succeeded" });
  const reservation = f.envelope.reservations.find(item => item.reservationId === binding.reservationId)!;
  if (reason === "unknown usage") reservation.usage.status = "unknown";
  if (reason === "remaining exposure") reservation.remainingExposure.units = 1;
  if (reason === "uncertain merge") partial.aggregate.n5 = { integration: { mergeClaimedAt: new Date().toISOString(), state: "unknown" } } as any;
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(false);
  expect(releaseReconciledRepository).not.toHaveBeenCalled();
});

it("preserves cancellation before a campaign plan or any member exists", async () => {
  const f = campaignFixture();
  delete f.root.aggregate.completion;
  delete f.root.aggregate.hierarchy;
  f.root.aggregate.linearContinuity!.control = "cancelled";
  f.root.aggregate.linearContinuity!.publications = [];
  f.members.length = 0;
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
});

it("preserves release of an ordinary closed mission", async () => {
  const f = campaignFixture();
  delete f.root.aggregate.linearContinuity;
  delete f.root.aggregate.hierarchy;
  await expect(reconcileRepositoryRelease(f.ctx, f.root)).resolves.toBe(true);
  expect(releaseReconciledRepository).toHaveBeenCalledExactlyOnceWith(f.ctx, f.root);
});
