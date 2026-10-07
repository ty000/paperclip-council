import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { publishContinuityObservation, readContinuityObservation } from "../src/continuity-observation.js";

function fixture() {
  let stored: unknown = null;
  const docs = new Map<string, { body: string }>();
  const m = { companyId: "company", missionId: "mission", rootIssueId: "root", aggregate: { continuity: {} } } as unknown as MissionRecord;
  const upsert = vi.fn(async (input: { key: string; body: string }) => {
    if (docs.has(input.key)) throw new Error("SDK updates are unavailable");
    docs.set(input.key, { body: input.body }); return docs.get(input.key)!;
  });
  const context = () => ({ state: { get: async () => stored && JSON.parse(JSON.stringify(stored, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return value;
  })), set: async (_scope: unknown, value: unknown) => { stored = structuredClone(value); } },
    issues: { documents: { get: async (_id: unknown, key: string) => docs.get(key) ?? null, upsert } } }) as unknown as PluginContext;
  const blocked = { state: "blocked" as const, code: "unadmitted_native_run", nextAction: "Inspecter l'état conservé." };
  return { m, docs, upsert, context, blocked };
}
describe("immutable native status documents and durable current observation", () => {
  it("recovers a lost create response after restart with the original key and no SDK update", async () => {
    const f = fixture();
    f.upsert.mockImplementationOnce(async input => { f.docs.set(input.key, { body: input.body }); throw new Error("lost response"); });
    await expect(publishContinuityObservation(f.context(), f.m, f.blocked)).rejects.toThrow("lost response");
    const pending = await readContinuityObservation(f.context(), f.m); expect(pending?.documentObserved).toBe(false);
    await publishContinuityObservation(f.context(), f.m, f.blocked);
    const confirmed = await readContinuityObservation(f.context(), f.m);
    expect(confirmed?.documentObserved).toBe(true); expect(confirmed?.documentKey).toBe(pending?.documentKey);
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
  it("records meaningful recurring transitions in order and stays quiet for unchanged states", async () => {
    const f = fixture(); const ctx = f.context();
    await publishContinuityObservation(ctx, f.m, f.blocked);
    await publishContinuityObservation(ctx, f.m, f.blocked);
    const original = structuredClone([...f.docs.entries()]);
    await publishContinuityObservation(ctx, f.m, { state: "complete", code: "accepted", nextAction: "Le mandat est rempli." });
    await publishContinuityObservation(ctx, f.m, f.blocked);
    expect((await readContinuityObservation(ctx, f.m))?.sequence).toBe(3);
    expect(f.upsert).toHaveBeenCalledTimes(3); expect(f.docs.size).toBe(3);
    expect(f.docs.get(original[0]![0])).toEqual(original[0]![1]);
  });
  it.each(["missing", "changed"])("does not replace a confirmed document whose body is %s", async kind => {
    const f = fixture(); const ctx = f.context(); await publishContinuityObservation(ctx, f.m, f.blocked);
    const key = (await readContinuityObservation(ctx, f.m))!.documentKey;
    if (kind === "missing") f.docs.delete(key); else f.docs.set(key, { body: "operator changed body" });
    await expect(publishContinuityObservation(ctx, f.m, f.blocked)).rejects.toThrow();
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
});
