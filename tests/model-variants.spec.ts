import { randomUUID } from "node:crypto";
import type { Agent, PluginContext, PluginManagedAgentResolution, PluginManagedSkillResolution } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { COUNCIL_REVIEW_SKILL_KEY, logicalAnchorKey, managedAgentDeclarations, variantKey } from "../src/model-catalogue.js";
import { inspectVariant, inspectPreparedVariants, setupVariant, setupVariants } from "../src/model-variants.js";

const companyId = "company-fixture";
function fixture() {
  const agents = new Map<string, PluginManagedAgentResolution>();
  let skill: PluginManagedSkillResolution = { pluginKey: "private.paperclip-council", resourceKind: "skill", resourceKey: "council-review", companyId, skillId: null, skill: null, status: "missing", defaultDrift: null };
  const put = (key: string, status: Agent["status"] = "idle") => {
    const declaration = managedAgentDeclarations().find(v => v.agentKey === key)!;
    const id = randomUUID();
    const result: PluginManagedAgentResolution = { pluginKey: "private.paperclip-council", resourceKind: "agent", resourceKey: key, companyId, agentId: id,
      status: "resolved", defaultDrift: null, agent: { id, companyId, status,
        name: declaration.displayName, urlKey: key, role: declaration.role as Agent["role"], title: declaration.title ?? null,
        icon: null, reportsTo: null, capabilities: null, budgetMonthlyCents: 0, spentMonthlyCents: 0,
        pauseReason: null, pausedAt: null, lastHeartbeatAt: null, metadata: null,
        createdAt: new Date(0), updatedAt: new Date(0),
        adapterType: "codex_local", adapterConfig: { ...structuredClone(declaration.adapterConfig), instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" },
        runtimeConfig: structuredClone(declaration.runtimeConfig ?? {}), permissions: { canCreateAgents: false, canCreateSkills: false, ...declaration.permissions } } };
    agents.set(key, result); return result;
  };
  const get = vi.fn(async (key: string) => agents.get(key) ?? { pluginKey: "private.paperclip-council", resourceKind: "agent", resourceKey: key, companyId, agentId: null, agent: null, status: "missing", defaultDrift: null });
  const reconcile = vi.fn(async (key: string) => put(key));
  const skillGet = vi.fn(async () => skill);
  const skillReconcile = vi.fn(async () => {
    skill = { ...skill, status: "created", skillId: randomUUID(), skill: { key: COUNCIL_REVIEW_SKILL_KEY, companyId, currentVersionId: randomUUID() } as never };
    return skill;
  });
  const reset = vi.fn(() => { throw new Error("Reset is forbidden"); });
  const ctx = { agents: { managed: { get, reconcile, reset } }, skills: { managed: { get: skillGet, reconcile: skillReconcile, reset } } } as unknown as PluginContext;
  return { ctx, agents, put, get, reconcile, skillGet, skillReconcile, reset };
}

describe("native variant setup and readback", () => {
  it("inspects unprepared inventory without any provisioning effect", async () => {
    const f = fixture(); const inventory = await inspectPreparedVariants(f.ctx, companyId);
    expect(inventory).toHaveLength(managedAgentDeclarations().length);
    expect(inventory.every(v => !v.ready && v.agentId === null && v.gaps.includes("logical_anchor_missing"))).toBe(true);
    expect(f.reconcile).not.toHaveBeenCalled(); expect(f.skillReconcile).not.toHaveBeenCalled(); expect(f.reset).not.toHaveBeenCalled();
  });
  it("creates missing resources only, retains a real UUID anchor and reads back without wake/reset", async () => {
    const f = fixture();
    const first = await setupVariant(f.ctx, companyId, "generalist-reviewer", "sol-high", "1");
    expect(first.ready).toBe(true); expect(first.logicalAgentId).not.toBe(first.agentId);
    expect(first.observed.accountAvailability).toBe("not_validated_live");
    expect(first.observed.availability).toBe("configured");
    expect(f.reconcile.mock.calls.map(call => call[0])).toEqual([logicalAnchorKey("generalist-reviewer"), variantKey("generalist-reviewer", "sol-high")]);
    expect(f.skillReconcile).toHaveBeenCalledTimes(1);
    const replay = await setupVariant(f.ctx, companyId, "generalist-reviewer", "sol-high", "1");
    expect(replay).toEqual(first); expect(f.reconcile).toHaveBeenCalledTimes(2); expect(f.reset).not.toHaveBeenCalled();
  });
  it("resolves profile variants through the fixed anchor rather than physical agent/display name", async () => {
    const f = fixture(); const anchor = f.put(logicalAnchorKey("lead")); const high = f.put(variantKey("lead", "astra-high"));
    const check = await inspectVariant(f.ctx, companyId, anchor.agentId!, "astra-high", "1");
    expect(check).toMatchObject({ ready: true, logicalAgentId: anchor.agentId, agentId: high.agentId, roleKey: "lead" });
    await expect(inspectVariant(f.ctx, companyId, high.agentId!, "astra-high", "1")).rejects.toMatchObject({ code: "logical_identity_unknown" });
    expect(f.reconcile).not.toHaveBeenCalled();
  });
  it("blocks real instruction, model, permission and periodic-work drift without repairing it", async () => {
    const f = fixture(); const anchor = f.put(logicalAnchorKey("lead"));
    const target = f.put(variantKey("lead", "sol-high"));
    target.agent!.adapterConfig.model = "other-model";
    target.agent!.adapterConfig.extraArgs = ["--model", "other-model"];
    target.agent!.runtimeConfig.heartbeat = { enabled: true };
    target.agent!.permissions.canCreateAgents = true;
    target.defaultDrift = { entryFile: "AGENTS.md", changedFiles: ["AGENTS.md"] };
    const check = await setupVariant(f.ctx, companyId, "lead", "sol-high");
    expect(check.logicalAgentId).toBe(anchor.agentId); expect(check.ready).toBe(false);
    expect(check.gaps).toEqual(expect.arrayContaining(["adapter_config_drift:model", "adapter_config_drift:extraArgs", "heartbeat_policy_drift", "permissions_drift", "instructions_drift"]));
    expect(check.observed.availability).toBe("blocked");
    expect(f.reconcile).not.toHaveBeenCalled(); expect(f.reset).not.toHaveBeenCalled();
  });
  it("does not mistake missing content readback or missing skill bundle for readiness", async () => {
    const f = fixture(); const anchor = f.put(logicalAnchorKey("generalist-reviewer")); delete anchor.defaultDrift;
    const check = await inspectVariant(f.ctx, companyId, anchor.agentId!, "sol-medium");
    expect(check.ready).toBe(false);
    expect(check.gaps).toEqual(expect.arrayContaining(["instructions_readback_unavailable", "review_skill_missing_or_mismatched"]));
    expect(f.skillReconcile).not.toHaveBeenCalled();
  });
  it("preserves native approval gating", async () => {
    const f = fixture(); f.reconcile.mockImplementation(async key => f.put(key, "pending_approval"));
    const check = await setupVariant(f.ctx, companyId, "lead", "sol-medium");
    expect(check.ready).toBe(false); expect(check.gaps).toContain("agent_not_idle:pending_approval");
    expect(check.observed.availability).toBe("pending_approval");
  });
  it("distinguishes setup absence from drift and read failures without proving model availability", async () => {
    const f = fixture(); const anchor = f.put(logicalAnchorKey("lead"));
    const missing = await inspectVariant(f.ctx, companyId, anchor.agentId!, "sol-high");
    expect(missing).toMatchObject({ ready: false, observed: { availability: "missing" }, gaps: ["variant_missing"] });
    const target = f.put(variantKey("lead", "sol-high"), "paused");
    expect((await inspectVariant(f.ctx, companyId, anchor.agentId!, "sol-high")).observed.availability).toBe("paused");
    target.agent!.adapterConfig.model = "other-model";
    expect((await inspectVariant(f.ctx, companyId, anchor.agentId!, "sol-high")).observed.availability).toBe("blocked");
    f.get.mockImplementation(async key => { if (key === variantKey("lead", "sol-high")) throw new Error("read failed"); return f.agents.get(key)!; });
    const failed = await inspectVariant(f.ctx, companyId, anchor.agentId!, "sol-high");
    expect(failed.observed.availability).toBe("unknown"); expect(failed.gaps).not.toContain("variant_missing");
    expect(f.reconcile).not.toHaveBeenCalled();
  });
  it("stops the batch after uncertain creation, with no automatic repeat or later resources", async () => {
    const f = fixture(); f.reconcile.mockImplementation(async key => { f.put(key); throw new Error("response lost after creation"); });
    await expect(setupVariants(f.ctx, companyId)).rejects.toThrow("response lost");
    expect(f.reconcile).toHaveBeenCalledTimes(1); expect(f.agents.size).toBe(1); expect(f.reset).not.toHaveBeenCalled();
  });
  it("reports unreadable anchors as unknown, and rejects ambiguous identities", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new Error("read unavailable"));
    expect(await inspectVariant(f.ctx, companyId, randomUUID(), "sol-medium")).toMatchObject({ ready: false, gaps: ["logical_anchor_read_unavailable"] });
    const one = f.put(logicalAnchorKey("contributor-1")); const two = f.put(logicalAnchorKey("contributor-2"));
    two.agent!.id = one.agentId!; two.agentId = one.agentId;
    await expect(inspectVariant(f.ctx, companyId, one.agentId!, "sol-medium")).rejects.toMatchObject({ code: "logical_identity_ambiguous" });
  });
});
