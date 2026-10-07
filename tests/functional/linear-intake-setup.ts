import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LinearHost } from "./linear-intake-host.js";
import type { LinearSource } from "./linear-intake-source.js";

async function nativeSecret(host: LinearHost, companyId: string, name: string, value: string) {
  const secret = await host.api("POST", `/api/companies/${companyId}/secrets`, {
    name, key: name.toUpperCase().replaceAll("-", "_"), provider: "local_encrypted", value,
  });
  return { type: "secret_ref", secretId: secret.id };
}

export async function installLinearIntake(host: LinearHost, source: LinearSource, companyId: string, projectId: string, intakeRepository: string) {
  const gatewayTokenRef = await nativeSecret(host, companyId, "linear-fixture-gateway", source.token);
  const webhookSecretRef = await nativeSecret(host, companyId, "linear-fixture-webhook", source.webhookSecret);
  const installed = await host.api("POST", "/api/plugins/install", { packageName: intakeRepository, isLocalPath: true });
  const pluginId = installed.id;
  const config = { enabled: true, nativeImportEnabled: true, councilHandoffEnabled: true,
    gatewayDiscoveryEnabled: true, gatewayTransport: "local_loopback", gatewayToolCallMode: "mcp",
    gatewayUrl: source.gatewayUrl, gatewayTokenRef, sourceReader: source.reader, localGatewayTimeoutMs: 10_000,
    intake: { targetProjectId: projectId, webhookId: source.ids.webhook, webhookSecretRef,
      allowedActors: [{ id: source.ids.actor, type: "user" }] } };
  await host.api("POST", `/api/plugins/${pluginId}/config`, { companyId, configJson: config });
  const action = async (key: string, params = {}) => (await host.api("POST", `/api/plugins/${pluginId}/actions/${key}`, { companyId, params })).data;
  const activation = await action("activate-intake");
  assert.equal(activation.status, "intake_enrolled");
  assert.equal(activation.active, true);
  source.enterTodo();
  async function deliver(input: ReturnType<LinearSource["webhook"]>) {
    const response = await fetch(`${host.base}/api/plugins/${pluginId}/webhooks/linear-todo`, {
      method: "POST", headers: input.headers, body: input.rawBody, signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `Native webhook HTTP ${response.status}`);
    return response.json();
  }
  return { pluginId, action, deliver, activation, config };
}

async function fixtureWorkspace(host: LinearHost, repository: string) {
  const repoPath = resolve(host.runtime, "workspace");
  await mkdir(repoPath);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
  git("init", "-b", "work"); git("config", "user.name", "Isolated Council fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(resolve(repoPath, "README.md"), "Deterministic Linear admission qualification\n");
  git("add", "README.md"); git("commit", "-m", "fixture baseline");
  const baseCommit = git("rev-parse", "HEAD"); git("branch", "base", baseCommit);
  const command = resolve(host.runtime, "model-fixture.mjs");
  await writeFile(command, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(resolve(repository, "tests/functional/ordinary-cli-fixture.mjs")).href)});\n`);
  await chmod(command, 0o700);
  return { repoPath, baseCommit, command, fixtureConfig: resolve(host.runtime, "model-config.json") };
}

async function createActors(host: LinearHost, companyId: string, workspace: Awaited<ReturnType<typeof fixtureWorkspace>>) {
  const actors: Record<string, string> = {};
  for (const name of ["lead", "alpha", "beta", "product", "quality", "council"]) {
    const agent = await host.api("POST", `/api/companies/${companyId}/agents`, {
      name: `Linear qualification ${name}`, role: "engineer", adapterType: "codex_local",
      adapterConfig: { engine: "cli", command: workspace.command, model: "fixture-no-provider", cwd: workspace.repoPath,
        env: { CODEX_HOME: resolve(host.runtime, `codex-${name}`), COUNCIL_ORDINARY_FIXTURE: workspace.fixtureConfig }, timeoutSec: 120 },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
    });
    actors[name] = agent.id;
  }
  return actors;
}

async function activeRosters(host: LinearHost, companyId: string, projectId: string, pluginId: string, actors: Record<string, string>) {
  const route = `/api/plugins/${pluginId}/api/companies/${companyId}/rosters`;
  const team = await host.api("POST", route, { companyId, command: "create", roster: { kind: "team", name: "Linear contributors", projectId,
    members: ["lead", "alpha", "beta"].map(name => ({ agentId: actors[name], responsibilities: [name === "lead" ? "integration_lead" : "contributor"] })),
    integrationLeadAgentId: actors.lead, finalReviewerAgentId: null, requiredPerspectives: [] } });
  const council = await host.api("POST", route, { companyId, command: "create", roster: { kind: "council", name: "Linear review", projectId,
    members: [{ agentId: actors.council, responsibilities: ["final_reviewer"] }], integrationLeadAgentId: null,
    finalReviewerAgentId: actors.council, requiredPerspectives: ["integration_quality"] } });
  await host.api("POST", route, { companyId, command: "activate-pair", teamRosterId: team.head.rosterId,
    teamExpectedVersion: team.head.version, councilRosterId: council.head.rosterId, councilExpectedVersion: council.head.version });
  return { teamRosterId: team.head.rosterId, councilRosterId: council.head.rosterId };
}

export async function installLinearCouncil(host: LinearHost, companyId: string, repository: string) {
  const workspace = await fixtureWorkspace(host, repository), actors = await createActors(host, companyId, workspace);
  const key = await host.api("POST", `/api/agents/${actors.council}/keys`, { name: "isolated-council", scope: { kind: "standard" } });
  const secret = await nativeSecret(host, companyId, "council-readback", key.token);
  const installed = await host.api("POST", "/api/plugins/install", { packageName: repository, isLocalPath: true });
  const pluginId = installed.id;
  const profile = { kind: "paperclip-orchestration-tokens-v1", periodKey: "linear-intake-isolated",
    periodStart: new Date(Date.now() - 60_000).toISOString(), periodEnd: new Date(Date.now() + 3_600_000).toISOString(),
    periodAllowanceUnits: 20_000, runReservationUnits: 1_000, initialKnownUsageUnits: 0, initialExposureUnits: 0,
    initialTokenAccountingSource: "new-isolated-company", maxCorrections: 1 };
  await host.api("POST", `/api/plugins/${pluginId}/config`, { companyId, configJson: {
    apiBaseUrl: host.base, councilAgentId: actors.council, councilApiKey: secret,
    n1OperatingProfile: profile, n2RuntimeProfile: "ordinary-cli-v1", nativeRunLimit: 3,
  } });
  const project = await host.api("POST", `/api/companies/${companyId}/projects`, { name: "Linear source qualification", status: "in_progress",
    workspace: { name: "fixture", sourceType: "local_path", cwd: workspace.repoPath, isPrimary: true },
    executionWorkspacePolicy: { enabled: true, sharedWorkspaceConcurrency: "allow", defaultMode: "shared_workspace",
      allowIssueOverride: false, workspaceStrategy: { type: "project_primary" } } });
  const projectId = project.id;
  const rosters = await activeRosters(host, companyId, projectId, pluginId, actors);
  const { nativeAdmissionConfiguration } = await import("../../src/g4-native.js");
  const admissionPath = `/api/plugins/${pluginId}/api/companies/${companyId}/admission`;
  await host.api("POST", admissionPath, { companyId, command: "configure", configuration: nativeAdmissionConfiguration(profile as any, companyId, randomUUID()) });
  await writeFile(workspace.fixtureConfig, JSON.stringify({ pluginId, companyId, projectId, projectIntake: true, hierarchyCount: 2,
    councilRepository: repository, repoPath: workspace.repoPath, runtime: host.runtime, actors, baseCommit: workspace.baseCommit }));
  return { pluginId, projectId, actors, profile, rosters, admissionPath, workspace,
    missions: `/api/plugins/${pluginId}/api/companies/${companyId}/missions`,
    policyPath: `/api/plugins/${pluginId}/api/companies/${companyId}/projects/${projectId}/mandate`,
  };
}

export function linearPolicy(council: Awaited<ReturnType<typeof installLinearCouncil>>, source: LinearSource, companyId: string, rootId: string) {
  return { companyId, commandId: randomUUID(), expectedVersion: 0, enabled: true, authorizeNewTasks: true,
    ...council.rosters, includedRootIssueIds: [rootId],
    n3Slots: ["product", "quality"].map(perspective => ({ slotId: randomUUID(), perspective,
      specialistAgentId: council.actors[perspective], required: true, question: `${perspective}: exact imported family` })),
    template: { objective: "Bounded imported family", acceptanceCriteria: ["Retained native identities", "Dependency order alpha then beta"],
      commitments: ["Historical cancelled work remains unchanged"], limits: { taskPolicy: "1000 token reservation", periodPolicy: "Existing 20000 token period", correctionLimit: 1, elapsedMinutes: 30 } },
    criteriaSource: "project-defaults", allowedPaths: ["alpha.txt", "beta.txt"], publication: null,
    hierarchy: { protocol: "council-hierarchy-v1", execution: "sequential", maxContributions: 2, adoptExistingChildren: true },
    linearIntake: { protocol: "linear-intake-receiver-v1", originKind: "plugin:ty000.linear-intake",
      organizationId: source.ids.organization, teamId: source.ids.team, projectId: source.ids.project, todoStateId: source.ids.todo,
      work: { [source.ids.alpha!]: { assigneeAgentId: council.actors.alpha, ownedPaths: ["alpha.txt"] },
        [source.ids.beta!]: { assigneeAgentId: council.actors.beta, ownedPaths: ["beta.txt"] } } },
  };
}
