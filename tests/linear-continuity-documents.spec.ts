import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { ensureLinearDocument } from "../src/linear-continuity-documents.js";

// Simulate JSONB's object-key reordering while preserving array order and values.
function jsonbRoundtrip<T>(value: T): T {
  const reorder = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(reorder);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.length - right.length || left.localeCompare(right))
      .map(([key, child]) => [key, reorder(child)]));
  };
  return JSON.parse(JSON.stringify(reorder(value))) as T;
}

function fixture() {
  const m = { companyId: randomUUID(), missionId: randomUUID(), rootIssueId: randomUUID() } as MissionRecord;
  const payload = { source: "fixed", nested: { z: 2, a: { z: "retained", a: "source" } }, items: [{ z: 3, a: 1 }, null] };
  const docs = new Map<string, { id: string; latestRevisionId: string; body: string }>();
  const upsert = vi.fn(async (input: { key: string; body: string }) => {
    const doc = { id: randomUUID(), latestRevisionId: randomUUID(), body: input.body };
    docs.set(input.key, doc); return structuredClone(doc);
  });
  const ctx = { issues: { documents: { get: async (_issue: string, key: string) => structuredClone(docs.get(key) ?? null), upsert } } } as any;
  return { m, payload, docs, upsert, ctx, key: "council-linear-retained-exchange" };
}

it("accepts nested JSONB payload reordering while retaining the exact pinned document bytes", async () => {
  const f = fixture(), originalBody = JSON.stringify(f.payload);
  const pinned = await ensureLinearDocument(f.ctx, f.m, f.key, f.payload);
  const reloaded = jsonbRoundtrip(f.payload);
  expect(JSON.stringify(reloaded)).not.toBe(originalBody);
  await expect(ensureLinearDocument(f.ctx, f.m, f.key, reloaded, jsonbRoundtrip(pinned))).resolves.toEqual(pinned);
  expect(f.docs.get(f.key)!.body).toBe(originalBody);
  expect(pinned.bodySha256).toBe(canonicalPayloadHash(originalBody));
  expect(f.upsert).toHaveBeenCalledTimes(1);
});

it("recovers a lost upsert response under the same key before the document reference was pinned", async () => {
  const f = fixture();
  f.upsert.mockImplementationOnce(async input => {
    f.docs.set(input.key, { id: randomUUID(), latestRevisionId: randomUUID(), body: input.body });
    throw new Error("lost upsert response");
  });
  await expect(ensureLinearDocument(f.ctx, f.m, f.key, f.payload)).rejects.toThrow("lost upsert response");
  const original = structuredClone(f.docs.get(f.key)!);
  await expect(ensureLinearDocument(f.ctx, f.m, f.key, jsonbRoundtrip(f.payload))).resolves.toEqual({ key: f.key,
    documentId: original.id, revisionId: original.latestRevisionId, bodySha256: canonicalPayloadHash(original.body) });
  expect(f.docs.get(f.key)).toEqual(original); expect(f.upsert).toHaveBeenCalledTimes(1);
});

it.each(["documentId", "revisionId", "bytes"])("refuses changed pinned %s even when the payload remains equivalent", async field => {
  const f = fixture(), pinned = await ensureLinearDocument(f.ctx, f.m, f.key, f.payload);
  const doc = f.docs.get(f.key)!;
  if (field === "documentId") doc.id = randomUUID();
  if (field === "revisionId") doc.latestRevisionId = randomUUID();
  if (field === "bytes") doc.body = JSON.stringify(jsonbRoundtrip(f.payload));
  await expect(ensureLinearDocument(f.ctx, f.m, f.key, f.payload, pinned)).rejects.toMatchObject({ code: "linear_continuity_document_changed" });
  expect(f.upsert).toHaveBeenCalledTimes(1);
});

it.each([true, false])("refuses changed semantic content with pinned=%s without overwriting the document", async isPinned => {
  const f = fixture(), pinned = await ensureLinearDocument(f.ctx, f.m, f.key, f.payload), original = structuredClone(f.docs.get(f.key));
  const changed = jsonbRoundtrip(f.payload); changed.nested.a.z = "different source";
  await expect(ensureLinearDocument(f.ctx, f.m, f.key, changed, isPinned ? pinned : undefined)).rejects.toMatchObject({
    code: isPinned ? "linear_continuity_payload_changed" : "linear_continuity_document_unknown",
  });
  expect(f.docs.get(f.key)).toEqual(original); expect(f.upsert).toHaveBeenCalledTimes(1);
});
