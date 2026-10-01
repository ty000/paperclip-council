import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECEIPTS = 100;

export type UnknownAdmissionFact = {
  status: "unknown";
  reason: string;
};

export type AdmissionMeasurement = UnknownAdmissionFact | {
  status: "known";
  source: string;
  unit: string;
};

export type AdmissionAllowance = UnknownAdmissionFact | {
  status: "known";
  source: string;
  periodUnits: number;
  taskUnits: number;
  knownUsageUnits: number;
};

export type AdmissionExposure = UnknownAdmissionFact | {
  status: "known";
  source: string;
  units: number;
};

export type AdmissionLimits = {
  maxConcurrent: number;
  maxRetries: number;
  maxCorrections: number;
};

export type AdmissionAttempt = {
  kind: "initial" | "retry" | "correction" | "appeal" | "resume";
  ordinal: number;
};

export type AdmissionUsage = UnknownAdmissionFact | {
  status: "known";
  source: string;
  units: number;
};

export type AdmissionRemainingExposure = UnknownAdmissionFact | {
  status: "known";
  source: string;
  units: number;
};

export type AdmissionReservation = {
  reservationId: string;
  missionId: string;
  effectId: string;
  requestedUnits: number;
  attempt: AdmissionAttempt;
  bindingHash: string;
  status: "reserved" | "unsettled" | "settled";
  reservedAt: string;
  updatedAt: string;
  usage: AdmissionUsage | null;
  lastKnownUsageUnits: number;
  remainingExposure: AdmissionRemainingExposure;
  settlementReceipts: AdmissionCommandReceipt[];
};

export type AdmissionCommandReceipt = {
  commandId: string;
  command: "configure" | "settle";
  payloadHash: string;
  appliedVersion: number;
  recordedAt: string;
  settlement?: {
    usage: AdmissionUsage;
    remainingExposure: AdmissionRemainingExposure;
  };
};

export type AdmissionDocument = {
  schemaVersion: 1;
  companyId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  measurement: AdmissionMeasurement;
  allowance: AdmissionAllowance;
  exposure: AdmissionExposure;
  limits: AdmissionLimits;
  reservations: AdmissionReservation[];
  commandReceipts: AdmissionCommandReceipt[];
};

export type AdmissionBlocker = {
  code:
    | "measurement_unknown"
    | "allowance_unknown"
    | "exposure_unknown"
    | "unsettled_usage_unknown"
    | "unsettled_exposure_unknown"
    | "period_inactive"
    | "period_allowance_exhausted"
    | "parallelism_exhausted";
  message: string;
};

export type AdmissionSnapshot = AdmissionDocument & {
  version: number;
  createdAt: string;
  updatedAt: string;
  status: "admissible" | "blocked";
  blockers: AdmissionBlocker[];
  accountedUnits: number | null;
  availablePeriodUnits: number | null;
};

export type AdmissionConfigureInput = {
  commandId: string;
  companyId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  measurement: AdmissionMeasurement;
  allowance: AdmissionAllowance;
  exposure: AdmissionExposure;
  limits: AdmissionLimits;
  expectedVersion?: number;
};

export type AdmissionReserveInput = {
  companyId: string;
  periodKey: string;
  reservationId: string;
  missionId: string;
  effectId: string;
  requestedUnits: number;
  attempt: AdmissionAttempt;
  expectedVersion: number;
};

export type AdmissionSettleInput = {
  commandId: string;
  companyId: string;
  periodKey: string;
  reservationId: string;
  usage: AdmissionUsage;
  remainingExposure: AdmissionRemainingExposure;
  expectedVersion: number;
};

export type AdmissionResult = {
  outcome: "configured" | "reserved" | "settled" | "replayed";
  envelope: AdmissionSnapshot;
  reservation?: AdmissionReservation;
};

type AdmissionRow = {
  company_id: string;
  period_key: string;
  version: string | number;
  document: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

export class AdmissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdmissionError";
  }
}

function requiredString(value: unknown, label: string, max = 400): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdmissionError(400, "malformed_admission", `${label} is required`);
  }
  const result = value.trim();
  if (result.length > max) throw new AdmissionError(422, "value_too_large", `${label} exceeds ${max} characters`);
  return result;
}

function uuid(value: unknown, label: string): string {
  const result = requiredString(value, label, 64);
  if (!UUID.test(result)) throw new AdmissionError(400, "malformed_admission", `${label} must be a UUID`);
  return result;
}

function units(value: unknown, label: string, allowZero = true): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw new AdmissionError(400, "malformed_admission", `${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  return units(value, label, false);
}

function timestamp(value: unknown, label: string): string {
  const raw = requiredString(value, label, 100);
  const date = new Date(raw);
  if (Number.isNaN(date.valueOf())) throw new AdmissionError(400, "malformed_admission", `${label} must be an ISO timestamp`);
  return date.toISOString();
}

function storedTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid timestamp in admission storage");
  return date.toISOString();
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function parseMeasurement(value: AdmissionMeasurement): AdmissionMeasurement {
  if (value?.status === "unknown") return { status: "unknown", reason: requiredString(value.reason, "measurement.reason", 1_000) };
  if (value?.status === "known") {
    return {
      status: "known",
      source: requiredString(value.source, "measurement.source", 1_000),
      unit: requiredString(value.unit, "measurement.unit", 120),
    };
  }
  throw new AdmissionError(400, "malformed_admission", "measurement status must be known or unknown");
}

function parseAllowance(value: AdmissionAllowance): AdmissionAllowance {
  if (value?.status === "unknown") return { status: "unknown", reason: requiredString(value.reason, "allowance.reason", 1_000) };
  if (value?.status === "known") {
    const parsed = {
      status: "known" as const,
      source: requiredString(value.source, "allowance.source", 1_000),
      periodUnits: units(value.periodUnits, "allowance.periodUnits"),
      taskUnits: units(value.taskUnits, "allowance.taskUnits"),
      knownUsageUnits: units(value.knownUsageUnits, "allowance.knownUsageUnits"),
    };
    if (parsed.knownUsageUnits > parsed.periodUnits) {
      throw new AdmissionError(422, "known_usage_exceeds_allowance", "Known usage cannot exceed the configured period allowance");
    }
    return parsed;
  }
  throw new AdmissionError(400, "malformed_admission", "allowance status must be known or unknown");
}

function parseExposure(value: AdmissionExposure): AdmissionExposure {
  if (value?.status === "unknown") return { status: "unknown", reason: requiredString(value.reason, "exposure.reason", 1_000) };
  if (value?.status === "known") {
    return {
      status: "known",
      source: requiredString(value.source, "exposure.source", 1_000),
      units: units(value.units, "exposure.units"),
    };
  }
  throw new AdmissionError(400, "malformed_admission", "exposure status must be known or unknown");
}

function parseLimits(value: AdmissionLimits): AdmissionLimits {
  return {
    maxConcurrent: positiveInteger(value?.maxConcurrent, "limits.maxConcurrent"),
    maxRetries: units(value?.maxRetries, "limits.maxRetries"),
    maxCorrections: units(value?.maxCorrections, "limits.maxCorrections"),
  };
}

function parseAttempt(value: AdmissionAttempt): AdmissionAttempt {
  const allowed = new Set(["initial", "retry", "correction", "appeal", "resume"]);
  if (!allowed.has(value?.kind)) throw new AdmissionError(400, "malformed_admission", "attempt.kind is invalid");
  const ordinal = units(value.ordinal, "attempt.ordinal");
  if (value.kind === "initial" && ordinal !== 0) {
    throw new AdmissionError(422, "invalid_attempt_ordinal", "Initial admission must use attempt ordinal zero");
  }
  if (value.kind !== "initial" && ordinal === 0) {
    throw new AdmissionError(422, "invalid_attempt_ordinal", "Non-initial admission must use a positive attempt ordinal");
  }
  return { kind: value.kind, ordinal };
}

function parseUsage(value: AdmissionUsage): AdmissionUsage {
  if (value?.status === "unknown") return { status: "unknown", reason: requiredString(value.reason, "usage.reason", 1_000) };
  if (value?.status === "known") {
    return { status: "known", source: requiredString(value.source, "usage.source", 1_000), units: units(value.units, "usage.units") };
  }
  throw new AdmissionError(400, "malformed_admission", "usage status must be known or unknown");
}

function parseRemainingExposure(value: AdmissionRemainingExposure): AdmissionRemainingExposure {
  if (value?.status === "unknown") return { status: "unknown", reason: requiredString(value.reason, "remainingExposure.reason", 1_000) };
  if (value?.status === "known") {
    return {
      status: "known",
      source: requiredString(value.source, "remainingExposure.source", 1_000),
      units: units(value.units, "remainingExposure.units"),
    };
  }
  throw new AdmissionError(400, "malformed_admission", "remainingExposure status must be known or unknown");
}

function table(ctx: PluginContext): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.admission_envelopes`;
}

const columns = "company_id, period_key, version, document, created_at, updated_at";

function parseDocument(value: unknown): AdmissionDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid admission document");
  const document = value as AdmissionDocument;
  if (document.schemaVersion !== 1 || !Array.isArray(document.reservations) || !Array.isArray(document.commandReceipts)) {
    throw new Error("Unsupported admission document");
  }
  for (const reservation of document.reservations) {
    if (!Number.isSafeInteger(reservation.lastKnownUsageUnits) || reservation.lastKnownUsageUnits < 0) {
      throw new Error("Admission reservation usage baseline is missing or invalid");
    }
  }
  return document;
}

function reservationExposureUnits(reservation: AdmissionReservation): number | null {
  if (reservation.status === "settled") return 0;
  if (reservation.status === "reserved") return reservation.requestedUnits;
  return reservation.remainingExposure.status === "known" ? reservation.remainingExposure.units : null;
}

function blockersFor(document: AdmissionDocument): AdmissionBlocker[] {
  const blockers: AdmissionBlocker[] = [];
  const now = Date.now();
  if (now < new Date(document.periodStart).valueOf() || now >= new Date(document.periodEnd).valueOf()) {
    blockers.push({ code: "period_inactive", message: "The configured admission period is not active." });
  }
  if (document.measurement.status === "unknown") blockers.push({ code: "measurement_unknown", message: document.measurement.reason });
  if (document.allowance.status === "unknown") blockers.push({ code: "allowance_unknown", message: document.allowance.reason });
  if (document.exposure.status === "unknown") blockers.push({ code: "exposure_unknown", message: document.exposure.reason });
  if (document.reservations.some((item) => item.status === "unsettled" && item.usage?.status === "unknown")) {
    blockers.push({ code: "unsettled_usage_unknown", message: "At least one reservation has unknown usage." });
  }
  if (document.reservations.some((item) => item.status === "unsettled" && item.remainingExposure.status === "unknown")) {
    blockers.push({ code: "unsettled_exposure_unknown", message: "At least one reservation has unknown remaining exposure." });
  }
  const accounted = accountedUnits(document);
  if (document.allowance.status === "known" && accounted !== null && accounted >= document.allowance.periodUnits) {
    blockers.push({ code: "period_allowance_exhausted", message: "The configured period allowance has no available units." });
  }
  const active = document.reservations.filter((item) => item.status !== "settled").length;
  if (active >= document.limits.maxConcurrent) {
    blockers.push({ code: "parallelism_exhausted", message: "The configured concurrent reservation limit is reached." });
  }
  return blockers;
}

function accountedUnits(document: AdmissionDocument): number | null {
  if (document.allowance.status !== "known" || document.exposure.status !== "known") return null;
  let result = document.allowance.knownUsageUnits + document.exposure.units;
  for (const reservation of document.reservations) {
    const remaining = reservationExposureUnits(reservation);
    if (remaining === null) return null;
    result += remaining;
  }
  return result;
}

function snapshotFromRow(row: AdmissionRow): AdmissionSnapshot {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid admission version");
  const document = parseDocument(row.document);
  const blockers = blockersFor(document);
  const accounted = accountedUnits(document);
  return {
    ...document,
    version,
    createdAt: storedTimestamp(row.created_at),
    updatedAt: storedTimestamp(row.updated_at),
    status: blockers.length === 0 ? "admissible" : "blocked",
    blockers,
    accountedUnits: accounted,
    availablePeriodUnits: document.allowance.status === "known" && accounted !== null
      ? Math.max(0, document.allowance.periodUnits - accounted)
      : null,
  };
}

function documentFromSnapshot(snapshot: AdmissionSnapshot): AdmissionDocument {
  return {
    schemaVersion: snapshot.schemaVersion,
    companyId: snapshot.companyId,
    periodKey: snapshot.periodKey,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    measurement: snapshot.measurement,
    allowance: snapshot.allowance,
    exposure: snapshot.exposure,
    limits: snapshot.limits,
    reservations: snapshot.reservations,
    commandReceipts: snapshot.commandReceipts,
  };
}

export async function readAdmission(
  ctx: PluginContext,
  input: { companyId: string; periodKey: string },
): Promise<AdmissionSnapshot | null> {
  const companyId = uuid(input.companyId, "companyId");
  const periodKey = requiredString(input.periodKey, "periodKey", 200);
  const rows = await ctx.db.query<AdmissionRow>(
    `SELECT ${columns} FROM ${table(ctx)} WHERE company_id = $1 AND period_key = $2`,
    [companyId, periodKey],
  );
  return rows[0] ? snapshotFromRow(rows[0]) : null;
}

async function requireAdmission(ctx: PluginContext, companyId: string, periodKey: string): Promise<AdmissionSnapshot> {
  const result = await readAdmission(ctx, { companyId, periodKey });
  if (!result) throw new AdmissionError(422, "admission_not_configured", "No admission envelope is configured for this company and period");
  return result;
}

async function casDocument(
  ctx: PluginContext,
  current: AdmissionSnapshot,
  document: AdmissionDocument,
): Promise<AdmissionSnapshot | null> {
  const result = await ctx.db.execute(
    `UPDATE ${table(ctx)} SET version = version + 1, document = $3::jsonb, updated_at = now()
      WHERE company_id = $1 AND period_key = $2 AND version = $4`,
    [current.companyId, current.periodKey, JSON.stringify(document), current.version],
  );
  if (result.rowCount !== 1) return null;
  return requireAdmission(ctx, current.companyId, current.periodKey);
}

function configurePayload(input: AdmissionConfigureInput) {
  const periodStart = timestamp(input.periodStart, "periodStart");
  const periodEnd = timestamp(input.periodEnd, "periodEnd");
  if (periodEnd <= periodStart) throw new AdmissionError(422, "invalid_period", "periodEnd must be later than periodStart");
  return {
    commandId: uuid(input.commandId, "commandId"),
    companyId: uuid(input.companyId, "companyId"),
    periodKey: requiredString(input.periodKey, "periodKey", 200),
    periodStart,
    periodEnd,
    measurement: parseMeasurement(input.measurement),
    allowance: parseAllowance(input.allowance),
    exposure: parseExposure(input.exposure),
    limits: parseLimits(input.limits),
  };
}

export async function configureAdmission(ctx: PluginContext, input: AdmissionConfigureInput): Promise<AdmissionResult> {
  const parsed = configurePayload(input);
  const hash = payloadHash(parsed);
  const existing = await readAdmission(ctx, parsed);
  if (existing) {
    const receipt = existing.commandReceipts.find((item) => item.commandId === parsed.commandId);
    if (receipt) {
      if (receipt.payloadHash !== hash) throw new AdmissionError(409, "command_identity_conflict", "commandId was already used with another admission configuration");
      return { outcome: "replayed", envelope: existing };
    }
    if (input.expectedVersion === undefined) {
      throw new AdmissionError(409, "admission_already_configured", "Admission is already configured for this company and period", { current: existing });
    }
    if (existing.version !== positiveInteger(input.expectedVersion, "expectedVersion")) {
      throw new AdmissionError(409, "version_conflict", "Admission configuration version is stale", { current: existing });
    }
    if (existing.commandReceipts.length >= MAX_RECEIPTS) {
      throw new AdmissionError(409, "command_limit_reached", `Admission command receipt limit of ${MAX_RECEIPTS} is reached`);
    }
    if (existing.reservations.length > 0) {
      throw new AdmissionError(409, "configuration_in_use", "A period with reservation history cannot be reconfigured");
    }
    const at = new Date().toISOString();
    const document: AdmissionDocument = {
      schemaVersion: 1,
      companyId: parsed.companyId,
      periodKey: parsed.periodKey,
      periodStart: parsed.periodStart,
      periodEnd: parsed.periodEnd,
      measurement: parsed.measurement,
      allowance: parsed.allowance,
      exposure: parsed.exposure,
      limits: parsed.limits,
      reservations: [],
      commandReceipts: [...existing.commandReceipts, {
        commandId: parsed.commandId,
        command: "configure" as const,
        payloadHash: hash,
        appliedVersion: existing.version + 1,
        recordedAt: at,
      }],
    };
    const updated = await casDocument(ctx, existing, document);
    if (!updated) throw new AdmissionError(409, "version_conflict", "Admission configuration changed concurrently", { current: await readAdmission(ctx, parsed) });
    return { outcome: "configured", envelope: updated };
  }

  if (input.expectedVersion !== undefined) {
    throw new AdmissionError(409, "version_conflict", "Admission configuration does not exist at the expected version");
  }
  const at = new Date().toISOString();
  const document: AdmissionDocument = {
    schemaVersion: 1,
    companyId: parsed.companyId,
    periodKey: parsed.periodKey,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    measurement: parsed.measurement,
    allowance: parsed.allowance,
    exposure: parsed.exposure,
    limits: parsed.limits,
    reservations: [],
    commandReceipts: [{ commandId: parsed.commandId, command: "configure", payloadHash: hash, appliedVersion: 1, recordedAt: at }],
  };
  const inserted = await ctx.db.execute(
    `INSERT INTO ${table(ctx)} (company_id, period_key, document)
      VALUES ($1, $2, $3::jsonb) ON CONFLICT (company_id, period_key) DO NOTHING`,
    [parsed.companyId, parsed.periodKey, JSON.stringify(document)],
  );
  const current = await requireAdmission(ctx, parsed.companyId, parsed.periodKey);
  if (inserted.rowCount !== 1) {
    const receipt = current.commandReceipts.find((item) => item.commandId === parsed.commandId);
    if (receipt?.payloadHash === hash) return { outcome: "replayed", envelope: current };
    throw new AdmissionError(409, "admission_already_configured", "Admission was configured concurrently", { current });
  }
  return { outcome: "configured", envelope: current };
}

function reservationBinding(input: AdmissionReserveInput) {
  return {
    reservationId: uuid(input.reservationId, "reservationId"),
    missionId: uuid(input.missionId, "missionId"),
    effectId: uuid(input.effectId, "effectId"),
    requestedUnits: units(input.requestedUnits, "requestedUnits", false),
    attempt: parseAttempt(input.attempt),
  };
}

function sameReservation(reservation: AdmissionReservation, binding: ReturnType<typeof reservationBinding>): boolean {
  return reservation.bindingHash === payloadHash(binding)
    && reservation.missionId === binding.missionId
    && reservation.effectId === binding.effectId
    && reservation.requestedUnits === binding.requestedUnits
    && reservation.attempt.kind === binding.attempt.kind
    && reservation.attempt.ordinal === binding.attempt.ordinal;
}

function reservationReplayOrConflict(current: AdmissionSnapshot, binding: ReturnType<typeof reservationBinding>): AdmissionReservation | null {
  const found = current.reservations.find((item) => item.reservationId === binding.reservationId);
  if (!found) return null;
  if (!sameReservation(found, binding)) {
    throw new AdmissionError(409, "reservation_identity_conflict", "reservationId is already bound to another mission, effect, amount, or attempt");
  }
  return found;
}

function assertAttemptWithinLimits(attempt: AdmissionAttempt, limits: AdmissionLimits): void {
  if (attempt.kind === "correction" && attempt.ordinal > limits.maxCorrections) {
    throw new AdmissionError(422, "correction_limit_exceeded", "The configured correction limit rejects this admission");
  }
  if (["retry", "appeal", "resume"].includes(attempt.kind) && attempt.ordinal > limits.maxRetries) {
    throw new AdmissionError(422, "retry_limit_exceeded", "The configured retry limit rejects this admission");
  }
}

export async function reserveAdmission(ctx: PluginContext, input: AdmissionReserveInput): Promise<AdmissionResult> {
  const companyId = uuid(input.companyId, "companyId");
  const periodKey = requiredString(input.periodKey, "periodKey", 200);
  const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
  const binding = reservationBinding(input);
  const current = await requireAdmission(ctx, companyId, periodKey);
  const replay = reservationReplayOrConflict(current, binding);
  if (replay) return { outcome: "replayed", envelope: current, reservation: replay };
  if (current.version !== expectedVersion) throw new AdmissionError(409, "version_conflict", "Admission version is stale", { current });
  if (current.status === "blocked") throw new AdmissionError(422, "admission_blocked", "Admission prerequisites are not satisfied", { blockers: current.blockers, current });
  if (current.allowance.status !== "known") throw new AdmissionError(422, "allowance_unknown", "Allowance must be known before reservation");
  if (binding.requestedUnits > current.allowance.taskUnits) {
    throw new AdmissionError(422, "task_allowance_exceeded", "Requested units exceed the configured task allowance");
  }
  assertAttemptWithinLimits(binding.attempt, current.limits);
  if (current.accountedUnits === null || current.accountedUnits + binding.requestedUnits > current.allowance.periodUnits) {
    throw new AdmissionError(422, "period_allowance_exceeded", "Requested units exceed the available period allowance");
  }
  const at = new Date().toISOString();
  const reservation: AdmissionReservation = {
    ...binding,
    bindingHash: payloadHash(binding),
    status: "reserved",
    reservedAt: at,
    updatedAt: at,
    usage: null,
    lastKnownUsageUnits: 0,
    remainingExposure: { status: "known", source: "admission reservation", units: binding.requestedUnits },
    settlementReceipts: [],
  };
  const document: AdmissionDocument = {
    ...documentFromSnapshot(current),
    reservations: [...current.reservations, reservation],
  };
  const updated = await casDocument(ctx, current, document);
  if (updated) return { outcome: "reserved", envelope: updated, reservation };

  const concurrent = await requireAdmission(ctx, companyId, periodKey);
  const concurrentReplay = reservationReplayOrConflict(concurrent, binding);
  if (concurrentReplay) return { outcome: "replayed", envelope: concurrent, reservation: concurrentReplay };
  throw new AdmissionError(409, "version_conflict", "A competing admission changed the envelope; no reservation was created", { current: concurrent });
}

function settlementPayload(input: AdmissionSettleInput) {
  return {
    commandId: uuid(input.commandId, "commandId"),
    companyId: uuid(input.companyId, "companyId"),
    periodKey: requiredString(input.periodKey, "periodKey", 200),
    reservationId: uuid(input.reservationId, "reservationId"),
    usage: parseUsage(input.usage),
    remainingExposure: parseRemainingExposure(input.remainingExposure),
  };
}

function findReservation(snapshot: AdmissionSnapshot, reservationId: string): AdmissionReservation {
  const reservation = snapshot.reservations.find((item) => item.reservationId === reservationId);
  if (!reservation) throw new AdmissionError(404, "reservation_not_found", "Admission reservation not found");
  return reservation;
}

export async function settleAdmission(ctx: PluginContext, input: AdmissionSettleInput): Promise<AdmissionResult> {
  const parsed = settlementPayload(input);
  const expectedVersion = positiveInteger(input.expectedVersion, "expectedVersion");
  const hash = payloadHash(parsed);
  const current = await requireAdmission(ctx, parsed.companyId, parsed.periodKey);
  const existing = findReservation(current, parsed.reservationId);
  const receipt = existing.settlementReceipts.find((item) => item.commandId === parsed.commandId);
  if (receipt) {
    if (receipt.payloadHash !== hash) throw new AdmissionError(409, "command_identity_conflict", "commandId was already used with another settlement payload");
    return { outcome: "replayed", envelope: current, reservation: existing };
  }
  if (current.version !== expectedVersion) throw new AdmissionError(409, "version_conflict", "Admission version is stale", { current });
  if (existing.settlementReceipts.length >= MAX_RECEIPTS) {
    throw new AdmissionError(409, "command_limit_reached", `Admission settlement receipt limit of ${MAX_RECEIPTS} is reached`);
  }

  const previousKnownUsage = existing.lastKnownUsageUnits;
  if (parsed.usage.status === "known" && parsed.usage.units < previousKnownUsage) {
    throw new AdmissionError(422, "usage_regression", "Cumulative reservation usage cannot decrease");
  }
  if (current.allowance.status === "unknown" && parsed.usage.status === "known" && parsed.usage.units > previousKnownUsage) {
    throw new AdmissionError(422, "allowance_unknown", "Known usage cannot be reconciled into an unknown allowance");
  }
  const nextVersion = current.version + 1;
  const at = new Date().toISOString();
  const settled = parsed.usage.status === "known"
    && parsed.remainingExposure.status === "known"
    && parsed.remainingExposure.units === 0;
  const updatedReservation: AdmissionReservation = {
    ...existing,
    status: settled ? "settled" : "unsettled",
    updatedAt: at,
    usage: parsed.usage,
    lastKnownUsageUnits: parsed.usage.status === "known" ? parsed.usage.units : previousKnownUsage,
    remainingExposure: parsed.remainingExposure,
    settlementReceipts: [...existing.settlementReceipts, {
      commandId: parsed.commandId,
      command: "settle" as const,
      payloadHash: hash,
      appliedVersion: nextVersion,
      recordedAt: at,
      settlement: {
        usage: parsed.usage,
        remainingExposure: parsed.remainingExposure,
      },
    }],
  };
  let allowance = current.allowance;
  if (allowance.status === "known" && parsed.usage.status === "known") {
    allowance = { ...allowance, knownUsageUnits: allowance.knownUsageUnits + parsed.usage.units - previousKnownUsage };
  }
  const document: AdmissionDocument = {
    ...documentFromSnapshot(current),
    allowance,
    reservations: current.reservations.map((item) => item.reservationId === parsed.reservationId ? updatedReservation : item),
  };
  const updated = await casDocument(ctx, current, document);
  if (updated) return { outcome: "settled", envelope: updated, reservation: updatedReservation };

  const concurrent = await requireAdmission(ctx, parsed.companyId, parsed.periodKey);
  const concurrentReservation = findReservation(concurrent, parsed.reservationId);
  const concurrentReceipt = concurrentReservation.settlementReceipts.find((item) => item.commandId === parsed.commandId);
  if (concurrentReceipt?.payloadHash === hash) {
    return { outcome: "replayed", envelope: concurrent, reservation: concurrentReservation };
  }
  if (concurrentReceipt) throw new AdmissionError(409, "command_identity_conflict", "commandId was settled concurrently with another payload");
  throw new AdmissionError(409, "version_conflict", "A competing settlement changed the envelope; this settlement was not recorded", { current: concurrent });
}
