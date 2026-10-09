import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../../src/missions.js";
import { ensureMissionRepository } from "../../src/repository-occupation.js";
import { reconcileRepositoryRelease } from "../../src/repository-release.js";
import { assertProjectDeparture } from "../../src/project-mandate-guard.js";
import { isolatedPostgres } from "./isolated-postgres.js";

if (process.argv.includes("--restart-child")) {
  const requireDb = createRequire(resolve(process.env.PAPERCLIP_TEST_HOST_ROOT!, "packages/db/package.json"));
  const sql = requireDb("postgres")(JSON.parse(process.env.REPOSITORY_TEST_CONNECTION!));
  requireDb("drizzle-orm/postgres-js").drizzle(sql);
  const ctx = { db: { namespace: process.env.REPOSITORY_TEST_NAMESPACE!,
    query: async (statement: string, params: unknown[] = []) => Array.from(await sql.unsafe(statement, params)),
    execute: async (statement: string, params: unknown[] = []) => ({ rowCount: (await sql.unsafe(statement, params)).count }) },
    projects: { getPrimaryWorkspace: async () => ({ repoUrl: "https://github.com/owner/repo.git" }) } } as unknown as PluginContext;
  try { await ensureMissionRepository(ctx, JSON.parse(process.env.REPOSITORY_TEST_MISSION!), true); }
  finally { await sql.end({ timeout: 2 }); }
} else {
  const pg = await isolatedPostgres(), ns = pg.db.namespace;
  const repositories = new Map<string, string | null>(), missions = new Map<string, MissionRecord>();
  const inventories = new Map<string, any[]>(), locks = new Set<string>();
  const ctx = { db: pg.db, projects: { getPrimaryWorkspace: async (id: string) => ({ repoUrl: repositories.get(id) ?? null }) },
    issues: { get: async (id: string, companyId: string) => {
      const m = [...missions.values()].find(m => m.rootIssueId === id);
      return m ? { id, companyId, projectId: m.projectId, status: "cancelled", checkoutRunId: locks.has(id) ? randomUUID() : null } : null;
    }, summaries: { getOrchestration: async ({ companyId, issueId }: any) => ({ companyId, issueId, runs: inventories.get(issueId) ?? [] }) } } } as unknown as PluginContext;
  const results: Record<string, string> = {};
  async function subject(repository: string | null = "https://github.com/owner/repo.git", legacy = false) {
    const companyId = randomUUID(), missionId = randomUUID(), projectId = randomUUID(), rootIssueId = randomUUID();
    const m = { companyId, missionId, projectId, rootIssueId, version: 1, ownerUserId: "fixture-owner",
      aggregate: { schemaVersion: 1, phase: "draft", commandReceipts: [], responsibilities: {}, effectIntents: [] } } as unknown as MissionRecord;
    repositories.set(projectId, repository); missions.set(missionId, m);
    if (legacy) await persist(m);
    return m;
  }
  async function persist(m: MissionRecord) {
    const rosterId = randomUUID(), revision = randomUUID();
    await pg.sql.unsafe("INSERT INTO public.companies(id) VALUES ($1) ON CONFLICT DO NOTHING", [m.companyId]);
    await pg.sql.unsafe("INSERT INTO public.projects(id) VALUES ($1) ON CONFLICT DO NOTHING", [m.projectId]);
    await pg.sql.unsafe("INSERT INTO public.issues(id) VALUES ($1) ON CONFLICT DO NOTHING", [m.rootIssueId]);
    await pg.sql.unsafe(`INSERT INTO ${ns}.roster_revisions(company_id,roster_id,revision,kind,name,content,created_by_user_id)
      VALUES ($1,$2,$3,'team','fixture','{}','fixture')`, [m.companyId, rosterId, revision]);
    await pg.sql.unsafe(`INSERT INTO ${ns}.missions(company_id,mission_id,project_id,root_issue_id,owner_user_id,team_roster_id,team_revision,council_roster_id,council_revision,aggregate)
      VALUES ($1,$2,$3,$4,'fixture-owner',$5,$6,$5,$6,$7::jsonb)`, [m.companyId,m.missionId,m.projectId,m.rootIssueId,rosterId,revision,JSON.stringify(m.aggregate)]);
  }
  async function update(m: MissionRecord) {
    m.version++;
    await pg.sql.unsafe(`UPDATE ${ns}.missions SET aggregate=$1::jsonb,version=$2 WHERE mission_id=$3`, [JSON.stringify(m.aggregate),m.version,m.missionId]);
  }
  async function reset() {
    await pg.sql.unsafe(`DELETE FROM ${ns}.missions`);
    await pg.sql.unsafe(`DELETE FROM ${ns}.admission_envelopes`);
    await pg.sql.unsafe(`UPDATE ${ns}.repository_occupation SET document='{"initialized":false,"holders":{}}'::jsonb,version=version+1`);
    missions.clear(); repositories.clear(); inventories.clear(); locks.clear();
  }
  async function registry() { return (await pg.sql.unsafe(`SELECT document FROM ${ns}.repository_occupation`))[0].document; }
  async function cancelled(m: MissionRecord) {
    m.aggregate.linearContinuity = { mode: "milestone-fixed-v1", control: "cancelled", publications: [] } as any;
    await update(m);
  }
  try {
    await pg.sql.unsafe(`CREATE TABLE public.companies(id uuid PRIMARY KEY); CREATE TABLE public.issues(id uuid PRIMARY KEY); CREATE TABLE public.projects(id uuid PRIMARY KEY); CREATE SCHEMA ${ns};`);
    for (const file of ["001_foundation_probe.sql", "002_revisioned_rosters.sql", "003_missions.sql", "005_admission.sql"]) await pg.migration(resolve("migrations", file));
    const legacy = await subject("git@github.com:OWNER/repo.git", true);
    const original = JSON.stringify(legacy.aggregate);
    await pg.migration(resolve("migrations/008_repository_occupation.sql"));
    assert.deepEqual((await pg.sql.unsafe(`SELECT aggregate FROM ${ns}.missions WHERE mission_id=$1`, [legacy.missionId]))[0].aggregate, JSON.parse(original));
    const firstCampaign = await subject();
    await assert.rejects(ensureMissionRepository(ctx, firstCampaign, true), { code: "repository_occupied" });
    assert.equal(Object.keys((await registry()).holders).length, 1);
    results.additiveMigrationAndLegacyOrdinaryBlocksFirstCampaign = "PASS";

    await reset();
    const ordinary = await subject(), campaign = await subject();
    const concurrent = await Promise.allSettled([ensureMissionRepository(ctx, ordinary), ensureMissionRepository(ctx, campaign, true)]);
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(Object.keys((await registry()).holders).length, 1);
    results.concurrentOrdinaryVersusFirstCampaign = "PASS";

    await reset();
    const contenders = await Promise.all(Array.from({ length: 16 }, () => subject()));
    const racing = await Promise.allSettled(contenders.map(m => ensureMissionRepository(ctx, m, true)));
    assert.equal(racing.filter(r => r.status === "fulfilled").length, 1);
    const winner = contenders[racing.findIndex(r => r.status === "fulfilled")]!;
    await persist(winner);
    const originalBudget = { reservations: [], allowance: { units: 4321 }, consumedUnits: 123 };
    await pg.sql.unsafe(`INSERT INTO ${ns}.admission_envelopes(company_id,period_key,document) VALUES ($1,'original',$2::jsonb)`, [winner.companyId,JSON.stringify(originalBudget)]);
    const beforeRestart = await registry();
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/receipts/repository-occupation.ts"), "--restart-child"], { env: { ...process.env,
        REPOSITORY_TEST_CONNECTION: JSON.stringify(pg.connection), REPOSITORY_TEST_NAMESPACE: ns, REPOSITORY_TEST_MISSION: JSON.stringify(winner) }, stdio: ["ignore", "pipe", "pipe"] });
      let errors = ""; child.stderr.on("data", value => { errors += value; });
      child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(new Error(errors)));
    });
    assert.deepEqual(await registry(), beforeRestart);
    assert.deepEqual((await pg.sql.unsafe(`SELECT document FROM ${ns}.admission_envelopes WHERE company_id=$1`, [winner.companyId]))[0].document, originalBudget);
    await assert.rejects(assertProjectDeparture(ctx, contenders.find(m => m !== winner)!), { code: "repository_occupied" });
    results.sixteenCrossCompanyCampaignsOneOwnerAndSeparateProcessRestart = "PASS";

    await reset();
    const a = await subject(), b = await subject();
    await Promise.all([ensureMissionRepository(ctx, a), ensureMissionRepository(ctx, b)]);
    assert.equal(Object.keys((await registry()).holders).length, 2);
    await assert.rejects(ensureMissionRepository(ctx, a, true), { code: "repository_occupied" });
    results.historicalOrdinaryConcurrencyRetained = "PASS";

    await reset();
    const differentA = await subject("owner/one"), differentB = await subject("owner/two");
    await Promise.all([ensureMissionRepository(ctx, differentA, true), ensureMissionRepository(ctx, differentB, true)]);
    repositories.set(differentA.projectId, "owner/changed");
    await assert.rejects(ensureMissionRepository(ctx, differentA, true), { code: "repository_target_changed" });
    const conflictTarget = await subject("owner/workspace");
    conflictTarget.aggregate.projectMandate = { publication: { repository: "owner/pinned" } } as any;
    await assert.rejects(ensureMissionRepository(ctx, conflictTarget, true), { code: "repository_target_changed" });
    results.independentRepositoriesAndTargetDrift = "PASS";

    await reset();
    const unknown = await subject(null, true), known = await subject();
    await assert.rejects(ensureMissionRepository(ctx, known, true), { code: "repository_occupied" });
    await assert.rejects(ensureMissionRepository(ctx, unknown, true), { code: "repository_target_missing" });
    results.unknownLegacyRepositoryFailsClosed = "PASS";

    await reset();
    const lost = await subject();
    let drop = true;
    const lostContext = { ...ctx, db: { ...pg.db, execute: async (...args: Parameters<typeof pg.db.execute>) => {
      const result = await pg.db.execute(...args);
      if (drop) { drop = false; throw new Error("synthetic lost committed response"); }
      return result;
    } } } as unknown as PluginContext;
    await assert.rejects(ensureMissionRepository(lostContext, lost), /lost committed response/);
    await assert.rejects(ensureMissionRepository(ctx, await subject(), true), { code: "repository_occupied" });
    await ensureMissionRepository(ctx, lost, true);
    assert.equal(Object.keys((await registry()).holders).length, 1);
    results.lostCommittedResponseRetainsOriginalIdentityAndCanUpgrade = "PASS";

    await persist(lost);
    lost.aggregate.linearContinuity = { mode: "milestone-fixed-v1", control: "paused", publications: [] } as any;
    await update(lost);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    await assert.rejects(ensureMissionRepository(ctx, await subject(), true), { code: "repository_occupied" });
    await cancelled(lost);
    lost.aggregate.linearContinuity!.publications = [{ intentId: randomUUID() }] as any;
    await update(lost);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    lost.aggregate.linearContinuity!.publications = [];
    lost.aggregate.n5 = { publication: { creation: "claimed", issueId: null } } as any;
    await update(lost);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    delete lost.aggregate.n5;
    await update(lost);
    locks.add(lost.rootIssueId);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    locks.clear();
    inventories.set(lost.rootIssueId, [{ id: randomUUID(), issueId: lost.rootIssueId, agentId: randomUUID(), status: "running" }]);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    inventories.clear();
    const reservationId = randomUUID(), runId = randomUUID(), agentId = randomUUID();
    const reservation = { missionId: lost.missionId, reservationId, status: "unsettled", usage: { status: "unknown" }, remainingExposure: { status: "unknown" } };
    await pg.sql.unsafe(`INSERT INTO ${ns}.admission_envelopes(company_id,period_key,document) VALUES ($1,'fixture',$2::jsonb)`, [lost.companyId,JSON.stringify({ reservations: [reservation] })]);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false);
    await pg.sql.unsafe(`UPDATE ${ns}.admission_envelopes SET document=$1::jsonb WHERE company_id=$2`, [JSON.stringify({ reservations: [{ ...reservation, status: "settled", usage: { status: "known", units: 10 }, remainingExposure: { status: "known", units: 0 } }] }),lost.companyId]);
    lost.aggregate.modelSelection = { tasks: [{ launches: [{ issueId: lost.rootIssueId, runId, agentId, launchKey: reservationId, state: "running" }] }] } as any;
    await update(lost);
    assert.equal(await reconcileRepositoryRelease(ctx, lost), false, "A missing admitted run in native inventory cannot prove termination");
    inventories.set(lost.rootIssueId, [{ id: runId, issueId: lost.rootIssueId, agentId, status: "succeeded" }]);
    const stale = structuredClone(lost);
    await update(lost);
    await assert.rejects(reconcileRepositoryRelease(ctx, stale), { code: "repository_release_pending" });
    assert.equal(await reconcileRepositoryRelease(ctx, lost), true);
    await assert.rejects(ensureMissionRepository(ctx, lost, true), { code: "repository_mission_changed" });
    await ensureMissionRepository(ctx, await subject(), true);
    results.pauseUnknownPublicationCreationNativeRunAndCostRetainThenSafeCancellationReleases = "PASS";

    console.log(JSON.stringify({ evidenceLayer: "isolated-postgresql-with-host-query-and-migration-guards", results }, null, 2));
  } finally { await pg.cleanup(); }
}
