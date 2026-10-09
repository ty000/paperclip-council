import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { handleProjectMandate } from "../src/project-mandate-configuration.js";
import { FIXED_CAMPAIGN_MODE, LINEAR_CONTINUITY_PROTOCOL } from "../src/linear-continuity-contract.js";

const native = vi.hoisted(() => ({ profile: vi.fn(), admission: vi.fn(), pair: vi.fn() }));
vi.mock("../src/g4-native.js", () => ({ readNativeG4Profile: native.profile }));
vi.mock("../src/admission.js", () => ({ readAdmission: native.admission }));
vi.mock("../src/rosters.js", () => ({ validateRosterPair: native.pair }));

function fixture(fixed = true) {
  const companyId = randomUUID(), projectId = randomUUID(), owner = randomUUID();
  const actors = Object.fromEntries(["lead", "alpha", "beta", "product", "quality", "reviewer", "publisher"]
    .map(name => [name, randomUUID()])) as Record<string, string>;
  const source = Object.fromEntries(["organization", "team", "project", "todo", "alpha", "beta"]
    .map(name => [name, randomUUID()])) as Record<string, string>;
  const config = { n2RuntimeProfile: "ordinary-cli-v1", nativeWakeGuardEnabled: true,
    n1OperatingProfile: { kind: "paperclip-orchestration-tokens-v1", periodKey: "pilot", maxCorrections: 1 } };
  native.profile.mockResolvedValue({ periodKey: "pilot", maxCorrections: 1 });
  native.admission.mockResolvedValue({ version: 1 });
  native.pair.mockResolvedValue({ eligible: true,
    team: { head: { rosterId: randomUUID(), lifecycle: "active", publishedRevision: "team-r1" }, revision: { content: {
      integrationLeadAgentId: actors.lead, members: ["lead", "alpha", "beta"].map(name => ({ agentId: actors[name] })) } } },
    council: { head: { rosterId: randomUUID(), lifecycle: "active", publishedRevision: "council-r1" }, revision: { content: {
      finalReviewerAgentId: actors.reviewer } } } });
  let row: any;
  const execute = vi.fn(async (_sql: string, params: unknown[]) => {
    row = { company_id: companyId, project_id: projectId, version: 1, revision_id: params[3], authorized_by: owner, content: JSON.parse(String(params[7])) };
    return { rowCount: 1 };
  });
  const ctx = { db: { namespace: "council", execute, query: vi.fn(async (sql: string) => sql.includes("command_id") ? [] : row ? [row] : []) },
    config: { get: async () => config }, companies: { get: async () => ({ defaultResponsibleUserId: owner }) },
    projects: { get: async () => ({ companyId }) }, issues: { list: async () => [] },
    agents: { get: async (id: string) => ({ id, companyId, adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) } } as unknown as PluginContext;
  const body: Record<string, unknown> = { companyId, command: "configure", commandId: randomUUID(), expectedVersion: 0,
    enabled: true, authorizeNewTasks: true, teamRosterId: randomUUID(), councilRosterId: randomUUID(), includedRootIssueIds: [],
    n3Slots: ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective,
      specialistAgentId: actors[perspective], required: true, question: `${perspective} review` })),
    template: { objective: "Project template", acceptanceCriteria: ["Both leaves integrated"], commitments: ["Preserve source"],
      limits: { taskPolicy: "bounded", periodPolicy: "existing period", correctionLimit: 1, elapsedMinutes: 30 } },
    criteriaSource: "project-defaults", allowedPaths: ["alpha.txt", "beta.txt"],
    hierarchy: { protocol: "council-hierarchy-v1", execution: "sequential", maxContributions: 2, adoptExistingChildren: true },
    linearIntake: { protocol: "linear-intake-receiver-v1", originKind: "plugin:ty000.linear-intake",
      organizationId: source.organization, teamId: source.team, projectId: source.project, todoStateId: source.todo,
      work: { [source.alpha]: { assigneeAgentId: actors.alpha, ownedPaths: ["alpha.txt"] },
        [source.beta]: { assigneeAgentId: actors.beta, ownedPaths: ["beta.txt"] } } },
    ...(fixed ? { linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE } } : {}),
    publication: { publisherAgentId: actors.publisher, qaAgentId: actors.quality, repository: "ty000/paperclip-council",
      baseRef: "main", headRefPrefix: "codex/campaign", contract: { protocol: "council-pr-contract-v1", draftOnly: false,
        result: "integrated-verified", feedback: "review-and-correct", requiredChecks: ["ci"], integration: {
          protocol: "council-integrated-delivery-v1", mergeMethod: "squash", requiredChecks: ["ci"], parentObligations: [] } } },
    completion: { protocol: "council-proof-close-v1", result: "integrated-verified" } };
  const input = { method: "POST", companyId, params: { projectId }, actor: { actorType: "user", userId: owner }, body } as unknown as PluginApiRequestInput;
  return { ctx, input, execute };
}

it("accepts a validated two-leaf fixed campaign integration policy", async () => {
  const f = fixture();
  const result = await handleProjectMandate(f.ctx, f.input);
  expect(result.body.policy?.content).toMatchObject({ hierarchy: { maxContributions: 2, adoptExistingChildren: true },
    linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE },
    completion: { result: "integrated-verified" } });
  expect(f.execute).toHaveBeenCalledOnce();
});

it("keeps legacy integrated delivery policies bounded to one leaf", async () => {
  const f = fixture(false);
  await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ status: 422, code: "integration_leaf_policy" });
  expect(f.execute).not.toHaveBeenCalled();
});

it("retains accepted one-leaf legacy integrated delivery policies", async () => {
  const f = fixture(false);
  (f.input.body as any).hierarchy.maxContributions = 1;
  const result = await handleProjectMandate(f.ctx, f.input);
  expect(result.body.policy?.content.hierarchy?.maxContributions).toBe(1);
  expect(result.body.policy?.content.linearContinuity).toBeUndefined();
  expect(f.execute).toHaveBeenCalledOnce();
});
