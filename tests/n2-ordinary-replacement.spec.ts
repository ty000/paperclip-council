import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
vi.mock("../src/decision-adapter.js", async original => ({ ...await original(), councilNativeRequest: vi.fn() }));
import { councilNativeRequest } from "../src/decision-adapter.js";
import { handleMissionApi } from "../src/missions.js";
import { ordinaryTask } from "../src/n2-ordinary-state.js";
import { configureAdmission, reserveAdmission } from "../src/admission.js";
import { nativeAdmissionConfiguration, settleOrdinaryRunUsage } from "../src/g4-native.js";

async function fixture() {
  const company = randomUUID(), mission = randomUUID(), owner = randomUUID(), agent = randomUUID(), submissionId = randomUUID();
  const task = { ...ordinaryTask("specialist", submissionId, agent, randomUUID()), issueId: randomUUID(), runId: randomUUID(),
    creation: "confirmed" as const, wake: "claimed" as const, settledAt: new Date().toISOString() };
  const subject = { submissionId, candidateCommit: "a".repeat(40), bundleSha256: "b".repeat(64), evidenceRevision: 1, mandateHash: "c".repeat(64) };
  const next = ordinaryTask("specialist", submissionId, randomUUID(), randomUUID());
  const aggregate: any = { phase: "review_handoff", control: { status: "active" }, readiness: { blockers: [] },
    responsibilities: { integrationLeadAgentId: randomUUID(), finalReviewerAgentId: randomUUID() }, compositions: { council: { members: [] } },
    schemaVersion: 1, commandReceipts: [], journal: [], n2: { status: "review_handoff", activeSubmissionId: submissionId,
    submissions: [subject], rounds: [], ordinary: { protocol: "ordinary-cli-v1", tasks: [task, next] } },
    n3: { rounds: [{ review: { subject, opinions: [], slots: [] }, specialists: [] }] } };
  let row: any = { company_id: company, mission_id: mission, owner_user_id: owner, aggregate, version: 37,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  let ledger: any;
  const effects: string[] = [];
  const profile = { kind: "paperclip-orchestration-tokens-v1" as const, periodKey: "replacement-test", periodStart: new Date(Date.now() - 60000).toISOString(),
    periodEnd: new Date(Date.now() + 60000).toISOString(), periodAllowanceUnits: 10000, runReservationUnits: 1000,
    initialKnownUsageUnits: 0, initialExposureUnits: 0, initialTokenAccountingSource: "replacement-test", maxCorrections: 1 as const };
  const ctx = { config: { get: async () => ({ n1OperatingProfile: profile }) }, companies: { get: async () => ({ defaultResponsibleUserId: owner }) },
    agents: { get: async () => ({ status: "idle", adapterType: "codex_local", adapterConfig: { engine: "cli" } }) },
    db: { namespace: "plugin_test", query: async (sql: string) => sql.includes(".admission_envelopes") ? ledger ? [structuredClone(ledger)] : [] : [structuredClone(row)],
      execute: async (sql: string, p: any[]) => {
        if (sql.includes(".admission_envelopes")) {
          if (sql.startsWith("INSERT")) ledger = { company_id: company, period_key: profile.periodKey, version: 1, document: JSON.parse(p[2]), created_at: row.created_at, updated_at: row.updated_at };
          else { if (ledger.version !== p[3]) return { rowCount: 0 }; ledger.document = JSON.parse(p[2]); ledger.version++; effects.push("reserve-or-settle"); }
        } else { if (row.version !== p[3]) return { rowCount: 0 }; row = { ...row, aggregate: JSON.parse(p[0]), version: row.version + 1 }; effects.push("mission-cas"); }
        return { rowCount: 1 };
      } },
    issues: { update: async () => { effects.push("issue-update"); }, create: async () => { effects.push("create"); return { id: randomUUID() }; },
      requestWakeup: async () => { effects.push("wake"); return { runId: randomUUID() }; } } } as unknown as PluginContext;
  const run: any = { id: task.runId, companyId: company, agentId: agent, nativeIssueId: null, contextSnapshot: { issueId: task.issueId },
    status: "succeeded", startedAt: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString(), usageJson: { usageSource: "per_run", inputTokens: 100, outputTokens: 10 } };
  vi.mocked(councilNativeRequest).mockImplementation(async () => ({ status: 200, body: run }));
  await configureAdmission(ctx, nativeAdmissionConfiguration(profile, company, randomUUID()));
  await reserveAdmission(ctx, { companyId: company, periodKey: profile.periodKey, missionId: mission, effectId: task.taskId,
    reservationId: task.reservationId, requestedUnits: 1000, attempt: { kind: "initial", ordinal: 0 }, expectedVersion: 1 });
  await settleOrdinaryRunUsage(ctx, { companyId: company, issueId: task.issueId, agentId: agent, runId: task.runId,
    commandId: task.settlementCommandId, periodKey: profile.periodKey, reservationId: task.reservationId, expectedVersion: 2 });
  effects.length = 0;
  const body: any = { command: "replace-missing-opinion", commandId: randomUUID(), expectedVersion: 37, taskId: task.taskId,
    runId: task.runId, submissionId, candidateCommit: subject.candidateCommit, reason: "Explicit one-time operator-error recovery", authorizeOneReplacement: true };
  const call = (b = body, user: string = owner) => handleMissionApi({ routeKey: "mission-command", method: "POST", companyId: company,
    params: { companyId: company, missionId: mission }, query: {}, headers: {}, path: "", actor: { actorType: "user", actorId: user, userId: user }, body: b }, ctx);
  return { ctx, call, body, task, run, profile, effects, row: () => row, ledger: () => ledger };
}

it("preserves the missing task and costs, reserves resume with a durable grant, and replays without duplicate wake", async () => {
  const f = await fixture(); const original = structuredClone(f.ledger().document.reservations[0]);
  expect((await f.call()).status).toBe(200); expect(f.effects).toEqual(["mission-cas"]);
  const tasks = f.row().aggregate.n2.ordinary.tasks; expect(tasks).toHaveLength(3); expect(tasks[0]).toMatchObject({ runId: f.task.runId, replacedBy: tasks[1].taskId });
  expect(tasks[1]).toMatchObject({ agentId: f.task.agentId, slotId: f.task.slotId, replacementOf: f.task.taskId });
  expect((await f.call()).status).toBe(200); expect(f.effects).toEqual(["mission-cas"]);
  expect((await f.call({ command: "reconcile-ordinary-n2" })).status).toBe(200);
  expect(f.effects.indexOf("reserve-or-settle")).toBeLessThan(f.effects.indexOf("wake"));
  expect(f.ledger().document.limits.maxRetries).toBe(0);
  expect(f.ledger().document.reservations[1]).toMatchObject({ attempt: { kind: "resume", ordinal: 1 }, ownerReplacementCommandId: f.body.commandId });
  expect(f.ledger().document.reservations[0]).toEqual(original);
  expect((await f.call()).status).toBe(200); expect(f.effects.filter(x => x === "wake")).toHaveLength(1);
});
it.each(["owner", "candidate", "opinion", "active", "unknown", "second"])("refuses %s without replacement effects", async kind => {
  const f = await fixture(); let owner: string | undefined;
  if (kind === "owner") owner = randomUUID();
  if (kind === "candidate") f.body.candidateCommit = "d".repeat(40);
  if (kind === "opinion") f.row().aggregate.n3.rounds[0].review.opinions.push({ slotId: f.task.slotId });
  if (kind === "active") f.run.status = "running";
  if (kind === "unknown") f.run.usageJson = null;
  if (kind === "second") f.row().aggregate.n2.ordinary.missingOpinionReplacement = {};
  expect((await f.call(f.body, owner)).status).toBeGreaterThanOrEqual(400);expect(f.effects).toEqual([]);
});
it("does not accept a fabricated or cross-reservation exception", async () => {
  const f = await fixture();
  const input = { companyId: f.row().company_id, periodKey: f.profile.periodKey, missionId: f.row().mission_id,
    reservationId: randomUUID(), effectId: randomUUID(), requestedUnits: 1000, attempt: { kind: "resume" as const, ordinal: 1 },
    ownerReplacementCommandId: f.body.commandId, expectedVersion: f.ledger().version };
  await expect(reserveAdmission(f.ctx, input)).rejects.toMatchObject({ code: "owner_replacement_grant_required" });
  expect((await f.call()).status).toBe(200);
  await expect(reserveAdmission(f.ctx, input)).rejects.toMatchObject({ code: "owner_replacement_grant_required" });
  expect(f.ledger().document.reservations).toHaveLength(1);
});
