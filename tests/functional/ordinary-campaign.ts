import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareN45 } from "./n45-prepare.js";

export function ordinaryCampaignHandoff(c: any, input: any, profile: any) {
  const owner = (command: string, fields: any = {}) => ({ method: "POST", path: `${c.missionPath}/commands`, body: { companyId: c.companyId, command,
    ...["reconcile-delivery", "reconcile-ordinary-n2"].includes(command) ? {} : { commandId: "GENERATE_UUID_ONCE", expectedVersion: "READ_CURRENT_MISSION_VERSION" }, ...fields } });
  return { baseUrl: input.baseUrl, companyId: c.companyId, missionId: c.missionId, rootIssueId: c.rootIssueId,
    repository: c.repository, preparedPlanRevisionId: c.planRevisionId, profile,
    missionRead: `${c.missionPath}?companyId=${c.companyId}`, admissionRead: `${c.admissionPath}?companyId=${c.companyId}&periodKey=${c.operatingProfile.periodKey}`,
    configureDelivery: owner("configure-delivery", { planRevisionId: "READ_CURRENT_PLAN_REVISION", publisherAgentId: c.agents.publisher.id,
      repository: profile.repository, baseRef: profile.baseRef, headRef: profile.headRef }),
    activate: owner("activate", { periodKey: c.operatingProfile.periodKey, reservationId: "GENERATE_UUID_ONCE", requestedUnits: profile.runUnits }),
    startLead: owner("start-lead"), settleLead: owner("reconcile-lead-usage"),
    startReview: owner("start-review", { submissionId: "GENERATE_UUID_ONCE", n3Slots: c.n3Slots }),
    reconcileReview: owner("reconcile-ordinary-n2"), reconcileDelivery: owner("reconcile-delivery"),
    requestCorrection: owner("request-delivery-correction", { reservationId: "GENERATE_UUID_ONCE", reason: "ACTUAL_MATERIAL_FINDING_ONLY", criteria: ["EXACT_BOUNDED_CRITERION"] }),
    agents: Object.fromEntries(Object.entries(c.agents).map(([role, agent]: [string, any]) => [role, { id: agent.id, path: `/api/agents/${agent.id}`,
      enableBody: { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } },
      holdBody: { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } } } }])),
    upgradeAcceptedBuild: { method: "POST", path: `/api/plugins/${input.pluginId}/upgrade`, body: {}, precondition: "all runs terminal and settled; local HEAD equals accepted candidate; build/checks pass in this exact packagePath; then GET plugin and record source/dist hash before real browser observation" },
    sequence: ["No provider/publication without explicit campaign authorization; no test-environment in provider-free prep",
      "Read back configured agents, actual CLI tool/auth access and fresh GitHub target before effect; never print or manually copy host credentials",
      "Activate existing envelope then enable required demand wakes; start lead once and immediately hold lead demand wakes",
      "Owner observes N1 child terminal/settled usage, then closes only that child; lead sequentially dispatches next child",
      "Settle terminal lead, require ready_for_review; configure delivery from CURRENT plan revision (lead may have refined it), restore lead demand wakes, start ordinary review",
      "Installed controller owns N3/Council and publisher; owner observes costs/unknowns, never replaces unknown effects",
      "Only a real correction can consume ordinal1; execute returned same-owner resume action once, no extra wake",
      "On native GitHub backoff owner refresh/reconciles after nextRefreshAt without another model run",
      "After orchestration is terminal/settled, build accepted candidate at installed packagePath, upgrade same plugin, then observe actual Delivery UI in this instance",
      "Stop only this owned session after archiving evidence; stop pauses/cancels any remaining owned campaign runs before cleanup"] };
}

async function keepSession(input: any, c: any, proof: any) {
  const id = randomUUID(); const stopFile = resolve(input.runtime, "ordinary-campaign.stop");
  const privateFile = resolve(input.runtime, "operator-owner.json"); const curlFile = resolve(input.runtime, "operator-owner.curl");
  await writeFile(privateFile, JSON.stringify({ email: "council-package@example.test", password: input.ownerPassword, baseUrl: input.baseUrl }), { mode: 0o600, flag: "wx" });
  await writeFile(curlFile, `header = "Cookie: ${input.cookie}"\nheader = "Origin: ${input.baseUrl}"\nheader = "Content-Type: application/json"\n`, { mode: 0o600, flag: "wx" });
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600); assert.equal((await stat(curlFile)).mode & 0o777, 0o600);
  proof.session = { id, runtime: input.runtime, stopFile, baseUrl: input.baseUrl, privateOwnerFile: privateFile, ownerCurlConfig: curlFile,
    preparedAt: new Date().toISOString(), state: "waiting_operator", automaticWake: false };
  await input.save(); console.log(`Ordinary session prepared, agents disabled. Evidence: ${process.env.COUNCIL_PACKAGE_EVIDENCE_PATH}`);
  const deadline = Date.now() + 150 * 60_000;
  while (Date.now() < deadline) {
    const requested = await readFile(stopFile, "utf8").catch((error: any) => { if (error.code === "ENOENT") return null; throw error; });
    if (requested !== null) { assert.equal(requested, id); break; }
    await new Promise(r => setTimeout(r, 500));
  }
  for (const agent of Object.values(c.agents) as any[]) await c.api("PATCH", `/api/agents/${agent.id}`, { status: "paused" });
  const runs = await c.api("GET", `/api/companies/${c.companyId}/heartbeat-runs`);
  for (const run of runs.filter((r: any) => ["queued", "running", "scheduled_retry"].includes(r.status))) await c.api("POST", `/api/heartbeat-runs/${run.id}/cancel`);
  proof.session.state = "stopped"; proof.session.stoppedAt = new Date().toISOString(); proof.session.finalRuns = await c.api("GET", `/api/companies/${c.companyId}/heartbeat-runs`);
}

export async function runOrdinaryCampaignPreparation(input: any, profile: any) {
  const c = await prepareN45(input, profile);
  const configuredCompanies = await input.db.select({ companyId: input.tables.pluginConfig.companyId }).from(input.tables.pluginConfig).where(input.eq(input.tables.pluginConfig.pluginId, input.pluginId));
  assert.deepEqual(configuredCompanies, [{ companyId: c.companyId }], "Single-tenant worker must have only the campaign company configuration");
  const plugin = await c.api("GET", `/api/plugins/${input.pluginId}`);
  assert.equal(plugin.packagePath, c.repository, "Installed path must be the exact mission workspace for future accepted UI upgrade");
  const before = await c.api("GET", `${c.missionPath}?companyId=${c.companyId}`);
  await c.api("POST", `/api/plugins/${input.pluginId}/upgrade`, {});
  const afterPlugin = await c.api("GET", `/api/plugins/${input.pluginId}`);
  assert.equal(afterPlugin.packagePath, c.repository); assert.equal(afterPlugin.status, "ready");
  const after = await c.api("GET", `${c.missionPath}?companyId=${c.companyId}`);
  assert.equal(after.mission.version, before.mission.version, "Package reload must preserve prepared mission");
  const readbacks = [];
  for (const [role, agent] of Object.entries(c.agents) as [string, any][]) {
    const configuration = await c.api("GET", `/api/agents/${agent.id}/configuration`);
    const instructions = await c.api("GET", `/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`);
    assert.match(JSON.stringify(instructions), /PAPERCLIP_API_KEY/);
    assert.equal(agent.adapterType, "codex_local"); assert.equal(agent.adapterConfig.engine, "cli");
    assert.equal(agent.runtimeConfig.heartbeat.wakeOnDemand, false);
    readbacks.push({ role, agent, configuration, instructions, instructionsHash: createHash("sha256").update(JSON.stringify(instructions)).digest("hex") });
  }
  const runs = await c.api("GET", `/api/companies/${c.companyId}/heartbeat-runs`); assert.equal(runs.length, 0);
  const wakes = await input.db.select({ id: input.tables.agentWakeupRequests.id }).from(input.tables.agentWakeupRequests).where(input.eq(input.tables.agentWakeupRequests.companyId, c.companyId)); assert.equal(wakes.length, 0);
  const proof = input.evidence.ordinaryCampaign = { profile, workspace: input.workspaceProof, handoff: ordinaryCampaignHandoff(c, input, profile),
    agents: readbacks, configuredCompanies, installedBefore: plugin, installedAfter: afterPlugin, mission: after.mission,
    configuration: await c.api("GET", `/api/plugins/${input.pluginId}/config?companyId=${c.companyId}`),
    admission: await c.api("GET", `${c.admissionPath}?companyId=${c.companyId}&periodKey=${c.operatingProfile.periodKey}`),
    runCountAtPreparation: 0, wakeupCountAtPreparation: 0, providerInvocationCountAtPreparation: 0, githubWriteCountAtPreparation: 0, modelAvailabilityObserved: false,
    boundary: "At preparation snapshot: configured and loaded only. Same-path upgrade observed; no produced UI, real model, subprocess sandbox authentication, provider access or GitHub publication qualified." };
  await input.save();
  if (profile.mode === "session") await keepSession(input, c, proof);
  input.evidence.outcome = "ORDINARY CAMPAIGN PREPARATION OBSERVED";
}
