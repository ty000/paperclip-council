import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { initialL03Governance, transitionL03 } from "../../src/l03.js";
import { L03GovernanceStore } from "../../src/l03-store.js";
import type { L03Actor, L03AuthoritySnapshot } from "../../src/l03-types.js";

const namespace = "plugin_private_paperclip_council_270061461e";
const companyId = "20000000-0000-4000-8000-000000000001";
const missionId = "20000000-0000-4000-8000-000000000002";
const H = "a".repeat(64);

type PgClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
};

type EmbeddedInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getPgClient(): PgClient;
};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate PostgreSQL test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function dbContext(client: PgClient): Pick<PluginContext, "db"> {
  return {
    db: {
      namespace,
      query: async <T>(sql: string, values?: unknown[]) => (await client.query(sql, values)).rows as T[],
      execute: async (sql: string, values?: unknown[]) => ({ rowCount: (await client.query(sql, values)).rowCount ?? 0 }),
    },
  } as Pick<PluginContext, "db">;
}

function initialState() {
  const current: L03AuthoritySnapshot = {
    companyId,
    missionId,
    missionVersion: 1,
    mandateRevision: 1,
    ownerUserId: "owner-1",
    executorAgentId: "executor-1",
    finalReviewerAgentId: "reviewer-1",
    councilAgentId: "reviewer-1",
    executivePluginActorId: "paperclip-executive.executive",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const owner: L03Actor = { actorType: "user", actorId: "owner-1", userId: "owner-1", companyId };
  return initialL03Governance({
    companyId,
    missionId,
    expectedMissionVersion: 1,
    mandateRevision: 1,
    executorAgentId: current.executorAgentId,
    finalReviewerAgentId: current.finalReviewerAgentId,
    councilAgentId: current.councilAgentId,
    executivePluginActorId: current.executivePluginActorId,
    expiresAt: current.expiresAt,
    ticket: {
      issueId: "root-issue",
      sourceRef: "linear:ETY-3@1",
      sourceVersion: "1",
      sourceHash: H,
      suppliedContext: { sourceRef: "attachment:context", sourceHash: H, content: "Bounded context" },
      criteria: [{ id: "criterion-1", text: "One admitted approach" }],
      exclusions: [],
    },
    limits: { envelope: 2, approach: 1, result: 1, consultation: 1, correction: 1 },
  }, { now: "2026-09-30T12:00:00.000Z", actor: owner, current });
}

describe("L03 PostgreSQL persistence", () => {
  it("admits the last shared-envelope action once under concurrent CAS and survives a PostgreSQL restart", async () => {
    const hostRoot = process.env.PAPERCLIP_TEST_HOST_ROOT ?? "/home/davy-lp/workspace/paperclip";
    const modulePath = path.join(hostRoot, "server/node_modules/embedded-postgres/dist/index.js");
    if (!fs.existsSync(modulePath)) throw new Error(`Required embedded PostgreSQL runtime is missing: ${modulePath}`);
    const EmbeddedPostgres = (await import(pathToFileURL(modulePath).href)).default as new (options: Record<string, unknown>) => EmbeddedInstance;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-council-l03-pg-"));
    const postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port: await freePort(),
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });
    const clients: PgClient[] = [];
    try {
      await postgres.initialise();
      await postgres.start();
      const setup = postgres.getPgClient();
      clients.push(setup);
      await setup.connect();
      await setup.query(`CREATE SCHEMA ${namespace}`);
      await setup.query(`CREATE TABLE ${namespace}.missions (
        company_id uuid NOT NULL,
        mission_id uuid NOT NULL,
        version bigint NOT NULL,
        PRIMARY KEY (company_id, mission_id)
      )`);
      await setup.query(`INSERT INTO ${namespace}.missions(company_id, mission_id, version) VALUES ($1, $2, 1)`, [companyId, missionId]);
      const migration = fs.readFileSync(path.join(process.cwd(), "migrations/005_l03_governance.sql"), "utf8");
      await setup.query(migration);

      const clientA = postgres.getPgClient();
      const clientB = postgres.getPgClient();
      clients.push(clientA, clientB);
      await Promise.all([clientA.connect(), clientB.connect()]);
      const storeA = new L03GovernanceStore(dbContext(clientA));
      const storeB = new L03GovernanceStore(dbContext(clientB));
      const initial = initialState();
      await storeA.create(initial);
      const executor: L03Actor = { actorType: "agent", actorId: initial.authority.executorAgentId, companyId };
      const approach = transitionL03(initial, {
        type: "submit-approach",
        expectedVersion: initial.version,
        approach: {
          approachId: "approach-1",
          authorAgentId: initial.authority.executorAgentId,
          contentRef: "document:approach-1",
          contentHash: H,
          criterionRefs: ["criterion-1"],
          evidenceRefs: ["evidence:plan"],
          supersedesApproachId: null,
          addressesFindingIds: [],
        },
      }, { now: "2026-09-30T12:01:00.000Z", actor: executor, current: initial.authority });
      await storeA.compareAndSwap(initial, approach);
      const restartedRead = await storeB.get(companyId, missionId);
      expect(restartedRead).toEqual(approach);

      const council: L03Actor = { actorType: "agent", actorId: initial.authority.councilAgentId, companyId };
      const candidate = (suffix: string) => transitionL03(approach, {
        type: "reserve-consultation",
        expectedVersion: approach.version,
        subjectApproachId: "approach-1",
        reservation: {
          companyId,
          missionId,
          missionVersion: 1,
          mandateRevision: 1,
          slotId: `slot-${suffix}`,
          reservationId: `reservation-${suffix}`,
          reservationVersion: 1,
          status: "reserved",
          reservedExecutiveAgentId: `executive-${suffix}`,
          profile: { id: "architecture", version: "1", sourceHash: H },
          method: { id: "paperclip-executive.council-reserved-opinion", version: "1.0.0" },
          criterionRefs: ["criterion-1"],
          evidenceRefs: ["evidence:plan"],
          context: { sourceRef: "document:approach-1", sourceHash: H, content: "Bounded approach" },
          expiresAt: "2026-09-30T12:10:00.000Z",
        },
        required: true,
        reservationEventRef: `event:${suffix}`,
        costExposure: { status: "unknown", reference: `exposure:${suffix}` },
      }, { now: "2026-09-30T12:02:00.000Z", actor: council, current: initial.authority });
      const outcomes = await Promise.allSettled([
        storeA.compareAndSwap(approach, candidate("a")),
        storeB.compareAndSwap(approach, candidate("b")),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

      await Promise.all([clientA.end(), clientB.end()]);
      clients.splice(clients.indexOf(clientA), 1);
      clients.splice(clients.indexOf(clientB), 1);
      await postgres.stop();
      await postgres.start();
      const afterRestart = postgres.getPgClient();
      clients.push(afterRestart);
      await afterRestart.connect();
      const persisted = await new L03GovernanceStore(dbContext(afterRestart)).get(companyId, missionId);
      expect(persisted).toMatchObject({
        version: 3,
        phase: "collecting_approach_opinions",
        counters: {
          envelope: { admitted: 2, limit: 2 },
          approach: { admitted: 1, limit: 1 },
          consultation: { admitted: 1, limit: 1, activeReservations: 1 },
        },
      });
      expect(persisted?.approaches).toHaveLength(1);
      expect(persisted?.consultationSlots).toHaveLength(1);
      expect(persisted?.counters.unknownCostExposureRefs).toHaveLength(1);
    } finally {
      await Promise.allSettled(clients.map((client) => client.end()));
      await postgres.stop().catch(() => {});
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});

