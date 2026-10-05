import { beforeEach, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: vi.fn() }));
vi.mock("../src/model-variants.js", () => ({ inspectVariant: vi.fn(), setupVariant: vi.fn(), inspectPreparedVariants: vi.fn(async () => []) }));
import { getMission } from "../src/missions.js";
import { chooseModelProfile, handleModelProfiles } from "../src/model-api.js";
import { setupVariant } from "../src/model-variants.js";
import { MODEL_CATALOGUE } from "../src/model-catalogue.js";

let mission: MissionRecord;
const ctx = {
  companies: { get: vi.fn(async () => ({ defaultResponsibleUserId: "owner" })) },
  config: { get: vi.fn(async () => ({ modelVariantsEnabled: true })) },
  issues: { assertCheckoutOwner: vi.fn(), requestWakeup: vi.fn() },
  db: { namespace: "council", query: vi.fn(async () => []), execute: vi.fn(async (_sql: string, args: unknown[]) => {
    if (args[3] !== mission.version) return { rowCount: 0 };
    mission = { ...mission, version: mission.version + 1, aggregate: JSON.parse(String(args[0])) }; return { rowCount: 1 };
  }) },
};
function request(actor: "owner" | "lead" | "stranger" = "owner"): PluginApiRequestInput {
  return { companyId: "company", params: { companyId: "company", missionId: "mission", issueId: "root" }, body: {
    expectedVersion: mission.version, taskKey: "root", interventionKey: "reviewer", family: "review", profileId: "sol-high", rationale: "Substantial contract review",
  }, actor: actor === "lead" ? { actorType: "agent", actorId: "physical", agentId: "physical", runId: "run" }
    : { actorType: "user", actorId: actor, userId: actor }, routeKey: "mission-command", method: "POST", path: "/", query: {}, headers: {} };
}
beforeEach(() => {
  vi.clearAllMocks();
  mission = { companyId: "company", missionId: "mission", ownerUserId: "owner", rootIssueId: "root", version: 1,
    aggregate: { responsibilities: { integrationLeadAgentId: "logical" }, n1: { rootDispatchRunId: "run" }, modelSelection: {
      protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: "root", mapping: MODEL_CATALOGUE, variantRevision: "1", launches: [{
        taskKey: "root", interventionKey: "lead", launchKey: "launch", logicalAgentId: "logical", agentId: "physical", runId: "run", issueId: "root", state: "bound",
      }] }],
    } } } as unknown as MissionRecord;
  vi.mocked(getMission).mockImplementation(async () => mission);
});
it("records the lead's physical identity and grants no wake or setup authority", async () => {
  const result = await chooseModelProfile(ctx as unknown as PluginContext, request("lead"));
  expect(result.body.choice).toMatchObject({ authority: "lead", actorId: "physical", profileId: "sol-high" });
  expect(ctx.issues.assertCheckoutOwner).toHaveBeenCalledWith({ companyId: "company", issueId: "root", actorAgentId: "physical", actorRunId: "run" });
  expect(result.body.effectPermission).toBe("none");
  expect(setupVariant).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
it("preserves explicit owner choice against the lead and rejects stale versions", async () => {
  const stale = request();
  await chooseModelProfile(ctx as unknown as PluginContext, request());
  await expect(chooseModelProfile(ctx as unknown as PluginContext, request("lead"))).rejects.toMatchObject({ code: "model_user_choice_pinned" });
  await expect(chooseModelProfile(ctx as unknown as PluginContext, stale)).rejects.toMatchObject({ code: "model_version_conflict" });
  expect(ctx.db.execute).toHaveBeenCalledTimes(1);
});
it("rejects foreign owners and unbound native runs before writes", async () => {
  await expect(chooseModelProfile(ctx as unknown as PluginContext, request("stranger"))).rejects.toMatchObject({ code: "owner_required" });
  const unbound = request("lead"); unbound.actor.runId = "other";
  await expect(chooseModelProfile(ctx as unknown as PluginContext, unbound)).rejects.toMatchObject({ code: "model_binding_missing" });
  expect(ctx.db.execute).not.toHaveBeenCalled();
});
it("blocks agent setup and keeps catalogue inspection read-only", async () => {
  const agent = request("lead"); agent.routeKey = "model-profiles-command"; agent.body = { command: "prepare-variant" };
  await expect(handleModelProfiles(ctx as unknown as PluginContext, agent)).rejects.toMatchObject({ code: "owner_required" });
  const read = request(); read.routeKey = "model-profiles-read";
  expect(await handleModelProfiles(ctx as unknown as PluginContext, read)).toMatchObject({ status: 200, body: { mapping: { families: expect.any(Array) }, availability: "not_validated_live" } });
  expect(setupVariant).not.toHaveBeenCalled(); expect(ctx.db.execute).not.toHaveBeenCalled();
});
