import { beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { publishContinuityObservation } from "../src/continuity-observation.js";

const f = vi.hoisted(() => ({ m: null as any, stored: null as any, docs: new Map<string, any>(), failCas: false }));
vi.mock("../src/missions.js", async () => ({ ...await import("../src/mission-primitives.js"), getMission: async () => structuredClone(f.m) }));
vi.mock("../src/n2-missions.js", () => ({ n2Cas: async (_ctx: any, m: any, aggregate: any) => {
  if (f.failCas) { f.failCas = false; throw new Error("lost status handoff"); }
  if (m.version !== f.m.version) throw new Error("CAS conflict");
  f.m = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.m);
} }));
const ctx = { state: { get: async () => structuredClone(f.stored), set: async (_scope: any, value: any) => { f.stored = structuredClone(value); } },
  issues: { documents: { get: async (_issue: any, key: string) => structuredClone(f.docs.get(key) ?? null), upsert: async (input: any) => {
    const doc = { ...input, id: randomUUID(), latestRevisionId: randomUUID() }; f.docs.set(input.key, doc); return doc;
  } } } } as any;
const blocked = { state: "blocked" as const, code: "g4_unknown_effect", nextAction: "Inspect the original retained effect" };
beforeEach(() => {
  f.docs.clear(); f.stored = null; f.failCas = false;
  f.m = { companyId: randomUUID(), missionId: randomUUID(), rootIssueId: randomUUID(), version: 1,
    aggregate: { continuity: {}, linearContinuity: { binding: {}, sourceSha256: "d".repeat(64), publications: [] } } };
});
it("retains a native blocker with its document and original publication identity across restart", async () => {
  await publishContinuityObservation(ctx, f.m, blocked);
  const publication = f.m.aggregate.linearContinuity.publications[0];
  expect(publication.kind).toBe("blocker"); expect(publication.payload.observation).toEqual(blocked);
  expect(publication.payload.evidence.revisionId).toBe(f.docs.get(f.stored.documentKey).latestRevisionId);
  await publishContinuityObservation(ctx, structuredClone(f.m), blocked);
  expect(f.m.aggregate.linearContinuity.publications).toHaveLength(1);
  expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(publication.intentId);
});
it("recovers the previous native observation before publishing a newer status after a lost handoff", async () => {
  f.failCas = true;
  await expect(publishContinuityObservation(ctx, f.m, blocked)).rejects.toThrow("lost status handoff");
  const key = f.stored.documentKey;
  await publishContinuityObservation(ctx, structuredClone(f.m), { state: "progressed", code: "settled", nextAction: "Original cost is known" });
  const publications = f.m.aggregate.linearContinuity.publications;
  expect(publications).toHaveLength(2);
  expect(publications[0].payload.evidence.key).toBe(key);
  expect(publications.map((p: any) => p.kind)).toEqual(["blocker", "progress"]);
});
