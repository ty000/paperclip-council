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
import {
  assertNativeEnvelope,
  nativeAdmissionConfiguration,
  type NativeG4Profile,
} from "../src/g4-native.js";

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
  it("accepts settled native usage growth through the complete sequential N1 ledger", async () => {
    const store = admissionStore();
    const profile: NativeG4Profile = {
      kind: "paperclip-orchestration-tokens-v1",
      periodKey: "native-sequential-ledger",
      periodStart: new Date(Date.now() - 60_000).toISOString(),
      periodEnd: new Date(Date.now() + 60_000).toISOString(),
      periodAllowanceUnits: 1_000,
      runReservationUnits: 100,
      initialKnownUsageUnits: 10,
      initialExposureUnits: 5,
      initialTokenAccountingSource: "test:fresh-company-period",
      maxCorrections: 0 as const,
    };
    const configuration = nativeAdmissionConfiguration(profile, companyId, randomUUID());
    const configured = await configureAdmission(store.context(), configuration);
    assertNativeEnvelope(configured.envelope, profile);

    const reserve = async (reservationId: string, effect: string, expectedVersion: number) => reserveAdmission(
      store.context(),
      {
        companyId,
        periodKey: profile.periodKey,
        reservationId,
        missionId,
        effectId: effect,
        requestedUnits: profile.runReservationUnits,
        attempt: { kind: "initial", ordinal: 0 },
        expectedVersion,
      },
    );
    const settle = async (reservationId: string, units: number, expectedVersion: number, commandId = randomUUID()) => {
      const input = {
        commandId,
        companyId,
        periodKey: profile.periodKey,
        reservationId,
        usage: { status: "known" as const, source: `native-run:${reservationId}`, units },
        remainingExposure: { status: "known" as const, source: `native-run:${reservationId}`, units: 0 },
        expectedVersion,
      };
      return { input, result: await settleAdmission(store.context(), input) };
    };

    const leadReservationId = randomUUID();
    const alphaReservationId = randomUUID();
    const betaReservationId = randomUUID();
    const lead = await reserve(leadReservationId, randomUUID(), configured.envelope.version);
    const alpha = await reserve(alphaReservationId, randomUUID(), lead.envelope.version);
    const alphaSettlement = await settle(alphaReservationId, 20, alpha.envelope.version);
    expect(alphaSettlement.result.envelope.allowance).toMatchObject({ knownUsageUnits: 30 });
    expect(alphaSettlement.result.reservation?.settlementReceipts[0]).toMatchObject({
      settlement: {
        usage: alphaSettlement.input.usage,
        remainingExposure: alphaSettlement.input.remainingExposure,
      },
    });
    expect(() => assertNativeEnvelope(alphaSettlement.result.envelope, profile)).not.toThrow();

    const beta = await reserve(betaReservationId, randomUUID(), alphaSettlement.result.envelope.version);
    const betaSettlement = await settle(betaReservationId, 25, beta.envelope.version);
    expect(() => assertNativeEnvelope(betaSettlement.result.envelope, profile)).not.toThrow();
    const leadSettlement = await settle(leadReservationId, 30, betaSettlement.result.envelope.version);
    expect(leadSettlement.result.envelope).toMatchObject({
      version: 7,
      status: "admissible",
      allowance: { knownUsageUnits: 85 },
      accountedUnits: 90,
      availablePeriodUnits: 910,
    });
    expect(() => assertNativeEnvelope(leadSettlement.result.envelope, profile)).not.toThrow();

    const replay = await settleAdmission(store.context(), alphaSettlement.input);
    expect(replay).toMatchObject({
      outcome: "replayed",
      envelope: { version: 7, allowance: { knownUsageUnits: 85 } },
      reservation: { reservationId: alphaReservationId, status: "settled" },
    });
    const finalAllowance = leadSettlement.result.envelope.allowance;
    if (finalAllowance.status !== "known") throw new Error("native allowance unexpectedly became unknown");
    expect(() => assertNativeEnvelope({
      ...leadSettlement.result.envelope,
      allowance: { ...finalAllowance, knownUsageUnits: 9 },
    }, profile)).toThrow(/does not match/);
    expect(() => assertNativeEnvelope({
      ...leadSettlement.result.envelope,
      allowance: { ...finalAllowance, knownUsageUnits: Number.MAX_SAFE_INTEGER + 1 },
    }, profile)).toThrow(/does not match/);
  });

  it("binds one settlement commandId to one reservation without mutating a conflicting target", async () => {
    const store = admissionStore();
    const configured = await configureAdmission(store.context(), knownConfiguration());
    const alphaInput = reservation({ reservationId: randomUUID(), expectedVersion: configured.envelope.version });
    const alpha = await reserveAdmission(store.context(), alphaInput);
    const betaInput = reservation({ reservationId: randomUUID(), expectedVersion: alpha.envelope.version });
    const beta = await reserveAdmission(store.context(), betaInput);
    const alphaCommandId = randomUUID();
    const betaCommandId = randomUUID();
    const settlement = (commandId: string, reservationId: string, units: number, expectedVersion: number) => ({
      commandId,
      companyId,
      periodKey: alphaInput.periodKey,
      reservationId,
      usage: { status: "known" as const, source: `native-run:${reservationId}`, units },
      remainingExposure: { status: "known" as const, source: `native-run:${reservationId}`, units: 0 },
      expectedVersion,
    });
    const alphaSettlement = settlement(alphaCommandId, alphaInput.reservationId, 20, beta.envelope.version);
    const alphaSettled = await settleAdmission(store.context(), alphaSettlement);
    const beforeConflict = await readAdmission(store.context(), alphaInput);
    const crossReservationConflict = settlement(
      alphaCommandId,
      betaInput.reservationId,
      25,
      alphaSettled.envelope.version,
    );

    await expect(settleAdmission(store.context(), crossReservationConflict)).rejects.toMatchObject({
      status: 409,
      code: "command_identity_conflict",
    });
    expect(await readAdmission(store.context(), alphaInput)).toEqual(beforeConflict);

    const betaSettlement = settlement(
      betaCommandId,
      betaInput.reservationId,
      25,
      alphaSettled.envelope.version,
    );
    const betaSettled = await settleAdmission(store.context(), betaSettlement);
    expect(betaSettled.envelope.allowance).toMatchObject({ knownUsageUnits: 45 });

    await expect(settleAdmission(store.context(), betaSettlement)).resolves.toMatchObject({
      outcome: "replayed",
      envelope: { version: betaSettled.envelope.version, allowance: { knownUsageUnits: 45 } },
    });
    await expect(settleAdmission(store.context(), alphaSettlement)).resolves.toMatchObject({
      outcome: "replayed",
      envelope: { version: betaSettled.envelope.version, allowance: { knownUsageUnits: 45 } },
      reservation: { reservationId: alphaInput.reservationId },
    });
  });

  it("keeps settlement commandId binding unique when two reservations race the same CAS version", async () => {
    const store = admissionStore();
    const configured = await configureAdmission(store.context(), knownConfiguration());
    const alphaInput = reservation({ reservationId: randomUUID(), expectedVersion: configured.envelope.version });
    const alpha = await reserveAdmission(store.context(), alphaInput);
    const betaInput = reservation({ reservationId: randomUUID(), expectedVersion: alpha.envelope.version });
    const beta = await reserveAdmission(store.context(), betaInput);
    const commandId = randomUUID();
    const settlement = (reservationId: string, units: number) => ({
      commandId,
      companyId,
      periodKey: alphaInput.periodKey,
      reservationId,
      usage: { status: "known" as const, source: `native-run:${reservationId}`, units },
      remainingExposure: { status: "known" as const, source: `native-run:${reservationId}`, units: 0 },
      expectedVersion: beta.envelope.version,
    });
    const alphaSettlement = settlement(alphaInput.reservationId, 20);
    const betaSettlement = settlement(betaInput.reservationId, 25);

    const raced = await Promise.allSettled([
      settleAdmission(store.context(), alphaSettlement),
      settleAdmission(store.context(), betaSettlement),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "command_identity_conflict" }) }),
    ]);

    const afterRace = (await readAdmission(store.context(), alphaInput))!;
    expect(afterRace.version).toBe(beta.envelope.version + 1);
    expect(afterRace.reservations.flatMap((item) => item.settlementReceipts)
      .filter((receipt) => receipt.commandId === commandId)).toHaveLength(1);
  });

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

  it("preserves cumulative known usage through an unknown observation", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration());
    const input = reservation({ requestedUnits: 20 });
    await reserveAdmission(store.context(), input);
    const known = await settleAdmission(store.context(), {
      commandId: randomUUID(), companyId, periodKey: input.periodKey, reservationId: input.reservationId,
      usage: { status: "known", source: "fixture", units: 4 },
      remainingExposure: { status: "known", source: "fixture", units: 5 }, expectedVersion: 2,
    });
    expect(known.envelope.allowance).toMatchObject({ knownUsageUnits: 4 });
    const unknown = await settleAdmission(store.context(), {
      commandId: randomUUID(), companyId, periodKey: input.periodKey, reservationId: input.reservationId,
      usage: { status: "unknown", reason: "Billing readback unavailable" },
      remainingExposure: { status: "unknown", reason: "Work may still run" }, expectedVersion: known.envelope.version,
    });
    expect(unknown.reservation).toMatchObject({ lastKnownUsageUnits: 4, usage: { status: "unknown" } });
    await expect(settleAdmission(store.context(), {
      commandId: randomUUID(), companyId, periodKey: input.periodKey, reservationId: input.reservationId,
      usage: { status: "known", source: "fixture", units: 3 },
      remainingExposure: { status: "known", source: "fixture", units: 0 }, expectedVersion: unknown.envelope.version,
    })).rejects.toMatchObject({ status: 422, code: "usage_regression" });
    const reconciled = await settleAdmission(store.context(), {
      commandId: randomUUID(), companyId, periodKey: input.periodKey, reservationId: input.reservationId,
      usage: { status: "known", source: "fixture", units: 4 },
      remainingExposure: { status: "known", source: "fixture", units: 0 }, expectedVersion: unknown.envelope.version,
    });
    expect(reconciled.envelope.allowance).toMatchObject({ knownUsageUnits: 4 });
    expect(reconciled.envelope.accountedUnits).toBe(4);
    expect(reconciled.reservation).toMatchObject({ lastKnownUsageUnits: 4, status: "settled" });
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

  it("stops configuration at 100 receipts without making the oldest commandId reusable", async () => {
    const store = admissionStore();
    const first = knownConfiguration();
    await configureAdmission(store.context(), first);
    let current = (await readAdmission(store.context(), first))!;

    for (let index = 1; index < 100; index += 1) {
      await configureAdmission(store.context(), knownConfiguration({
        commandId: randomUUID(),
        expectedVersion: current.version,
      }));
      current = (await readAdmission(store.context(), first))!;
    }

    expect(current.commandReceipts).toHaveLength(100);
    await expect(configureAdmission(store.context(), knownConfiguration({
      commandId: randomUUID(),
      expectedVersion: current.version,
    }))).rejects.toMatchObject({ status: 409, code: "command_limit_reached" });
    await expect(configureAdmission(store.context(), first)).resolves.toMatchObject({
      outcome: "replayed",
      envelope: { version: current.version },
    });
    await expect(configureAdmission(store.context(), {
      ...first,
      limits: { ...first.limits, maxRetries: first.limits.maxRetries + 1 },
    })).rejects.toMatchObject({ status: 409, code: "command_identity_conflict" });

    const afterLimit = await readAdmission(store.context(), first);
    expect(afterLimit).toMatchObject({ version: current.version, commandReceipts: current.commandReceipts });
  });

  it("stops settlement at 100 receipts without making the oldest commandId reusable", async () => {
    const store = admissionStore();
    await configureAdmission(store.context(), knownConfiguration());
    const input = reservation({ requestedUnits: 20 });
    await reserveAdmission(store.context(), input);
    const firstCommandId = randomUUID();
    const settlement = (commandId: string, expectedVersion: number, units = 5) => ({
      commandId,
      companyId,
      periodKey: input.periodKey,
      reservationId: input.reservationId,
      usage: { status: "known" as const, source: "fixture", units },
      remainingExposure: { status: "known" as const, source: "fixture", units: 1 },
      expectedVersion,
    });

    let current = (await readAdmission(store.context(), input))!;
    const first = settlement(firstCommandId, current.version);
    await settleAdmission(store.context(), first);
    current = (await readAdmission(store.context(), input))!;
    for (let index = 1; index < 100; index += 1) {
      await settleAdmission(store.context(), settlement(randomUUID(), current.version));
      current = (await readAdmission(store.context(), input))!;
    }

    expect(current.reservations[0]?.settlementReceipts).toHaveLength(100);
    await expect(settleAdmission(store.context(), settlement(randomUUID(), current.version))).rejects.toMatchObject({
      status: 409,
      code: "command_limit_reached",
    });
    await expect(settleAdmission(store.context(), first)).resolves.toMatchObject({
      outcome: "replayed",
      envelope: { version: current.version },
    });
    await expect(settleAdmission(store.context(), settlement(firstCommandId, current.version, 6))).rejects.toMatchObject({
      status: 409,
      code: "command_identity_conflict",
    });

    const afterLimit = await readAdmission(store.context(), input);
    expect(afterLimit).toMatchObject({ version: current.version, reservations: current.reservations });
  });

  it("exposes structured errors for callers wiring admission into mission activation", () => {
    const error = new AdmissionError(422, "fixture", "blocked", { nextActor: "owner" });
    expect(error).toMatchObject({ name: "AdmissionError", status: 422, code: "fixture", details: { nextActor: "owner" } });
  });
});
