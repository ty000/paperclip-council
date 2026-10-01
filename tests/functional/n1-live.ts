import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ApiResult = { status: number; body: any; headers: Headers };
type ApiRequest = (actor: string, method: string, path: string, body?: unknown) => Promise<ApiResult>;
type RunSnapshot = {
  id: string;
  agentId: string;
  status: string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
  usageJson: Record<string, unknown> | null;
};

export function nativeRunEvidence(run: RunSnapshot | null): Record<string, unknown> | null {
  if (!run) return null;
  return {
    id: run.id,
    agentId: run.agentId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    usageJson: run.usageJson,
  };
}

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

export function assertNoReviewerRuns(result: ApiResult): any[] {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert(Array.isArray(result.body), "reviewer run readback must return an array");
  assert.equal(result.body.length, 0, `reviewer must not run during N1: ${JSON.stringify(result.body)}`);
  return result.body;
}

export function n1DeliveryAdapterConfig(input: {
  model: string;
  effort: string;
  repository: string;
}): Record<string, unknown> {
  return {
    engine: "cli",
    model: input.model,
    modelReasoningEffort: input.effort,
    timeoutSec: 1_200,
    dangerouslyBypassApprovalsAndSandbox: false,
    extraArgs: [
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--add-dir", resolve(input.repository, ".git"),
    ],
  };
}

export function assertOnlyExpectedAgentRun(
  result: ApiResult,
  expectedRunId: string,
  agentLabel: string,
): any[] {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert(Array.isArray(result.body), `${agentLabel} run readback must return an array`);
  assert.deepEqual(
    result.body.map((run: any) => run?.id),
    [expectedRunId],
    `${agentLabel} must have exactly the expected native run`,
  );
  return result.body;
}

function hasKnownPositiveUsage(reservation: any): boolean {
  return reservation.usage?.status === "known"
    && Number.isSafeInteger(reservation.usage.units)
    && reservation.usage.units > 0;
}

function hasNoRemainingExposure(reservation: any): boolean {
  return reservation.remainingExposure?.status === "known"
    && reservation.remainingExposure.units === 0;
}

function isFullySettledReservation(reservation: any): boolean {
  return reservation.status === "settled"
    && hasKnownPositiveUsage(reservation)
    && hasNoRemainingExposure(reservation);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the explicitly authorized N1 live run`);
  return value;
}

function assertPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

function promptPolicy(target: string): string {
  return [
    "Plugins/skills à utiliser",
    "Use the Paperclip skill injected by the host for issue context, authenticated API calls, attachments, and status updates. No additional plugin is required.",
    "",
    "Modele et effort recommandes",
    `Target: ${target}. Model: gpt-5.6-sol. Effort: high because this run participates in a governed native integration proof. Re-evaluate only if availability is rejected before launch; do not silently substitute. Source: independent mapping /home/davy-lp/.codex/shared/model-selection/model-effort-mapping.md, updated 2026-09-05. Effective runtime settings must be observed separately.`,
  ].join("\n");
}

export function contributorInstructions(): string {
  return [
    "You are one bounded Council N1 contributor. Work only on the currently assigned Paperclip child issue and current shared Git workspace.",
    "Read the issue title and description. Create the one requested owned file with exactly the requested one-line content and a trailing newline. Do not modify any other path.",
    'Commit that file with a concise commit message. Then use the authenticated Council endpoint named in the issue description. The first request body is exactly {"command":"inspect","missionId":"<mission-id>"}; replace <mission-id> with the stated Mission ID. Read body.version, then POST command=record-contribution with missionId, a fresh UUID commandId, that expectedVersion, the stated contributionId, and git rev-parse HEAD as commit. The current issue ID is available in the Paperclip task context and PAPERCLIP_TASK_ID.',
    "Use PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_RUN_ID. Normalize a trailing /api before constructing /api/plugins/... paths. Never print credentials.",
    "Only after record-contribution returns HTTP 200, PATCH this child issue status to done. Stop immediately on any non-2xx response; do not retry a model run or change unowned files.",
    "On failure, do not PATCH an issue status and do not create an issue comment: either may violate the native route contract or wake another run. Report the blocker only in your final response.",
    "",
    promptPolicy("bounded implementation contributor"),
  ].join("\n");
}

export function leadInstructions(): string {
  return [
    "You are the Council N1 Integration Lead. Execute the root issue exactly. You coordinate two sequential native contribution runs and publish one verified Git candidate; you do not author either contribution file.",
    'All mission transitions must POST to /api/plugins/<plugin-id>/api/issues/<root-issue-id>/council/commands with the injected bearer token and run header. Before every state-changing command, send exactly {"command":"inspect","missionId":"<mission-id>"} with the actual Mission ID, then use the returned version as expectedVersion. Use fresh UUIDs for commandId and reservationId. Never use direct database access or synthetic run binding.',
    "After dispatching a child, retain its childIssueId and dispatchRunId from the response. Poll GET /api/heartbeat-runs/<dispatchRunId> until a terminal status with finishedAt, then call reconcile-usage immediately for that contribution using one stable commandId, regardless of run success or whether the child issue is done. If reconciliation returns only g4_run_not_terminal or g4_usage_unavailable while Paperclip finalizes its token ledger, repeat that same command after two seconds for at most 30 observations; any other refusal is a blocker. After settlement, require the child issue to be done and inspect the mission to require its commit before dispatching the next child. A terminal run without a recorded contribution is a blocker: do not dispatch the next child. This polling is observation, never a provider/model retry.",
    "After both contributions are done and reconciled, create a distinct empty integration commit with git commit --allow-empty. Create refs/heads/base at the stated base commit and refs/heads/candidate at the integration commit, then create and verify a self-contained Git bundle containing those exact refs.",
    "Prove failure blocking once: call publish with a fresh random attachmentId and syntactically valid identities/digest, require HTTP 422 integration_failed, and verify inspect still has no candidate. Do not repeat the failed publish.",
    "Upload the valid bundle with multipart field file to /api/companies/<company-id>/issues/<root-issue-id>/attachments using the same auth headers, compute its SHA-256, then call publish with the returned attachment ID, base commit, integration commit, and digest. Require HTTP 200 and outcome=applied. Finally PATCH the root issue status to done.",
    "Use PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_RUN_ID; normalize a trailing /api. Never print credentials. On any unexpected response, do not PATCH an issue status and do not create an issue comment because either may wake another run. Leave the issue open and report the blocker only in your final response.",
    "",
    promptPolicy("Council N1 integration lead"),
  ].join("\n");
}

async function waitForTerminalRun(
  runId: string,
  getRun: (runId: string) => Promise<RunSnapshot | null>,
  timeoutMs = 20 * 60_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRun(runId);
    if (run && terminalStatuses.has(run.status)) return run;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  throw new Error(`Native Paperclip run ${runId} did not reach a terminal state within ${timeoutMs} ms`);
}

async function requestUsageReconciliation(
  request: ApiRequest,
  commandPath: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  let result: ApiResult | null = null;
  for (let observation = 0; observation < 30; observation += 1) {
    result = await request("human", "POST", commandPath, body);
    if (result.status === 200) break;
    if (result.status !== 409 || !["g4_run_not_terminal", "g4_usage_unavailable"].includes(result.body?.code)) {
      break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  assert(result);
  return result;
}

export async function reconcileTerminalN1Usage(input: {
  request: ApiRequest;
  getRun: (runId: string) => Promise<RunSnapshot | null>;
  commandPath: string;
  companyId: string;
  leadRun: RunSnapshot;
  missionBeforeLeadReconciliation: any;
}): Promise<{
  runs: RunSnapshot[];
  contributionSettlements: Array<Record<string, unknown>>;
  leadSettlement: ApiResult;
}> {
  const contributions = input.missionBeforeLeadReconciliation.mission.aggregate.n1.contributions as any[];
  const dispatched = contributions.filter((slot) => typeof slot.dispatchRunId === "string" && slot.dispatchRunId.length > 0);
  const contributionSettlements: Array<Record<string, unknown>> = [];
  const runs: RunSnapshot[] = [input.leadRun];
  for (const slot of dispatched) {
    const run = await waitForTerminalRun(slot.dispatchRunId, input.getRun);
    runs.push(run);
    const command = {
      companyId: input.companyId,
      command: "reconcile-contribution-usage",
      commandId: randomUUID(),
      contributionId: slot.contributionId,
    };
    const result = await requestUsageReconciliation(input.request, input.commandPath, command);
    contributionSettlements.push({
      contributionId: slot.contributionId,
      runId: slot.dispatchRunId,
      runStatus: run.status,
      request: command,
      response: { status: result.status, body: result.body },
    });
  }

  const leadCommand = {
    companyId: input.companyId,
    command: "reconcile-lead-usage",
    commandId: randomUUID(),
    expectedVersion: input.missionBeforeLeadReconciliation.mission.version,
  };
  const leadSettlement = await requestUsageReconciliation(input.request, input.commandPath, leadCommand);
  return { runs, contributionSettlements, leadSettlement };
}

// fallow-ignore-next-line complexity
export async function runLiveN1(input: {
  request: ApiRequest;
  getRun: (runId: string) => Promise<RunSnapshot | null>;
  pluginId: string;
  runtime: string;
  baseUrl: string;
  ownerUserId: string;
  evidence: Record<string, any>;
}) {
  assert.equal(requiredEnv("COUNCIL_N1_LIVE_AUTHORIZED"), "1", "live provider execution needs explicit authorization");
  const model = requiredEnv("COUNCIL_N1_LIVE_MODEL");
  const effort = requiredEnv("COUNCIL_N1_LIVE_EFFORT");
  assert.equal(model, "gpt-5.6-sol", "authorized live model must match the bounded operating profile");
  assert.equal(effort, "high", "authorized live effort must match the bounded operating profile");
  const runReservationUnits = assertPositiveInteger(requiredEnv("COUNCIL_N1_LIVE_RUN_UNITS"), "COUNCIL_N1_LIVE_RUN_UNITS");
  const periodAllowanceUnits = assertPositiveInteger(requiredEnv("COUNCIL_N1_LIVE_PERIOD_UNITS"), "COUNCIL_N1_LIVE_PERIOD_UNITS");
  assert(periodAllowanceUnits >= runReservationUnits * 3, "period allowance must cover exactly the lead and two contributors");

  const repository = resolve(input.runtime, "n1-live-repository");
  await mkdir(repository, { recursive: true });
  await writeFile(resolve(repository, "README.md"), "# Council N1 observable qualification\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: repository });
  execFileSync("git", ["config", "user.name", "Council N1 Qualification"], { cwd: repository });
  execFileSync("git", ["config", "user.email", "council-n1@example.test"], { cwd: repository });
  execFileSync("git", ["add", "README.md"], { cwd: repository });
  execFileSync("git", ["commit", "-m", "Initialize N1 qualification repository"], { cwd: repository });
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  const company = await input.request("human", "POST", "/api/companies", {
    name: "Council N1 native observable qualification",
    description: "Ephemeral local campaign with one lead and two sequential contributors.",
    budgetMonthlyCents: 0,
    defaultResponsibleUserId: input.ownerUserId,
  });
  assert.equal(company.status, 201, JSON.stringify(company.body));
  const companyId = company.body.id as string;

  const createAgent = async (name: string, role: string, instructions: string, needsGit = false) => {
    const created = await input.request("human", "POST", `/api/companies/${companyId}/agents`, {
      name,
      role,
      adapterType: "codex_local",
      adapterConfig: needsGit
        ? n1DeliveryAdapterConfig({ model, effort, repository })
        : {
            engine: "cli",
            model,
            modelReasoningEffort: effort,
            timeoutSec: 1_200,
            dangerouslyBypassApprovalsAndSandbox: false,
            filesystemScope: "workspace",
          },
      instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": instructions } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      budgetMonthlyCents: 0,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  };

  const lead = await createAgent("N1 Integration Lead", "engineer", leadInstructions(), true);
  const contributorA = await createAgent("N1 Contributor Alpha", "engineer", contributorInstructions(), true);
  const contributorB = await createAgent("N1 Contributor Beta", "engineer", contributorInstructions(), true);
  const reviewer = await createAgent("N1 Independent Reviewer", "qa", [
    "You are reserved for the later independent Council review. N1 must stop before waking you.",
    "",
    promptPolicy("ordinary final reviewer; not launched during N1"),
  ].join("\n"));
  const observedModelSettings = [lead, contributorA, contributorB].map((agent) => ({
    agentId: agent.id,
    adapterType: agent.adapterType,
    model: agent.adapterConfig?.model ?? null,
    effort: agent.adapterConfig?.modelReasoningEffort ?? null,
  }));
  assert(observedModelSettings.every((setting) => setting.adapterType === "codex_local" && setting.model === model && setting.effort === effort));
  input.evidence.configuration.models = { authorized: { model, effort }, observedAgentConfiguration: observedModelSettings };
  input.evidence.configuration.fixtureBoundary = "The safe-boundary suite uses fixtures; the N1 live campaign below uses native APIs, native wakeups, exact Paperclip run IDs, and run-derived terminal token settlement.";

  const councilKey = await input.request("human", "POST", `/api/agents/${reviewer.id}/keys`, {
    name: "council-native-n1",
    scope: { kind: "standard" },
  });
  assert.equal(councilKey.status, 201, JSON.stringify(councilKey.body));
  const secret = await input.request("human", "POST", `/api/companies/${companyId}/secrets`, {
    name: "Council native N1 agent key",
    key: "COUNCIL_N1_AGENT_API_KEY",
    provider: "local_encrypted",
    value: councilKey.body.token,
    description: "Ephemeral N1 installed-path qualification credential",
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));

  const now = Date.now();
  const profile = {
    kind: "paperclip-orchestration-tokens-v1",
    periodKey: `n1-native-${new Date(now).toISOString().slice(0, 10)}-${randomUUID()}`,
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 45 * 60_000).toISOString(),
    periodAllowanceUnits,
    runReservationUnits,
    initialKnownUsageUnits: 0,
    initialExposureUnits: 0,
    initialTokenAccountingSource: `live-harness:fresh-company:${companyId}`,
  };
  const configured = await input.request("human", "POST", `/api/plugins/${input.pluginId}/config`, {
    companyId,
    configJson: {
      apiBaseUrl: input.baseUrl,
      councilAgentId: reviewer.id,
      councilApiKey: { type: "secret_ref", secretId: secret.body.id },
      n1OperatingProfile: profile,
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const project = await input.request("human", "POST", `/api/companies/${companyId}/projects`, {
    name: "Council N1 native repository",
    status: "in_progress",
    workspace: { name: "Shared N1 repository", sourceType: "local_path", cwd: repository, isPrimary: true },
    executionWorkspacePolicy: {
      enabled: true,
      sharedWorkspaceConcurrency: "allow",
      defaultMode: "shared_workspace",
      allowIssueOverride: false,
      workspaceStrategy: { type: "project_primary" },
    },
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const projectId = project.body.id as string;

  const rosterBase = `/api/plugins/${input.pluginId}/api/companies/${companyId}/rosters`;
  const team = await input.request("human", "POST", rosterBase, {
    companyId,
    command: "create",
    roster: {
      kind: "team",
      name: "N1 native delivery team",
      projectId,
      members: [
        { agentId: lead.id, responsibilities: ["integration_lead"] },
        { agentId: contributorA.id, responsibilities: ["alpha_contributor"] },
        { agentId: contributorB.id, responsibilities: ["beta_contributor"] },
      ],
      integrationLeadAgentId: lead.id,
      finalReviewerAgentId: null,
      requiredPerspectives: [],
    },
  });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  const council = await input.request("human", "POST", rosterBase, {
    companyId,
    command: "create",
    roster: {
      kind: "council",
      name: "N1 independent review council",
      projectId,
      members: [{ agentId: reviewer.id, responsibilities: ["final_reviewer"] }],
      integrationLeadAgentId: null,
      finalReviewerAgentId: reviewer.id,
      requiredPerspectives: ["integration_quality"],
    },
  });
  assert.equal(council.status, 201, JSON.stringify(council.body));
  const pair = await input.request("human", "POST", rosterBase, {
    companyId,
    command: "activate-pair",
    teamRosterId: team.body.head.rosterId,
    teamExpectedVersion: team.body.head.version,
    councilRosterId: council.body.head.rosterId,
    councilExpectedVersion: council.body.head.version,
  });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));

  const admissionPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/admission`;
  const admissionConfiguration = {
    companyId,
    periodKey: profile.periodKey,
    periodStart: profile.periodStart,
    periodEnd: profile.periodEnd,
    measurement: {
      status: "known",
      source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger",
      unit: "tokens",
    },
    allowance: {
      status: "known",
      source: `plugin-config:n1OperatingProfile:initial-token-accounting:${profile.initialTokenAccountingSource}`,
      periodUnits: periodAllowanceUnits,
      taskUnits: runReservationUnits,
      knownUsageUnits: 0,
    },
    exposure: {
      status: "known",
      source: `plugin-config:n1OperatingProfile:initial-token-accounting:${profile.initialTokenAccountingSource}`,
      units: 0,
    },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 0 },
    commandId: randomUUID(),
  };
  const admission = await input.request("human", "POST", admissionPath, {
    companyId, command: "configure", configuration: admissionConfiguration,
  });
  assert.equal(admission.status, 200, JSON.stringify(admission.body));

  const root = await input.request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "N1 observable: integrate alpha and beta contributions",
    description: "Council mission setup in progress.",
    projectId,
    status: "backlog",
    assigneeAgentId: lead.id,
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));
  const missionId = randomUUID();
  const contributionAId = randomUUID();
  const contributionBId = randomUUID();
  const missionBase = `/api/plugins/${input.pluginId}/api/companies/${companyId}/missions`;
  const mission = await input.request("human", "POST", missionBase, {
    companyId,
    command: "create",
    commandId: randomUUID(),
    missionId,
    rootIssueId: root.body.id,
    projectId,
    teamRosterId: pair.body.team.head.rosterId,
    teamRevision: pair.body.team.revision.revision,
    councilRosterId: pair.body.council.head.rosterId,
    councilRevision: pair.body.council.revision.revision,
    mandate: {
      objective: "Produce one checked candidate containing two attributed native contributions.",
      acceptanceCriteria: [
        "alpha.txt contains alpha contribution and is authored by Contributor Alpha",
        "beta.txt contains beta contribution and is authored by Contributor Beta",
        "an invalid candidate is blocked before one valid bundle is published",
      ],
      commitments: ["Use only native Paperclip dispatch and run-derived G4 token settlement", "Stop at ready_for_review"],
      limits: {
        taskPolicy: `${runReservationUnits} token units reserved per native run`,
        periodPolicy: `${periodAllowanceUnits} token units for exactly three native runs`,
        correctionLimit: 0,
        elapsedMinutes: 40,
      },
    },
  });
  assert.equal(mission.status, 201, JSON.stringify(mission.body));

  const rootDescription = [
    "Execute this Council N1 mission to ready_for_review and then stop.",
    `Plugin ID: ${input.pluginId}`,
    `Company ID: ${companyId}`,
    `Mission ID: ${missionId}`,
    `Base commit: ${baseCommit}`,
    `Run reservation units: ${runReservationUnits}`,
    `Contribution Alpha: id=${contributionAId}; assignee=${contributorA.id}; title=Create alpha.txt with exact content alpha contribution; ownedPaths=[alpha.txt]`,
    `Contribution Beta: id=${contributionBId}; assignee=${contributorB.id}; title=Create beta.txt with exact content beta contribution; ownedPaths=[beta.txt]`,
    "Plan exactly those two slots, materialize both, then dispatch and reconcile Alpha before dispatching Beta. Follow your AGENTS.md integration and failure-blocking procedure.",
    `Agent command bodies always include missionId. The exact inspect body is {"command":"inspect","missionId":"${missionId}"}. plan additionally needs commandId, expectedVersion and contributions=[{contributionId,assigneeAgentId,title,ownedPaths},...]. materialize needs commandId, expectedVersion and contributionId. dispatch needs commandId, expectedVersion, contributionId, a fresh reservationId and requestedUnits. reconcile-usage needs commandId and contributionId. publish needs commandId, expectedVersion, attachmentId, baseCommit, candidateCommit and expectedSha256.`,
    "For every POST use Content-Type application/json, Authorization Bearer $PAPERCLIP_API_KEY and X-Paperclip-Run-Id $PAPERCLIP_RUN_ID. The agent command URL uses the root issue ID from this task context.",
    "Do not wake the reviewer and do not start N2.",
    "",
    promptPolicy("Council N1 integration lead"),
  ].join("\n");
  const rootUpdated = await input.request("human", "PATCH", `/api/issues/${root.body.id}`, { description: rootDescription });
  assert.equal(rootUpdated.status, 200, JSON.stringify(rootUpdated.body));

  const commandPath = `${missionBase}/${missionId}/commands`;
  const activated = await input.request("human", "POST", commandPath, {
    companyId,
    command: "activate",
    commandId: randomUUID(),
    expectedVersion: mission.body.mission.version,
    periodKey: profile.periodKey,
    reservationId: randomUUID(),
    requestedUnits: runReservationUnits,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const started = await input.request("human", "POST", commandPath, {
    companyId,
    command: "start-lead",
    commandId: randomUUID(),
    expectedVersion: activated.body.mission.version,
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.outcome, "requested");
  const leadRunId = started.body.mission.aggregate.n1.rootDispatchRunId as string;
  assert.match(leadRunId, /^[0-9a-f-]{36}$/i);

  const liveEvidence: Record<string, any> = {
    stage: "lead_requested",
    companyId,
    companyIssuePrefix: company.body.issuePrefix,
    projectId,
    repository,
    baseCommit,
    missionId,
    rootIssueId: root.body.id,
    agents: { lead: lead.id, contributors: [contributorA.id, contributorB.id], reviewer: reviewer.id },
    usageAccounting: {
      profile: "codex_local/cli",
      formula: "inputTokens + outputTokens",
      cachedInputTokens: "retained in usageJson as an inputTokens subset; not added again",
    },
    runs: [],
  };
  input.evidence.liveN1 = liveEvidence;

  const leadRunBarrier = await input.request("human", "PATCH", `/api/agents/${lead.id}`, {
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } },
  });
  assert.equal(leadRunBarrier.status, 200, JSON.stringify(leadRunBarrier.body));
  assert.equal(leadRunBarrier.body.runtimeConfig?.heartbeat?.wakeOnDemand, false);

  const leadRun = await waitForTerminalRun(leadRunId, input.getRun);
  liveEvidence.stage = "lead_terminal";
  liveEvidence.runs = [nativeRunEvidence(leadRun)];

  const postLeadMission = await input.request("human", "GET", `${missionBase}/${missionId}?companyId=${companyId}`);
  assert.equal(postLeadMission.status, 200, JSON.stringify(postLeadMission.body));
  liveEvidence.missionAfterLead = postLeadMission.body;
  const phaseBeforeLeadReconciliation = postLeadMission.body.mission.aggregate.phase;
  const usageReconciliation = await reconcileTerminalN1Usage({
    request: input.request,
    getRun: input.getRun,
    commandPath,
    companyId,
    leadRun,
    missionBeforeLeadReconciliation: postLeadMission.body,
  });
  liveEvidence.runs = usageReconciliation.runs.map(nativeRunEvidence);
  liveEvidence.contributionUsageSettlements = usageReconciliation.contributionSettlements;
  liveEvidence.usageSettlement = {
    status: usageReconciliation.leadSettlement.status,
    body: usageReconciliation.leadSettlement.body,
  };

  const postReconciliationMission = await input.request("human", "GET", `${missionBase}/${missionId}?companyId=${companyId}`);
  assert.equal(postReconciliationMission.status, 200, JSON.stringify(postReconciliationMission.body));
  const admissionAfterLead = await input.request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(profile.periodKey)}`);
  assert.equal(admissionAfterLead.status, 200, JSON.stringify(admissionAfterLead.body));
  liveEvidence.stage = usageReconciliation.leadSettlement.status === 200
    ? "terminal_usage_reconciled"
    : "lead_usage_reconciliation_refused";
  liveEvidence.mission = postReconciliationMission.body;
  liveEvidence.admission = admissionAfterLead.body;
  assert(usageReconciliation.contributionSettlements.every((entry: any) => entry.response.status === 200),
    JSON.stringify(usageReconciliation.contributionSettlements));
  assert.equal(usageReconciliation.leadSettlement.status, 200, JSON.stringify(usageReconciliation.leadSettlement.body));
  assert.equal(leadRun.status, "succeeded", `lead run failed: ${leadRun.error ?? "unknown error"}`);
  assert.equal(phaseBeforeLeadReconciliation, "integrating");

  const finalMission = postReconciliationMission;
  const finalState = finalMission.body.mission.aggregate.n1;
  assert.equal(finalMission.body.mission.aggregate.phase, "ready_for_review");
  assert.equal(finalMission.body.mission.aggregate.control.status, "inactive");
  assert.equal(finalState.contributions.length, 2);
  assert(finalState.contributions.every((slot: any) => /^[0-9a-f]{40}$/.test(slot.commit)));
  assert.equal(finalState.candidate.outcome, "verified");
  assert.equal(finalState.candidate.publicationEligible, true);
  assert(finalMission.body.mission.aggregate.journal.some((entry: any) => entry.action === "integration_check_failed"));

  const admissionFinal = await input.request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(profile.periodKey)}`);
  assert.equal(admissionFinal.status, 200, JSON.stringify(admissionFinal.body));
  const settledReservations = admissionFinal.body.envelope.reservations as any[];
  assert.equal(settledReservations.length, 3);
  assert(settledReservations.every(isFullySettledReservation));
  const knownUsageUnits = admissionFinal.body.envelope.allowance?.knownUsageUnits;
  assert(Number.isSafeInteger(knownUsageUnits) && knownUsageUnits > 0);
  assert.equal(knownUsageUnits, settledReservations.reduce((total: number, reservation: any) => total + reservation.usage.units, 0));
  assert.match(admissionFinal.body.envelope.measurement.source, /terminal-token-ledger/);

  const issueRuns = await Promise.all([
    leadRunId,
    ...finalState.contributions.map((slot: any) => slot.dispatchRunId),
  ].map((runId: string) => input.getRun(runId)));
  assert.equal(issueRuns.length, 3);
  assert(issueRuns.every((run) => run?.status === "succeeded"));
  assert(issueRuns.every((run) => run?.finishedAt));

  const reviewerRunReadback = await input.request(
    "human",
    "GET",
    `/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(reviewer.id)}&limit=1000&summary=1`,
  );
  const reviewerRuns = assertNoReviewerRuns(reviewerRunReadback);
  const leadRunReadback = await input.request(
    "human",
    "GET",
    `/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(lead.id)}&limit=1000&summary=1`,
  );
  const observedLeadRuns = assertOnlyExpectedAgentRun(leadRunReadback, leadRunId, "lead");

  Object.assign(liveEvidence, {
    stage: "ready_for_review",
    runs: issueRuns.map(nativeRunEvidence),
    mission: finalMission.body,
    admission: admissionFinal.body,
    usageSettlement: {
      status: usageReconciliation.leadSettlement.status,
      body: usageReconciliation.leadSettlement.body,
    },
    leadRunBarrier: {
      expectedRunId: leadRunId,
      wakeOnDemand: leadRunBarrier.body.runtimeConfig.heartbeat.wakeOnDemand,
      observedRunIds: observedLeadRuns.map((run: any) => run.id),
    },
    reviewerRunCount: reviewerRuns.length,
    stopBoundary: "ready_for_review; N2 not started",
  });
  input.evidence.results.n1NativeLeadAndTwoContributors = "PASS";
  input.evidence.results.n1IntegrationFailureBlocked = "PASS";
  input.evidence.results.n1VerifiedCandidateReadyForReview = "PASS";
  input.evidence.results.n1NativeG4UsageSettled = "PASS";
  input.evidence.results.n1LeadSingleRunBarrier = "PASS";

  return {
    companyId,
    issuePrefix: company.body.issuePrefix as string,
    missionId,
    rootIssueId: root.body.id as string,
    mission: finalMission.body,
    admission: admissionFinal.body,
  };
}
