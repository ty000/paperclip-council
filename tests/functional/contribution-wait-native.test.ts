import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionAggregate, MissionRecord } from "../../src/missions.js";
import { ensureContributionWait, finishContributionWait } from "../../src/contribution-wait.js";
import { finishN1Disposition } from "../../src/native-wake-policy.js";
import { eq } from "@council-wait-host/server/node_modules/drizzle-orm/index.js";
import { agents, authUsers, companies, companyMemberships, costEvents, createDb, heartbeatRuns, issues, projects,
  startEmbeddedPostgresTestDatabase } from "@council-wait-host/packages/db/src/index.ts";
import { issueService } from "@council-wait-host/server/src/services/issues.ts";
import { recoveryService } from "@council-wait-host/server/src/services/recovery/service.ts";
import { collectDispositionRepairSourceState } from "@council-wait-host/server/src/services/recovery/disposition-repair.ts";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb>;
const trace: unknown[] = [];
let passed = false;

beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("council-contribution-wait-db-");
  db = createDb(temporary.connectionString);
});
afterAll(async () => {
  await temporary?.cleanup();
  const path = process.env.COUNCIL_CONTRIBUTION_WAIT_EVIDENCE_PATH!;
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, `${JSON.stringify({ ...evidence, trace, databaseCleaned: true,
    outcome: passed ? "provider-free native contribution wait validated" : "failed" }, null, 2)}\n`);
});

it("reproduces the unbacked wait wake and retains a real accounting dependency until the child is done", async () => {
  const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), ownerUserId = randomUUID();
  const rootIssueId = randomUUID(), c1 = randomUUID(), c2 = randomUUID(), runId = randomUUID(), contributionId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Contribution settlement fixture", issuePrefix: "CWT", requireBoardApprovalForNewAgents: false });
  await db.insert(authUsers).values({ id: ownerUserId, name: "Fixture owner", email: `${ownerUserId}@example.invalid`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerUserId, membershipRole: "owner", status: "active" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture contribution executor", status: "idle", adapterType: "process",
    adapterConfig: { command: "/usr/bin/false" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
  await db.insert(projects).values({ id: projectId, companyId, name: "Contribution wait fixture", status: "in_progress" });
  await db.insert(issues).values([
    { id: rootIssueId, companyId, projectId, title: "Product root", status: "backlog", responsibleUserId: ownerUserId },
    { id: c1, companyId, projectId, parentId: rootIssueId, title: "C1 completed contribution", status: "done", responsibleUserId: ownerUserId },
    { id: c2, companyId, projectId, parentId: rootIssueId, title: "C2 contribution awaiting settlement", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId, originKind: "plugin:private.paperclip-council:contribution" },
  ]);
  const service = issueService(db);
  await service.update(c2, { blockedByIssueIds: [c1], status: "blocked" });
  const wakes: Array<{ agentId: string; reason: string; issueId: string }> = [];
  // The only scheduling seam is stopped before a wake can persist or execute.
  const recovery = recoveryService(db, { enqueueWakeup: async (id: string, options: any) => {
    wakes.push({ agentId: id, reason: options.reason, issueId: options.payload.issueId }); return null;
  } });
  const snapshot = async (event: string) => {
    const child = await service.getById(c2);
    const state = await collectDispositionRepairSourceState(db, { issue: child });
    const readiness = (await service.listDependencyReadiness(companyId, [c2])).get(c2);
    const result = await recovery.reconcileResolvedDependencyWakeBackstop({ companyId });
    const entry = { event, childStatus: child.status, state, readiness, result, wakes: [...wakes] };
    trace.push(entry); return entry;
  };
  const before = await snapshot("before_fix_c1_done_c2_blocked_without_accounting_dependency");
  expect(before.state.hasDurableWaitingPath).toBe(false);
  expect(before.readiness.isDependencyReady).toBe(true);
  expect(wakes).toEqual([{ agentId, reason: "issue_blockers_resolved", issueId: c2 }]);
  wakes.length = 0;

  // Match the report-time boundary: its admitted source run still executes.
  await service.update(c2, { status: "in_progress" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: c2 }, startedAt: new Date() });
  let mission = { missionId: randomUUID(), companyId, projectId, rootIssueId, version: 1,
    aggregate: { nativeWakePolicy: { protocol: "council-native-wake-v1" },
      projectMandate: { completion: { protocol: "council-proof-close-v1", result: "accepted-candidate" } },
      n1: { contributions: [{ contributionId, childIssueId: c2, assigneeAgentId: agentId, dispatchRunId: runId,
      authorRunId: runId, commit: "a".repeat(40), proof: { commit: "a".repeat(40) } }] } } } as unknown as MissionRecord;
  let createCount = 0;
  const ctx = { issues: {
    get: async (id: string, company: string) => { const issue = await service.getById(id); return issue?.companyId === company ? issue : null; },
    list: async ({ companyId: company, ...filters }: any) => service.list(company, filters),
    create: async ({ companyId: company, ...input }: any) => { createCount += 1; return service.create(company, input); },
    update: async (id: string, patch: any, company: string) => {
      expect((await service.getById(id)).companyId).toBe(company);
      if (id === c2 && patch.status === "blocked") {
        const relations = await service.getRelationSummaries(id);
        expect(relations.blockedBy.some((item: any) => item.id !== c1 && item.status === "backlog")).toBe(true);
        trace.push({ event: "native_dependency_observed_before_blocked", blockerIds: relations.blockedBy.map((item: any) => item.id) });
      }
      return service.update(id, patch);
    },
    relations: {
      get: async (id: string) => service.getRelationSummaries(id),
      addBlockers: async (id: string, additions: string[]) => {
        const previous = await service.getRelationSummaries(id);
        await service.update(id, { blockedByIssueIds: [...new Set([...previous.blockedBy.map((item: any) => item.id), ...additions])] });
        return service.getRelationSummaries(id);
      },
      removeBlockers: async (id: string, removals: string[]) => {
        expect((await service.getById(id)).status).toBe("done");
        const previous = await service.getRelationSummaries(id);
        await service.update(id, { blockedByIssueIds: previous.blockedBy.map((item: any) => item.id).filter((blocker: string) => !removals.includes(blocker)) });
        return service.getRelationSummaries(id);
      },
    },
  } } as unknown as PluginContext;
  const persist = async (current: MissionRecord, aggregate: MissionAggregate) => {
    expect(current.version).toBe(mission.version);
    mission = { ...current, aggregate, version: current.version + 1 }; return mission;
  };
  const input = { actor: { type: "agent", agentId, runId }, params: { issueId: c2 } } as PluginApiRequestInput;
  const command = { command: "record-contribution", contributionId, commit: "a".repeat(40) };
  mission = await finishN1Disposition(ctx, mission, input, command, persist);
  const blockerId = mission.aggregate.n1!.contributions[0]!.nativeWait!.issueId!;
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("running");
  expect(await service.getById(blockerId)).toMatchObject({ status: "backlog", parentId: null, assigneeAgentId: null, assigneeUserId: null });
  expect((await service.getById(c2)).status).toBe("blocked");
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  const waiting = await snapshot("after_fix_source_terminal_accounting_dependency_pending");
  expect(waiting.state).toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "blocker", hasActiveExecutionPath: false });
  expect(waiting.readiness.isDependencyReady).toBe(false);
  expect(waiting.result.notReadySkipped).toBe(1);
  expect(wakes).toHaveLength(0);
  await expect(finishContributionWait(ctx, mission, contributionId)).rejects.toMatchObject({ code: "contribution_wait_child_pending" });
  mission = await ensureContributionWait(ctx, mission, contributionId, persist);
  expect(createCount).toBe(1);

  // Proof/cost admission is covered by Council's unit suite. This native probe
  // starts closure only after that precondition and verifies its native order.
  await service.update(c2, { status: "done" });
  await finishContributionWait(ctx, mission, contributionId);
  await finishContributionWait(ctx, mission, contributionId);
  const closed = await snapshot("child_done_before_accounting_dependency_done");
  expect(closed.childStatus).toBe("done");
  expect(closed.result.checked).toBe(0);
  expect(await service.getById(blockerId)).toMatchObject({ status: "done" });
  expect((await service.getRelationSummaries(c2)).blockedBy.map((item: any) => item.id)).toEqual([c1]);
  expect(await service.listWakeableBlockedDependents(blockerId)).toEqual([]);
  expect(wakes).toHaveLength(0);
  expect(createCount).toBe(1);
  expect(await db.select().from(costEvents).where(eq(costEvents.companyId, companyId))).toHaveLength(0);
  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: runId, status: "succeeded" });
  trace.push({ event: "provider_free_boundary", fixtureRuns: 1, newRuns: 0, costRows: 0, accountingIssueCreates: createCount,
    seam: "SDK-shaped issues adapter over native issueService; recovery enqueueWakeup intercepted; no heartbeatService invocation" });
  passed = true;
});
