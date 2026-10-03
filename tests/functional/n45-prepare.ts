import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { canonicalPayloadHash } from "../../src/missions.js";
import { n1DeliveryAdapterConfig } from "./n1-live.js";
import { deliveryCriteria, deliveryWork, n45Instructions } from "./n45-instructions.js";

export const runnerConfig = (profile: any) => ({ provider: "codex", model: profile.model, modelReasoningEffort: profile.effort, permissionMode: "never" });
export async function prepareN45(input: any, profile: any) {
  const api = async (method: string, path: string, body?: any) => {
    const r = await input.request("human", method, path, body); assert(r.status >= 200 && r.status < 300, JSON.stringify({ path, status: r.status, body: r.body })); return r.body;
  };
  const settings = await api("GET", "/api/instance/settings/experimental");
  await api("PATCH", "/api/instance/settings/experimental", { ...settings, enableNativeRunner: true, enableExternalObjects: true });
  const repository = resolve(input.runtime, "delivery-repository");
  execFileSync("git", ["clone", "--no-hardlinks", "--no-checkout", input.packageRoot, repository], { stdio: "pipe" });
  execFileSync("git", ["switch", "-c", profile.headRef, profile.candidateSha], { cwd: repository, stdio: "pipe" });
  execFileSync("git", ["remote", "set-url", "origin", `https://github.com/${profile.repository}.git`], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Council Delivery Campaign"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "council-delivery@localhost"], { cwd: repository });
  const company = await api("POST", "/api/companies", { name: "Council Delivery campaign", defaultResponsibleUserId: input.ownerUserId, budgetMonthlyCents: 0 });
  const companyId = company.id; const agents: any = {};
  for (const role of ["lead", "backend", "frontend", "development", "quality", "reviewer"]) {
    const cli = ["lead", "backend", "frontend"].includes(role);
    const created = await api("POST", `/api/companies/${companyId}/agents`, { name: `Delivery ${role}`, role: role === "reviewer" ? "qa" : "engineer",
      adapterType: cli ? "codex_local" : "paperclip_runner", adapterConfig: cli ? n1DeliveryAdapterConfig({ model: profile.model, effort: profile.effort, repository }) : runnerConfig(profile),
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": n45Instructions(role, profile) } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } }, budgetMonthlyCents: 0 });
    agents[role] = await api("GET", `/api/agents/${created.id}`);
    assert.equal(agents[role].runtimeConfig.heartbeat.wakeOnDemand, false);
  }
  const toolProfile = await api("POST", `/api/companies/${companyId}/tools/profiles`, {
    profileKey: "council-delivery-mission", name: "Council Delivery exact agent command", defaultAction: "deny",
    entries: [{ selectorType: "tool_name", effect: "include", toolName: "private.paperclip-council:mission-command" }] });
  for (const agent of Object.values(agents) as any[]) {
    await api("POST", `/api/companies/${companyId}/tools/profiles/${toolProfile.id}/bind`, { targetType: "agent", targetId: agent.id });
  }
  const key = await api("POST", `/api/agents/${agents.reviewer.id}/keys`, { name: "Council native delivery authority", scope: { kind: "standard" } });
  const secret = await api("POST", `/api/companies/${companyId}/secrets`, { name: "Council API authority", key: "COUNCIL_API_KEY", provider: "local_encrypted", value: key.token });
  const now = Date.now(); const operatingProfile = { kind: "paperclip-orchestration-tokens-v1", periodKey: `n45-${randomUUID()}`,
    periodStart: new Date(now - 60_000).toISOString(), periodEnd: new Date(now + 150 * 60_000).toISOString(),
    periodAllowanceUnits: profile.periodUnits, runReservationUnits: profile.runUnits, initialKnownUsageUnits: 0, initialExposureUnits: 0,
    initialTokenAccountingSource: `fresh-native-company:${companyId}`, maxCorrections: 1 };
  await api("POST", `/api/plugins/${input.pluginId}/config`, { companyId, configJson: { apiBaseUrl: input.baseUrl, councilAgentId: agents.reviewer.id,
    councilApiKey: { type: "secret_ref", secretId: secret.id }, n1OperatingProfile: operatingProfile, n2RuntimeProfile: "paperclip_runner-experimental" } });
  const project = await api("POST", `/api/companies/${companyId}/projects`, { name: "Council Delivery UI", status: "in_progress",
    workspace: { name: "Isolated delivery clone", sourceType: "local_path", cwd: repository, isPrimary: true },
    executionWorkspacePolicy: { enabled: true, sharedWorkspaceConcurrency: "allow", defaultMode: "shared_workspace", allowIssueOverride: false, workspaceStrategy: { type: "project_primary" } } });
  const rosterPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/rosters`;
  const roster = async (kind: string, members: any[], lead: string | null, reviewer: string | null) => api("POST", rosterPath, { companyId, command: "create", roster: {
    kind, name: `Delivery ${kind}`, projectId: project.id, members, integrationLeadAgentId: lead, finalReviewerAgentId: reviewer, requiredPerspectives: kind === "council" ? ["development", "quality"] : [] } });
  const team = await roster("team", ["lead", "backend", "frontend"].map(role => ({ agentId: agents[role].id, responsibilities: [role === "lead" ? "integration_lead" : role] })), agents.lead.id, null);
  const council = await roster("council", ["development", "quality", "reviewer"].map(role => ({ agentId: agents[role].id, responsibilities: [role === "reviewer" ? "final_reviewer" : role] })), null, agents.reviewer.id);
  const pair = await api("POST", rosterPath, { companyId, command: "activate-pair", teamRosterId: team.head.rosterId, teamExpectedVersion: team.head.version, councilRosterId: council.head.rosterId, councilExpectedVersion: council.head.version });
  const admissionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/admission`;
  const source = `plugin-config:n1OperatingProfile:initial-token-accounting:${operatingProfile.initialTokenAccountingSource}`;
  await api("POST", admissionPath, { companyId, command: "configure", configuration: { companyId, commandId: randomUUID(), periodKey: operatingProfile.periodKey,
    periodStart: operatingProfile.periodStart, periodEnd: operatingProfile.periodEnd, measurement: { status: "known", source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger", unit: "tokens" },
    allowance: { status: "known", source, periodUnits: profile.periodUnits, taskUnits: profile.runUnits, knownUsageUnits: 0 }, exposure: { status: "known", source, units: 0 },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 } } });
  const root = await api("POST", `/api/companies/${companyId}/issues`, { title: "Implement the Council Missions Delivery panel", projectId: project.id, status: "backlog", assigneeAgentId: agents.lead.id });
  const missionId = randomUUID(); const missionBase = `/api/plugins/${input.pluginId}/api/companies/${companyId}/missions`;
  const created = await api("POST", missionBase, { companyId, command: "create", commandId: randomUUID(), missionId, rootIssueId: root.id, projectId: project.id,
    teamRosterId: pair.team.head.rosterId, teamRevision: pair.team.revision.revision, councilRosterId: pair.council.head.rosterId, councilRevision: pair.council.revision.revision,
    mandate: { objective: "Make Council delivery status and next useful action visible in the Missions page", acceptanceCriteria: deliveryCriteria,
      commitments: ["Separate complementary ownership; serialize backend then frontend", "Independent N2/N3 acceptance before same-PR publication", "No artificial correction; no host/core/dependency changes"],
      limits: { taskPolicy: `${profile.runUnits} reserved units per run; not a provider hard cap`, periodPolicy: `${profile.periodUnits} token allowance, nominal9/max15 runs`, correctionLimit: 1, elapsedMinutes: 150 } } });
  const work = deliveryWork.map(w => ({ ...w, contributionId: randomUUID(), assigneeAgentId: agents[w.key].id, sourceRefs: ["src/ui/index.tsx", "src/n5-state.ts"], dependencies: w.key === "frontend" ? ["backend presentation contract"] : [],
    evidenceRefs: [], skills: ["native-git", "paperclip"], interface: "Lead confirms the pure delivery presentation contract before backend dispatch; frontend consumes it" }));
  const plan = { missionId, mandateHash: canonicalPayloadHash(created.mission.aggregate.mandate), plannerAgentId: agents.lead.id, orchestratorAgentId: agents.lead.id,
    integrationLeadAgentId: agents.lead.id, qaAgentId: agents.reviewer.id, work };
  const document = await api("PUT", `/api/issues/${root.id}/documents/plan`, { format: "markdown", title: "Delivery operational plan; lead refines inside mandate", body: JSON.stringify(plan) });
  await api("PATCH", `/api/issues/${root.id}`, { description: JSON.stringify({ missionId, companyId, pluginId: input.pluginId, baseCommit: profile.candidateSha, work, runUnits: profile.runUnits,
    n1Commands: "inspect; plan contributions; materialize each; dispatch/reconcile-usage sequentially; publish exact bundle; finish root done. Each mutation uses fresh commandId and inspected expectedVersion.",
    nativeCommands: "Use the advertised Council plugin tool through native call_api; never inject an API token into the terminal.", acceptanceCriteria: deliveryCriteria }) });
  const missionPath = `${missionBase}/${missionId}`;
  const n3Slots = ["development", "quality"].map(role => ({ slotId: randomUUID(), perspective: role, specialistAgentId: agents[role].id, required: true, question: role === "development" ? "Is the integrated implementation correct and scoped?" : "Do observations substantiate each user-visible acceptance criterion?" }));
  return { api, toolProfile, companyId, projectId: project.id, rootIssueId: root.id, missionId, missionPath, admissionPath, agents, repository, planRevisionId: document.latestRevisionId, operatingProfile, n3Slots, work };
}
