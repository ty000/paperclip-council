import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isolatedPostgres } from "./isolated-postgres.js";
import { executeMissionCommand, getMission } from "../../src/missions.js";
import { ensureMissionRepository } from "../../src/repository-occupation.js";
import { configureAdmission, readAdmission, reserveAdmission } from "../../src/admission.js";

const pg = await isolatedPostgres(), ns = pg.db.namespace;
const owner = "fixture-owner", issues = new Map<string, any>();
const ctx: any = { db: pg.db, companies: { get: async (id: string) => ({ id, defaultResponsibleUserId: owner }) },
  projects: { getPrimaryWorkspace: async () => null }, issues: { get: async (id: string) => issues.get(id),
    summaries: { getOrchestration: async ({ companyId, issueId }: any) => ({ companyId, issueId, subtreeIssueIds: [issueId], runs: [], approvals: [],
      costs: { costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } }) } } };
async function fixture() {
  const companyId = randomUUID(), missionId = randomUUID(), projectId = randomUUID(), rootIssueId = randomUUID(), rosterId = randomUUID(), revision = randomUUID();
  const aggregate = { schemaVersion: 1, companyId, missionId, rootIssueId, projectId, ownerUserId: owner, phase: "draft",
    control: { status: "inactive", reason: "mission_not_enabled" }, journal: [{ action: "mission_recorded" }], commandReceipts: [], effectIntents: [],
    modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [] } };
  await pg.sql.unsafe("INSERT INTO public.companies(id) VALUES ($1)", [companyId]);
  await pg.sql.unsafe("INSERT INTO public.projects(id) VALUES ($1)", [projectId]);
  await pg.sql.unsafe("INSERT INTO public.issues(id) VALUES ($1)", [rootIssueId]);
  await pg.sql.unsafe(`INSERT INTO ${ns}.roster_revisions(company_id,roster_id,revision,kind,name,content,created_by_user_id)
    VALUES ($1,$2,$3,'team','fixture','{}','fixture')`, [companyId, rosterId, revision]);
  await pg.sql.unsafe(`INSERT INTO ${ns}.missions(company_id,mission_id,project_id,root_issue_id,owner_user_id,team_roster_id,team_revision,council_roster_id,council_revision,aggregate)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,$8::jsonb)`, [companyId, missionId, projectId, rootIssueId, owner, rosterId, revision, JSON.stringify(aggregate)]);
  issues.set(rootIssueId, { id: rootIssueId, companyId, projectId, status: "backlog" });
  const m = (await getMission(ctx, companyId, missionId))!;
  await ensureMissionRepository(ctx, m);
  const body = { command: "abandon-unused-draft", commandId: randomUUID(), expectedVersion: m.version, reason: "Isolated receipt" };
  return { m, body, abandon: (context = ctx) => executeMissionCommand(context, { companyId, missionId, actorUserId: owner, body }) };
}
const registry = async () => (await pg.sql.unsafe(`SELECT document FROM ${ns}.repository_occupation`))[0].document;
async function envelope(companyId: string) {
  const periodKey = "isolated-retirement";
  await configureAdmission(ctx, { companyId, periodKey, commandId: randomUUID(), periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 600_000).toISOString(),
    measurement: { status: "known", source: "fixture", unit: "tokens" }, allowance: { status: "known", source: "fixture", periodUnits: 100, taskUnits: 50, knownUsageUnits: 0 },
    exposure: { status: "known", source: "fixture", units: 0 }, limits: { maxConcurrent: 2, maxCorrections: 0, maxRetries: 0 } });
  return periodKey;
}
const reservation = (companyId: string, missionId: string, periodKey: string) => ({ companyId, missionId, periodKey, expectedVersion: 1, reservationId: randomUUID(), effectId: randomUUID(), requestedUnits: 10, attempt: { kind: "initial" as const, ordinal: 0 } });
const results: Record<string, string> = {};
try {
  await pg.sql.unsafe(`CREATE TABLE public.companies(id uuid PRIMARY KEY); CREATE TABLE public.issues(id uuid PRIMARY KEY); CREATE TABLE public.projects(id uuid PRIMARY KEY); CREATE SCHEMA ${ns};`);
  for (const name of ["001_foundation_probe.sql", "002_revisioned_rosters.sql", "003_missions.sql", "005_admission.sql", "008_repository_occupation.sql"]) await pg.migration(resolve("migrations", name));
  const a = await fixture(), other = await fixture();
  const before = await registry();
  assert.equal((await a.abandon()).outcome, "applied");
  assert.equal((await a.abandon()).outcome, "replayed");
  const remaining = await registry();
  assert.deepEqual(Object.keys(remaining.holders), [`${other.m.companyId}:${other.m.missionId}`]);
  assert.deepEqual(remaining.holders[`${other.m.companyId}:${other.m.missionId}`], before.holders[`${other.m.companyId}:${other.m.missionId}`]);
  await assert.rejects(ensureMissionRepository(ctx, a.m), { code: "mission_abandoned" });
  const fresh = (await getMission(ctx, a.m.companyId, a.m.missionId))!;
  assert.equal(fresh.aggregate.phase, "draft"); assert.equal(fresh.aggregate.commandReceipts.length, 1);
  results.onlyOriginalHolderReleasedWithHistoryAndReplay = "PASS";

  // Pause before the marker CAS, then let the original activation reservation win.
  const first = await fixture(), period = await envelope(first.m.companyId);
  let announce!: () => void, resume!: () => void;
  const reached = new Promise<void>(r => { announce = r; }), continued = new Promise<void>(r => { resume = r; });
  const delayed = { ...ctx, db: { ...pg.db, execute: async (sql: string, params: unknown[]) => {
    if (sql.startsWith(`UPDATE ${ns}.missions`)) { announce(); await continued; }
    return pg.db.execute(sql, params);
  } } };
  const abandoning = first.abandon(delayed);
  const observedAbandoning = abandoning.then(() => null, error => error);
  await reached;
  await reserveAdmission(ctx, reservation(first.m.companyId, first.m.missionId, period));
  resume();
  assert.equal((await observedAbandoning).code, "unused_draft_unproven");
  assert((await registry()).holders[`${first.m.companyId}:${first.m.missionId}`]);
  assert((await getMission(ctx, first.m.companyId, first.m.missionId))!.aggregate.draftAbandonment);
  results.reservationWinsMarkerRetainedAndReleaseRefused = "PASS";

  // Hold the mission row, start the reservation statement, then commit a marker.
  // PostgreSQL must evaluate the guard on the newly locked row, not its old snapshot.
  const second = await fixture(), nextPeriod = await envelope(second.m.companyId);
  let reserveStarted!: () => void;
  const starting = new Promise<void>(r => { reserveStarted = r; });
  let pending!: Promise<unknown>;
  await pg.sql.begin(async (tx: any) => {
    await tx.unsafe(`SELECT aggregate FROM ${ns}.missions WHERE company_id=$1 AND mission_id=$2 FOR UPDATE`, [second.m.companyId, second.m.missionId]);
    const reserveCtx = { ...ctx, db: { ...pg.db, execute: async (sql: string, params: unknown[]) => {
      const operation = pg.db.execute(sql, params); reserveStarted(); return operation;
    } } };
    pending = reserveAdmission(reserveCtx, reservation(second.m.companyId, second.m.missionId, nextPeriod)).then(() => null, error => error);
    await starting;
    await tx.unsafe(`UPDATE ${ns}.missions SET aggregate = aggregate || $1::jsonb,version=version+1 WHERE company_id=$2 AND mission_id=$3`,
      [JSON.stringify({ draftAbandonment: { commandId: second.body.commandId, actorUserId: owner, reason: "isolated concurrent marker", recordedAt: new Date().toISOString() }, control: { status: "blocked", reason: "unused_draft_abandoned" } }), second.m.companyId, second.m.missionId]);
  });
  assert.equal((await pending as any).code, "version_conflict");
  assert.equal((await readAdmission(ctx, { companyId: second.m.companyId, periodKey: nextPeriod }))!.reservations.length, 0);
  results.abandonmentWinsConcurrentLockedReservationRefused = "PASS";
  console.log(JSON.stringify({ evidenceLayer: "isolated-postgresql-with-native-query-guards", results }, null, 2));
} finally { await pg.cleanup(); }
