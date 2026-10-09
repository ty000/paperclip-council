import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { ProjectMandate } from "../src/project-mandate-state.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { inspectProjectReadiness } from "../src/project-readiness.js";
import { handleProjectMandate } from "../src/project-mandate-configuration.js";

const native = vi.hoisted(() => ({ profile: vi.fn(), admission: vi.fn(), pair: vi.fn() }));
vi.mock("../src/g4-native.js", () => ({ readNativeG4Profile: native.profile }));
vi.mock("../src/admission.js", () => ({ readAdmission: native.admission }));
vi.mock("../src/rosters.js", () => ({ validateRosterPair: native.pair }));

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID();
  const config = { n2RuntimeProfile: "ordinary-cli-v1", nativeWakeGuardEnabled: true };
  const policy = { companyId, projectId, version: 1, revisionId: randomUUID(), authorizedBy: "owner",
    content: { enabled: true, ownerUserId: "owner", operatingProfileHash: operatingProfileHash(config),
      teamRosterId: "team", teamRevision: "r1", councilRosterId: "council", councilRevision: "r2",
      n3Slots: [{ specialistAgentId: "specialist" }], publication: { publisherAgentId: "publisher", qaAgentId: "qa" },
      workflow: { protocol: "council-project-workflow-v1", commands: [{ key: "static-audit", kind: "audit",
        command: "pnpm exec fallow audit --base origin/main", roles: ["lead", "contributor"],
        tool: { name: "fallow", versionCommand: "pnpm exec fallow --version", expectedVersion: "3.23.0" } }] } } } as ProjectMandate;
  native.profile.mockResolvedValue({ periodKey: "current" });
  native.admission.mockResolvedValue({ blockers: [], availablePeriodUnits: 5000 });
  native.pair.mockResolvedValue({ eligible: true,
    team: { head: { lifecycle: "active", publishedRevision: "r1" }, revision: { content: { members: [{ agentId: "lead" }] } } },
    council: { head: { lifecycle: "active", publishedRevision: "r2" }, revision: { content: { finalReviewerAgentId: "reviewer" } } } });
  const execute = vi.fn(), getActor = vi.fn(async () => ({ companyId, adapterType: "codex_local", status: "idle",
    adapterConfig: { engine: "cli", env: { SECRET: "must-not-be-disclosed" } }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } }));
  const getWorkspace = vi.fn(async () => ({ projectId, isPrimary: true, path: "/tmp/owned-native-checkout" }));
  const ctx = { config: { get: async () => config }, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) },
    projects: { get: async () => ({ companyId }), getPrimaryWorkspace: getWorkspace }, agents: { get: getActor },
    db: { namespace: "council", execute, query: async () => [{ company_id: companyId, project_id: projectId, version: 1,
      revision_id: policy.revisionId, authorized_by: "owner", content: policy.content }] } } as unknown as PluginContext;
  return { ctx, config, policy, companyId, projectId, execute, getActor, getWorkspace };
}

describe("native project setup diagnosis", () => {
  it("checks pinned configuration without granting a launch or disclosing effective credentials", async () => {
    const f = fixture(); const view = await inspectProjectReadiness(f.ctx, f.companyId, f.projectId, f.policy);
    expect(view.configurationReady).toBe(true); expect(view.launchAuthorized).toBe(false);
    expect(view.policyRevisionId).toBe(f.policy.revisionId);
    expect(view.workflow?.commands[0]).toMatchObject({ key: "static-audit", tool: { expectedVersion: "3.23.0" } });
    expect(view.checks.filter(check => check.state === "run-check-required").map(check => check.key))
      .toEqual(["effective-agent-environment", "github-publication"]);
    expect(JSON.stringify(view)).not.toContain("must-not-be-disclosed"); expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps a mandate without pinned commands blocked for new work", async () => {
    const f = fixture(); delete f.policy.content.workflow;
    const view = await inspectProjectReadiness(f.ctx, f.companyId, f.projectId, f.policy);
    expect(view.configurationReady).toBe(false);
    expect(view.checks).toContainEqual(expect.objectContaining({ key: "workflow", state: "blocked" }));
    expect(view.checks).toContainEqual(expect.objectContaining({ key: "effective-agent-environment", state: "run-check-required" }));
  });
  it("fails configuration diagnosis on budget uncertainty, a relative checkout and actor drift", async () => {
    const f = fixture();
    native.admission.mockResolvedValue({ blockers: [{ code: "unsettled_usage_unknown" }], availablePeriodUnits: null });
    f.getWorkspace.mockResolvedValue({ projectId: f.projectId, isPrimary: true, path: "relative" });
    f.getActor.mockResolvedValue({ companyId: randomUUID(), adapterType: "codex_local", status: "idle",
      adapterConfig: { engine: "cli", env: { SECRET: "must-not-be-disclosed" } }, runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } });
    const view = await inspectProjectReadiness(f.ctx, f.companyId, f.projectId, f.policy);
    expect(view.configurationReady).toBe(false);
    expect(view.checks.filter(check => check.state === "blocked").map(check => check.key))
      .toEqual(expect.arrayContaining(["workspace", "accounting", "actor:publisher"]));
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("detects a changed operating profile and never creates a missing mandate or period", async () => {
    const f = fixture(); f.config.nativeWakeGuardEnabled = false; native.profile.mockResolvedValue(null);
    const drift = await inspectProjectReadiness(f.ctx, f.companyId, f.projectId, f.policy);
    expect(drift.checks.find(check => check.key === "authority")?.state).toBe("blocked");
    const missing = await inspectProjectReadiness(f.ctx, f.companyId, f.projectId, null);
    expect(missing.configurationReady).toBe(false); expect(missing.policyRevisionId).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("restricts the existing GET to its owner and adds diagnosis only when explicitly requested", async () => {
    const f = fixture(); const input = { method: "GET", companyId: f.companyId, params: { projectId: f.projectId },
      actor: { actorType: "user", userId: "owner" }, query: {} } as unknown as PluginApiRequestInput;
    expect((await handleProjectMandate(f.ctx, input)).body).not.toHaveProperty("readiness");
    expect(f.getWorkspace).not.toHaveBeenCalled(); input.query.readiness = "true";
    expect((await handleProjectMandate(f.ctx, input)).body).toHaveProperty("readiness.launchAuthorized", false);
    input.actor.userId = "another-owner";
    await expect(handleProjectMandate(f.ctx, input)).rejects.toMatchObject({ code: "project_owner_required" });
    expect(f.getWorkspace).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
});
