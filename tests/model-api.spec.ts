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
function hierarchicalLeadRequest(): PluginApiRequestInput {
  mission.aggregate.n1!.coordination = { issueId: "coordinator" };
  mission.aggregate.modelSelection!.tasks[0]!.launches[0]!.issueId = "coordinator";
  const input = request("lead");
  input.routeKey = "mission-agent-command";
  input.params.issueId = "coordinator";
  input.body = { ...input.body as Record<string, unknown>, command: "select-model-profile",
    taskKey: "contribution", interventionKey: "contribution", family: "implementation", profileId: "sol-medium",
    rationale: "Bounded contribution under the existing hierarchy mandate" };
  return input;
}
beforeEach(() => {
  vi.clearAllMocks();
  ctx.issues.assertCheckoutOwner.mockReset();
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
it("lets the bound hierarchy coordinator select a contribution profile without a wake", async () => {
  const input = hierarchicalLeadRequest();
  const result = await chooseModelProfile(ctx as unknown as PluginContext, input);
  expect(result.body.choice).toMatchObject({ authority: "lead", actorId: "physical", taskKey: "contribution", profileId: "sol-medium" });
  expect(ctx.issues.assertCheckoutOwner).toHaveBeenCalledWith({ companyId: "company", issueId: "coordinator", actorAgentId: "physical", actorRunId: "run" });
  expect(ctx.db.execute).toHaveBeenCalledOnce();
  expect(result.body.effectPermission).toBe("none");
  expect(setupVariant).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
it.each([
  ["actor", "integration_lead_required"],
  ["root issue", "integration_lead_required"],
  ["foreign issue", "integration_lead_required"],
  ["run", "model_binding_missing"],
] as const)("rejects a hierarchy profile choice with a mismatched %s before writes", async (kind, code) => {
  const input = hierarchicalLeadRequest();
  if (kind === "actor") input.actor.agentId = "foreign";
  if (kind === "root issue") input.params.issueId = "root";
  if (kind === "foreign issue") input.params.issueId = "foreign";
  if (kind === "run") input.actor.runId = "foreign";
  await expect(chooseModelProfile(ctx as unknown as PluginContext, input)).rejects.toMatchObject({ code });
  expect(ctx.issues.assertCheckoutOwner).not.toHaveBeenCalled();
  expect(ctx.db.execute).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
it("requires the hierarchy coordinator's native checkout before recording its choice", async () => {
  const input = hierarchicalLeadRequest();
  ctx.issues.assertCheckoutOwner.mockRejectedValueOnce(new Error("checkout does not belong to this run"));
  await expect(chooseModelProfile(ctx as unknown as PluginContext, input)).rejects.toThrow("checkout does not belong");
  expect(ctx.issues.assertCheckoutOwner).toHaveBeenCalledWith({ companyId: "company", issueId: "coordinator", actorAgentId: "physical", actorRunId: "run" });
  expect(ctx.db.execute).not.toHaveBeenCalled(); expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});
it("preserves a historical correction run bound to the root when N1 has a coordinator", async () => {
  hierarchicalLeadRequest();
  mission.aggregate.n2 = { correction: { runId: "correction-run" } } as typeof mission.aggregate.n2;
  const launches = mission.aggregate.modelSelection!.tasks[0]!.launches;
  launches.push({ ...launches[0]!, launchKey: "correction-launch", issueId: "root", runId: "correction-run" });
  const input = request("lead"); input.actor.runId = "correction-run";
  const result = await chooseModelProfile(ctx as unknown as PluginContext, input);
  expect(result.body.choice.authority).toBe("lead");
  expect(ctx.issues.assertCheckoutOwner).toHaveBeenCalledWith({ companyId: "company", issueId: "root", actorAgentId: "physical", actorRunId: "correction-run" });
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
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
it.each([
  ["absent configuration", {}, false],
  ["missing runtime profile", { modelVariantsEnabled: true }, false],
  ["experimental runtime", { modelVariantsEnabled: true, n2RuntimeProfile: "paperclip_runner-experimental" }, false],
  ["ordinary runtime", { modelVariantsEnabled: true, n2RuntimeProfile: "ordinary-cli-v1" }, true],
  ["disabled flag", { modelVariantsEnabled: false, n2RuntimeProfile: "ordinary-cli-v1" }, false],
] as const)("reports effective new-mission eligibility for %s", async (_name, config, expected) => {
  vi.mocked(ctx.config.get).mockResolvedValueOnce(config as never);
  const read = request(); read.routeKey = "model-profiles-read";
  const result = await handleModelProfiles(ctx as unknown as PluginContext, read);
  expect(result.body).toMatchObject({ enabledForNewMissions: expected });
});
