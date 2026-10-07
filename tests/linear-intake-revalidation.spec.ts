import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { operatingProfileHash, type ProjectMandate } from "../src/project-mandate-state.js";
import { assertLinearSource, handleLinearSourceResult } from "../src/linear-intake-revalidation.js";
import { LINEAR_RESULT_EVENT, linearSourceRequestSchema, linearSourceResultSchema, validSourceResultTime,
  type LinearSourceRequest, type LinearSourceSubject } from "../src/linear-intake-revalidation-contract.js";

const vector = JSON.parse(readFileSync(new URL("./fixtures/linear-intake-revalidation.json", import.meta.url), "utf8"));
const subject: LinearSourceSubject = Object.fromEntries(Object.entries(vector.request).filter(([key]) =>
  !["schema", "challengeId", "nonce", "stage", "admissionId", "mandateId", "mandateRevisionSha256", "requestedAt", "expiresAt"].includes(key))) as LinearSourceSubject;
const policy = { companyId: subject.companyId, projectId: subject.targetProjectId, revisionId: vector.request.mandateId,
  authorizedBy: "isolated-owner", version: 1, content: { enabled: true, operatingProfileHash: operatingProfileHash({}) } } as ProjectMandate;

function fixture() {
  const rows: any[] = [], emissions: any[] = [];
  let owner = policy.authorizedBy, enabled = true;
  const ctx = {
    companies: { get: async () => ({ defaultResponsibleUserId: owner }) }, config: { get: async () => ({}) },
    events: { emit: vi.fn(async (name, _company, request) => {
      expect(name).toBe("linear-intake-revalidation-request");
      expect(rows.some(row => row.challenge_id === request.challengeId)).toBe(true);
      emissions.push(structuredClone(request));
    }) },
    db: { namespace: "plugin_council", query: vi.fn(async (sql: string, args: any[]) => {
      if (sql.includes("project_mandates")) return [{ company_id: policy.companyId, project_id: policy.projectId, version: 1,
        revision_id: policy.revisionId, authorized_by: policy.authorizedBy, content: { ...policy.content, enabled } }];
      return structuredClone(sql.includes("ORDER BY generation")
        ? rows.filter(r => r.company_id === args[0] && r.mission_id === args[1] && r.stage === args[2]).slice(-1)
        : rows.filter(r => r.company_id === args[0] && r.challenge_id === args[1]));
    }), execute: vi.fn(async (sql: string, args: any[]) => {
      if (sql.startsWith("INSERT")) {
        if (rows.some(r => r.company_id === args[1] && r.mission_id === args[2] && r.stage === args[3] && r.generation === args[4])) return { rowCount: 0 };
        rows.push({ challenge_id: args[0], company_id: args[1], mission_id: args[2], stage: args[3], generation: args[4],
          subject_hash: args[5], request_hash: args[6], request: JSON.parse(args[7]), response: null, response_hash: null,
          consumed_at: null, observed_at: null, last_emitted_at: null }); return { rowCount: 1 };
      }
      if (sql.includes("SET last_emitted_at")) {
        const row = rows.find(r => r.challenge_id === args[0]);
        if (!row || row.response || row.consumed_at || row.last_emitted_at !== null && row.last_emitted_at >= Date.now() - 30_000) return { rowCount: 0 };
        row.last_emitted_at = Date.now(); return { rowCount: 1 };
      }
      if (sql.includes("SET consumed_at")) {
        const row = rows.find(r => r.challenge_id === args[0]);
        if (!row || row.consumed_at || row.response_hash !== args[1] || Date.parse(args[2]) <= Date.now()) return { rowCount: 0 };
        row.consumed_at = new Date().toISOString(); return { rowCount: 1 };
      }
      const row = rows.find(r => r.company_id === args[3] && r.challenge_id === args[4]);
      if (!row || row.consumed_at || row.observed_at && row.observed_at >= args[2] && args[5] !== "blocked") return { rowCount: 0 };
      Object.assign(row, { response: JSON.parse(args[0]), response_hash: args[1], observed_at: args[2] }); return { rowCount: 1 };
    }) },
  } as unknown as PluginContext;
  const gate = (input = subject, stage: "preparation" | "admission" = "preparation") => assertLinearSource(ctx, policy, vector.request.admissionId, input, stage);
  return { ctx, rows, emissions, gate, changeOwner: () => { owner = "replacement-owner"; }, suspend: () => { enabled = false; } };
}
function answer(request: LinearSourceRequest, override: Record<string, unknown> = {}): PluginEvent {
  return { eventId: vector.request.challengeId, eventType: LINEAR_RESULT_EVENT, actorType: "plugin", actorId: "ty000.linear-intake",
    companyId: request.companyId, occurredAt: new Date().toISOString(), payload: {
      schema: "linear-intake-revalidation-result.v1", request, requestSha256: canonicalPayloadHash(request),
      status: "confirmed", reason: "handoff_confirmed", observedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 120_000).toISOString(), ...override,
    } };
}
async function requested(f: ReturnType<typeof fixture>) {
  await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
  return f.emissions[0] as LinearSourceRequest;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-07T12:01:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("Linear importer authenticated freshness gate", () => {
  it("shares the exact portable importer contract vector and canonical digest", () => {
    expect(linearSourceRequestSchema.parse(vector.request)).toEqual(vector.request);
    expect(linearSourceResultSchema.parse(vector.result)).toEqual(vector.result);
    expect(canonicalPayloadHash(vector.request)).toBe(vector.result.requestSha256);
    expect(validSourceResultTime(vector.result, Date.now())).toBe(true);
  });
  it("persists the nonce before emit and retries a lost notification with that nonce after restart", async () => {
    const f = fixture(), request = await requested(f);
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
    expect(f.emissions).toHaveLength(1);
    vi.advanceTimersByTime(31_000);
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
    expect(f.emissions).toEqual([request, request]); expect(f.rows).toHaveLength(1);
  });
  it("consumes one fresh answer, then requires a fresh observation under the same mission identity", async () => {
    const f = fixture(), request = await requested(f);
    await handleLinearSourceResult(f.ctx, answer(request));
    const receipt = await f.gate(); expect(receipt.challengeId).toBe(request.challengeId);
    await handleLinearSourceResult(f.ctx, answer(request));
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
    expect(f.rows).toHaveLength(2); expect(f.rows[1].request.admissionId).toBe(request.admissionId);
    expect(f.rows[1].request.nonce).not.toBe(request.nonce);
  });
  it.each(["actor", "namespace", "company", "nonce", "stage", "hash", "future", "expired", "reason", "oversized"])("ignores an invalid %s response", async kind => {
    const f = fixture(), request = await requested(f), event = answer(request), payload = event.payload as any;
    if (kind === "actor") event.actorId = "another-plugin";
    if (kind === "namespace") event.eventType = "plugin.other.linear-intake-revalidation-result";
    if (kind === "company") event.companyId = vector.request.admissionId;
    if (kind === "nonce") { payload.request = { ...request, nonce: "a".repeat(64) }; payload.requestSha256 = canonicalPayloadHash(payload.request); }
    if (kind === "stage") { payload.request = { ...request, stage: "admission" }; payload.requestSha256 = canonicalPayloadHash(payload.request); }
    if (kind === "hash") payload.requestSha256 = "b".repeat(64);
    if (kind === "future") payload.observedAt = new Date(Date.now() + 1).toISOString();
    if (kind === "expired") payload.validUntil = new Date().toISOString();
    if (kind === "reason") payload.reason = "handoff_source_withdrawn";
    if (kind === "oversized") payload.reason = "x".repeat(9000);
    await handleLinearSourceResult(f.ctx, event); expect(f.rows[0].response).toBeNull();
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
  });
  it("keeps a fresh negative answer ineligible even after duplicate signals", async () => {
    const f = fixture(), request = await requested(f), blocked = answer(request, { status: "blocked", reason: "handoff_source_withdrawn" });
    await handleLinearSourceResult(f.ctx, blocked); await handleLinearSourceResult(f.ctx, blocked);
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_blocked" });
    expect(f.rows).toHaveLength(1); expect(f.rows[0].consumed_at).toBeNull();
  });
  it("does not let an older positive response replace a newer negative one", async () => {
    const f = fixture(), request = await requested(f), positive = answer(request);
    vi.advanceTimersByTime(10);
    await handleLinearSourceResult(f.ctx, answer(request, { status: "blocked", reason: "handoff_source_withdrawn" }));
    await handleLinearSourceResult(f.ctx, positive);
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_blocked" });
  });
  it.each(["owner", "mandate"])("rechecks %s before consuming an otherwise valid answer", async kind => {
    const f = fixture(), request = await requested(f);
    await handleLinearSourceResult(f.ctx, answer(request));
    if (kind === "owner") f.changeOwner(); else f.suspend();
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_authority_changed" });
    expect(f.rows[0].consumed_at).toBeNull();
  });
  it("renews an expired observation without changing the mission, but rejects source-subject replacement", async () => {
    const f = fixture(), request = await requested(f);
    await handleLinearSourceResult(f.ctx, answer(request)); vi.advanceTimersByTime(120_000);
    await expect(f.gate()).rejects.toMatchObject({ code: "linear_source_pending" });
    expect(f.rows).toHaveLength(2); expect(f.rows[0].consumed_at).toBeNull();
    await expect(f.gate({ ...subject, sourceSha256: "f".repeat(64) })).rejects.toMatchObject({ code: "linear_source_subject_changed" });
    expect(f.rows).toHaveLength(2);
  });
  it("separates preparation proof from admission proof", async () => {
    const f = fixture(), request = await requested(f); await handleLinearSourceResult(f.ctx, answer(request));
    await expect(f.gate(subject, "admission")).rejects.toMatchObject({ code: "linear_source_pending" });
    expect(f.rows[0].consumed_at).toBeNull(); expect(f.rows[1].request.stage).toBe("admission");
  });
});
