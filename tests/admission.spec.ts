import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  AdmissionError,
  configureAdmission,
  readAdmission,
  reserveAdmission,
  settleAdmission,
  type AdmissionConfigureInput,
} from "../src/admission.js";

type StoredRow = {
  company_id: string;
  period_key: string;
  version: number;
  document: unknown;
  created_at: string;
  updated_at: string;
};

function admissionStore() {
  const rows = new Map<string, StoredRow>();
  const key = (companyId: string, periodKey: string) => `${companyId}:${periodKey}`;
  const query = vi.fn(async (_sql: string, params: unknown[] = []) => {
    const row = rows.get(key(String(params[0]), String(params[1])));
    return row ? [structuredClone(row)] : [];
  });
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    const rowKey = key(String(params[0]), String(params[1]));
    if (sql.startsWith("INSERT")) {
      if (rows.has(rowKey)) return { rowCount: 0 };
      const now = new Date().toISOString();
      rows.set(rowKey, {
        company_id: String(params[0]),
        period_key: String(params[1]),
        version: 1,
        document: JSON.parse(String(params[2])),
        created_at: now,
        updated_at: now,
      });
      return { rowCount: 1 };
    }
    if (sql.startsWith("UPDATE")) {
      const row = rows.get(rowKey);
      if (!row || row.version !== Number(params[3])) return { rowCount: 0 };
      rows.set(rowKey, {
        ...row,
        version: row.version + 1,
        document: JSON.parse(String(params[2])),
        updated_at: new Date().toISOString(),
      });
      return { rowCount: 1 };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const context = () => ({
    db: { namespace: "plugin_private_paperclip_council_test", query, execute },
  }) as unknown as PluginContext;
  return { rows, query, execute, context };
}

const companyId = "00000000-0000-4000-8000-000000000001";
const missionId = "00000000-0000-4000-8000-000000000002";
const effectId = "00000000-0000-4000-8000-000000000003";

function knownConfiguration(overrides: Partial<AdmissionConfigureInput> = {}): AdmissionConfigureInput {
  const now = Date.now();
  return {
    commandId: randomUUID(),
    companyId,
    periodKey: "fixture-2026-09",
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 60_000).toISOString(),
    measurement: { status: "known", source: "N1 deterministic fixture", unit: "fixture-unit" },
    allowance: { status: "known", source: "N1 deterministic fixture", periodUnits: 100, taskUnits: 60, knownUsageUnits: 0 },
    exposure: { status: "known", source: "N1 deterministic fixture", units: 0 },
    limits: { maxConcurrent: 2, maxRetries: 1, maxCorrections: 1 },
    ...overrides,
  };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    companyId,
    periodKey: "fixture-2026-09",
    reservationId: randomUUID(),
    missionId,
    effectId,
    requestedUnits: 30,
    attempt: { kind: "initial" as const, ordinal: 0 },
    expectedVersion: 1,
    ...overrides,
  };
}

describe("G4 admission envelopes", () => {
  it("persists unknown inputs as blockers and refuses reservation without inventing amounts", async () => {
    const store = admissionStore();
    const configured = await configureAdmission(store.context(), knownConfiguration({
      measurement: { status: "unknown", reason: "No qualified provider measurement source" },
      allowance: { status: "unknown", reason: "No activation allowance supplied" },
      exposure: { status: "unknown", reason: "Remaining exposure cannot be assessed" },
    }));

    expect(configured.envelope).toMatchObject({
      status: "blocked",
      accountedUnits: null,
      availablePeriodUnits: null,
    });
    expect(configured.envelope.blockers.map((item) => item.code)).toEqual([
      "measurement_unknown",
      "allowance_unknown",
      "exposure_unknown",
    ]);
    await expect(reserveAdmission(store.context(), reservation())).rejects.toMatchObject({
      status: 422,
      code: "admission_blocked",
    });
    expect(configured.envelope.reservations).toEqual([]);
  });

  it("refuses an otherwise known envelope outside its configured period", async () => {
    const store = admissionStore();
    const configured = await configureAdmission(store.context(), knownConfiguration({
      periodKey: "expired-fixture",
      periodStart: "2020-01-01T00:00:00.000Z",
      periodEnd: "2020-02-01T00:00:00.000Z",
    }));
    expect(configured.envelope).toMatchObject({
      status: "blocked",
      blockers: [expect.objectContaining({ code: "period_inactive" })],
    });
    await expect(reserveAdmission(store.context(), reservation({ periodKey: "expired-fixture" }))).rejects.toMatchObject({
      status: 422,
      code: "admission_blocked",
    });
  });

  it("returns a durable reservation identity and only replays an identical binding", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration({ limits: { maxConcurrent: 1, maxRetries: 1, maxCorrections: 1 } }));
    const input = reservation();
    const reserved = await reserveAdmission(store.context(), input);

    expect(reserved).toMatchObject({
      outcome: "reserved",
      reservation: {
        reservationId: input.reservationId,
        missionId,
        effectId,
        requestedUnits: 30,
        status: "reserved",
      },
      envelope: { version: 2, status: "blocked" },
    });
    expect(reserved.envelope.blockers).toContainEqual(expect.objectContaining({ code: "parallelism_exhausted" }));
    const persisted = [...store.rows.values()][0]!.document as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("status");
    expect(persisted).not.toHaveProperty("availablePeriodUnits");

    await expect(reserveAdmission(store.context(), { ...input, expectedVersion: 1 })).resolves.toMatchObject({
      outcome: "replayed",
      reservation: { status: "reserved", bindingHash: reserved.reservation?.bindingHash },
    });
    await expect(reserveAdmission(store.context(), { ...input, requestedUnits: 31, expectedVersion: 2 })).rejects.toMatchObject({
      status: 409,
      code: "reservation_identity_conflict",
    });
  });

  it("uses one envelope CAS so competing admissions cannot overbook", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration({
      allowance: { status: "known", source: "N1 deterministic fixture", periodUnits: 50, taskUnits: 50, knownUsageUnits: 0 },
    }));
    const left = reservation({ reservationId: randomUUID(), requestedUnits: 30 });
    const right = reservation({ reservationId: randomUUID(), effectId: randomUUID(), requestedUnits: 30 });

    const results = await Promise.allSettled([
      reserveAdmission(store.context(), left),
      reserveAdmission(store.context(), right),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((item) => item.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ status: 409, code: "version_conflict" });
    const stored = await readAdmission(store.context(), { companyId, periodKey: left.periodKey });
    expect(stored?.reservations).toHaveLength(1);
    expect(stored?.accountedUnits).toBe(30);

    await expect(reserveAdmission(store.context(), { ...right, expectedVersion: stored!.version })).rejects.toMatchObject({
      status: 422,
      code: "period_allowance_exceeded",
    });
  });

  it("retains unknown settlement across restart and only releases known zero exposure", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration());
    const input = reservation({ requestedUnits: 20 });
    await reserveAdmission(store.context(), input);

    const unknown = await settleAdmission(store.context(), {
      commandId: randomUUID(),
      companyId,
      periodKey: input.periodKey,
      reservationId: input.reservationId,
      usage: { status: "unknown", reason: "Provider usage has not arrived" },
      remainingExposure: { status: "unknown", reason: "The dispatched call may still incur usage" },
      expectedVersion: 2,
    });
    expect(unknown.reservation?.status).toBe("unsettled");
    expect(unknown.envelope.blockers.map((item) => item.code)).toEqual(expect.arrayContaining([
      "unsettled_usage_unknown",
      "unsettled_exposure_unknown",
    ]));

    const afterRestart = await readAdmission(store.context(), { companyId, periodKey: input.periodKey });
    expect(afterRestart?.reservations[0]).toMatchObject({ status: "unsettled", usage: { status: "unknown" } });
    await expect(reserveAdmission(store.context(), reservation({
      reservationId: randomUUID(),
      effectId: randomUUID(),
      expectedVersion: afterRestart!.version,
    }))).rejects.toMatchObject({ status: 422, code: "admission_blocked" });

    const reconciled = await settleAdmission(store.context(), {
      commandId: randomUUID(),
      companyId,
      periodKey: input.periodKey,
      reservationId: input.reservationId,
      usage: { status: "known", source: "N1 deterministic fixture", units: 17 },
      remainingExposure: { status: "known", source: "N1 deterministic fixture", units: 0 },
      expectedVersion: afterRestart!.version,
    });
    expect(reconciled).toMatchObject({
      outcome: "settled",
      reservation: { status: "settled" },
      envelope: { status: "admissible", accountedUnits: 17, availablePeriodUnits: 83 },
    });
  });

  it("keeps a known nonzero unsettled reservation inside the concurrency limit", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration({
      limits: { maxConcurrent: 1, maxRetries: 1, maxCorrections: 1 },
    }));
    const first = reservation({ requestedUnits: 20 });
    await reserveAdmission(store.context(), first);
    const unsettled = await settleAdmission(store.context(), {
      commandId: randomUUID(), companyId, periodKey: first.periodKey,
      reservationId: first.reservationId,
      usage: { status: "known", source: "N1 deterministic fixture", units: 5 },
      remainingExposure: { status: "known", source: "N1 deterministic fixture", units: 10 },
      expectedVersion: 2,
    });
    expect(unsettled.envelope.blockers).toContainEqual(expect.objectContaining({ code: "parallelism_exhausted" }));
    await expect(reserveAdmission(store.context(), reservation({
      reservationId: randomUUID(), effectId: randomUUID(), expectedVersion: unsettled.envelope.version,
    }))).rejects.toMatchObject({ status: 422, code: "admission_blocked" });
  });

  it("enforces task and attempt limits before changing durable state", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration({
      allowance: { status: "known", source: "N1 deterministic fixture", periodUnits: 100, taskUnits: 10, knownUsageUnits: 0 },
      limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
    }));
    await expect(reserveAdmission(store.context(), reservation({ requestedUnits: 11 }))).rejects.toMatchObject({
      code: "task_allowance_exceeded",
    });
    await expect(reserveAdmission(store.context(), reservation({
      requestedUnits: 10,
      attempt: { kind: "retry", ordinal: 1 },
    }))).rejects.toMatchObject({ code: "retry_limit_exceeded" });
    const current = await readAdmission(store.context(), { companyId, periodKey: "fixture-2026-09" });
    expect(current?.version).toBe(1);
    expect(current?.reservations).toEqual([]);
  });

  it("exposes structured errors for callers wiring admission into mission activation", () => {
    const error = new AdmissionError(422, "fixture", "blocked", { nextActor: "owner" });
    expect(error).toMatchObject({ name: "AdmissionError", status: 422, code: "fixture", details: { nextActor: "owner" } });
  });
});
