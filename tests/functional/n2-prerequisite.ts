import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { n1DeliveryAdapterConfig, n2LeadInstructions, n2ReviewerInstructions } from "./n1-live.js";

type ApiResult = { status: number; body: any; headers: Headers };
type ApiRequest = (actor: string, method: string, path: string, body?: unknown) => Promise<ApiResult>;

type AgentIdentity = { id: string; companyId: string; token: string; keyId: string };
type LiveN2Profile = {
  model: string;
  effort: string;
  runReservationUnits: number;
  periodAllowanceUnits: number;
};

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

async function createCandidate(runtime: string) {
  const repository = resolve(runtime, "n2-isolated-repository");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "n2-prerequisite@example.test"]);
  git(repository, ["config", "user.name", "N2 Prerequisite Harness"]);
  await writeFile(resolve(repository, "README.md"), "N2 isolated prerequisite\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "base", baseCommit]);

  git(repository, ["switch", "-c", "contribution-alpha"]);
  await writeFile(resolve(repository, "alpha.txt"), "alpha contribution\n");
  git(repository, ["add", "alpha.txt"]);
  git(repository, ["commit", "-m", "alpha contribution"]);
  const alphaCommit = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "main"]);
  git(repository, ["switch", "-c", "contribution-beta"]);
  await writeFile(resolve(repository, "beta.txt"), "beta contribution\n");
  git(repository, ["add", "beta.txt"]);
  git(repository, ["commit", "-m", "beta contribution"]);
  const betaCommit = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "-c", "candidate-v1"]);
  git(repository, ["merge", "--no-ff", "contribution-alpha", "-m", "integrate N1 candidate"]);
  const candidateCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "candidate", candidateCommit]);
  const bundlePath = resolve(runtime, "n2-isolated-v1.bundle");
  git(repository, ["bundle", "create", bundlePath, "refs/heads/base", "refs/heads/candidate"]);
  git(repository, ["bundle", "verify", bundlePath]);
  const bundleBytes = await readFile(bundlePath);
  return {
    repository,
    baseCommit,
    alphaCommit,
    betaCommit,
    candidateCommit,
    bundlePath,
    bundleBytes,
    sha256: createHash("sha256").update(bundleBytes).digest("hex"),
  };
}

async function createAgent(input: {
  request: ApiRequest;
  companyId: string;
  actor: string;
  name: string;
  role: string;
  live?: { profile: LiveN2Profile; repository: string; instructions: string };
}) {
  const agent = await input.request("human", "POST", `/api/companies/${input.companyId}/agents`, {
    name: input.name,
    role: input.role,
    adapterType: input.live ? "codex_local" : "process",
    adapterConfig: input.live
      ? n1DeliveryAdapterConfig({
          model: input.live.profile.model,
          effort: input.live.profile.effort,
          repository: input.live.repository,
        })
      : { command: "/usr/bin/false" },
    ...(input.live
      ? { instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": input.live.instructions } } }
      : {}),
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: Boolean(input.live), maxConcurrentRuns: 1 } },
    budgetMonthlyCents: 0,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const key = await input.request("human", "POST", `/api/agents/${agent.body.id}/keys`, {
    name: `${input.actor}-n2-prerequisite`,
    scope: { kind: "standard" },
  });
  assert.equal(key.status, 201, JSON.stringify(key.body));
  return { id: agent.body.id, companyId: input.companyId, token: key.body.token, keyId: key.body.id, body: agent.body };
}

async function uploadBundle(input: {
  baseUrl: string;
  cookie: string;
  companyId: string;
  issueId: string;
  bytes: Buffer;
  sha256: string;
}) {
  const form = new FormData();
  form.append("file", new Blob([input.bytes], { type: "application/octet-stream" }), "n2-isolated-v1.bundle");
  const response = await fetch(`${input.baseUrl}/api/companies/${input.companyId}/issues/${input.issueId}/attachments`, {
    method: "POST",
    headers: { cookie: input.cookie, origin: input.baseUrl },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.sha256, input.sha256);
  return body;
}

// The nominal public-API workflow is intentionally linear so its order is directly auditable.
// fallow-ignore-next-line complexity
export async function prepareN2Prerequisite(input: {
  request: ApiRequest;
  pluginId: string;
  baseUrl: string;
  cookie: string;
  runtime: string;
  ownerUserId: string;
  liveN2Profile?: LiveN2Profile;
  registerActor: (actor: string, identity: AgentIdentity) => void;
  createFixtureRun: (actor: string, issueId: string) => Promise<string>;
}) {
  const candidate = await createCandidate(input.runtime);
  const company = await input.request("human", "POST", "/api/companies", {
    name: "Council N2 isolated prerequisite",
    description: "Deterministic N1 prerequisite with no agent or provider run.",
    budgetMonthlyCents: 0,
    defaultResponsibleUserId: input.ownerUserId,
  });
  assert.equal(company.status, 201, JSON.stringify(company.body));
  const companyId = company.body.id as string;
  const live = input.liveN2Profile;

  const lead = await createAgent({
    request: input.request,
    companyId,
    actor: "n2-prerequisite-lead",
    name: "N2 Prerequisite Lead",
    role: "engineer",
    ...(live ? { live: { profile: live, repository: candidate.repository, instructions: n2LeadInstructions() } } : {}),
  });
  const alpha = await createAgent({
    request: input.request, companyId, actor: "n2-prerequisite-alpha", name: "N2 Prerequisite Alpha", role: "engineer",
  });
  const beta = await createAgent({
    request: input.request, companyId, actor: "n2-prerequisite-beta", name: "N2 Prerequisite Beta", role: "engineer",
  });
  const reviewer = await createAgent({
    request: input.request,
    companyId,
    actor: "n2-prerequisite-reviewer",
    name: "N2 Independent Reviewer",
    role: "qa",
    ...(live ? { live: { profile: live, repository: candidate.repository, instructions: n2ReviewerInstructions() } } : {}),
  });
  for (const [actor, agent] of [
    ["n2-prerequisite-lead", lead],
    ["n2-prerequisite-alpha", alpha],
    ["n2-prerequisite-beta", beta],
    ["n2-prerequisite-reviewer", reviewer],
  ] as const) {
    input.registerActor(actor, agent);
  }

  const now = Date.now();
  const periodKey = `n2-prerequisite-${randomUUID()}`;
  const runReservationUnits = live?.runReservationUnits ?? 1;
  const periodAllowanceUnits = live?.periodAllowanceUnits ?? 3;
  const secret = await input.request("human", "POST", `/api/companies/${companyId}/secrets`, {
    name: "N2 prerequisite reviewer key",
    key: "COUNCIL_N2_PREREQUISITE_KEY",
    provider: "local_encrypted",
    value: reviewer.token,
    description: "Ephemeral provider-free prerequisite credential",
  });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));
  const configured = await input.request("human", "POST", `/api/plugins/${input.pluginId}/config`, {
    companyId,
    configJson: {
      apiBaseUrl: input.baseUrl,
      councilAgentId: reviewer.id,
      councilApiKey: { type: "secret_ref", secretId: secret.body.id },
      n1FixtureMode: "ephemeral-local-sandbox",
      ...(live ? {
        n1OperatingProfile: {
          kind: "paperclip-orchestration-tokens-v1",
          periodKey,
          periodStart: new Date(now - 60_000).toISOString(),
          periodEnd: new Date(now + 90 * 60_000).toISOString(),
          periodAllowanceUnits,
          runReservationUnits,
          initialKnownUsageUnits: 0,
          initialExposureUnits: 0,
          initialTokenAccountingSource: `isolated-live-harness:fresh-company:${companyId}`,
          maxCorrections: 1,
        },
      } : {}),
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  const project = await input.request("human", "POST", `/api/companies/${companyId}/projects`, {
    name: "Council N2 isolated repository",
    status: "in_progress",
    workspace: { name: "N2 prerequisite repository", sourceType: "local_path", cwd: candidate.repository, isPrimary: true },
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

  const rosterPath = `/api/plugins/${input.pluginId}/api/companies/${companyId}/rosters`;
  const team = await input.request("human", "POST", rosterPath, {
    companyId,
    command: "create",
    roster: {
      kind: "team",
      name: "N2 prerequisite team",
      projectId,
      members: [
        { agentId: lead.id, responsibilities: ["integration_lead"] },
        { agentId: alpha.id, responsibilities: ["contributor"] },
        { agentId: beta.id, responsibilities: ["contributor"] },
      ],
      integrationLeadAgentId: lead.id,
      finalReviewerAgentId: null,
      requiredPerspectives: [],
    },
  });
  const council = await input.request("human", "POST", rosterPath, {
    companyId,
    command: "create",
    roster: {
      kind: "council",
      name: "N2 prerequisite council",
      projectId,
      members: [{ agentId: reviewer.id, responsibilities: ["final_reviewer"] }],
      integrationLeadAgentId: null,
      finalReviewerAgentId: reviewer.id,
      requiredPerspectives: ["integration_quality"],
    },
  });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  assert.equal(council.status, 201, JSON.stringify(council.body));
  const pair = await input.request("human", "POST", rosterPath, {
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
    commandId: randomUUID(),
    companyId,
    periodKey,
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 60 * 60_000).toISOString(),
    measurement: {
      status: "known",
      source: live
        ? "paperclip:issues.summaries.getOrchestration:terminal-token-ledger"
        : "fixture:local-sandbox",
      unit: live ? "tokens" : "fixture-unit",
    },
    allowance: {
      status: "known",
      source: live
        ? `plugin-config:n1OperatingProfile:initial-token-accounting:isolated-live-harness:fresh-company:${companyId}`
        : "fixture:local-sandbox",
      periodUnits: periodAllowanceUnits,
      taskUnits: runReservationUnits,
      knownUsageUnits: 0,
    },
    exposure: {
      status: "known",
      source: live
        ? `plugin-config:n1OperatingProfile:initial-token-accounting:isolated-live-harness:fresh-company:${companyId}`
        : "fixture:local-sandbox",
      units: 0,
    },
    limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 },
  };
  const admission = await input.request("human", "POST", admissionPath, {
    companyId, command: "configure", configuration: admissionConfiguration,
  });
  assert.equal(admission.status, 200, JSON.stringify(admission.body));

  const root = await input.request("human", "POST", `/api/companies/${companyId}/issues`, {
    title: "N2 isolated prerequisite candidate",
    description: "Deterministic N1 preparation only. Stop before the first N2 reviewer.",
    projectId,
    status: "backlog",
    assigneeAgentId: lead.id,
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));
  const rootIssueId = root.body.id as string;
  const missionId = randomUUID();
  const missionBase = `/api/plugins/${input.pluginId}/api/companies/${companyId}/missions`;
  const created = await input.request("human", "POST", missionBase, {
    companyId,
    command: "create",
    commandId: randomUUID(),
    missionId,
    rootIssueId,
    projectId,
    teamRosterId: team.body.head.rosterId,
    teamRevision: pair.body.team.revision.revision,
    councilRosterId: council.body.head.rosterId,
    councilRevision: pair.body.council.revision.revision,
    mandate: {
      objective: "Prepare the deterministic N1 entry state for isolated native N2 qualification",
      acceptanceCriteria: ["Two attributed contributions form one verified V1 candidate"],
      commitments: ["No provider or native agent run", "Stop before N2 reviewer dispatch"],
      limits: {
        taskPolicy: `${runReservationUnits} units reserved per deterministic N1 or native N2 run`,
        periodPolicy: `${periodAllowanceUnits} units in the isolated ephemeral campaign`,
        correctionLimit: 1,
        elapsedMinutes: 30,
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const missionPath = `${missionBase}/${missionId}`;
  const rootReservationId = randomUUID();
  const activated = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "activate",
    commandId: randomUUID(),
    expectedVersion: created.body.mission.version,
    periodKey,
    reservationId: rootReservationId,
    requestedUnits: runReservationUnits,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  const rootStarted = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, { status: "in_progress" });
  assert.equal(rootStarted.status, 200, JSON.stringify(rootStarted.body));

  const fixtureHeartbeatRuns: Array<{
    actor: string;
    runId: string;
    companyId: string;
    agentId: string;
    issueId: string;
    status: "running";
    fixtureSource: "fixture:n2-prerequisite:deterministic-heartbeat";
  }> = [];
  const leadRunId = await input.createFixtureRun("n2-prerequisite-lead", rootIssueId);
  fixtureHeartbeatRuns.push({
    actor: "n2-prerequisite-lead",
    runId: leadRunId,
    companyId,
    agentId: lead.id,
    issueId: rootIssueId,
    status: "running",
    fixtureSource: "fixture:n2-prerequisite:deterministic-heartbeat",
  });
  const leadCheckout = await input.request("n2-prerequisite-lead", "POST", `/api/issues/${rootIssueId}/checkout`, {
    agentId: lead.id,
    expectedStatuses: ["in_progress"],
  });
  assert.equal(leadCheckout.status, 200, JSON.stringify(leadCheckout.body));
  const boundLead = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId,
    command: "fixture-bind-lead-run",
    fixtureSource: "fixture:local-sandbox",
    commandId: randomUUID(),
    expectedVersion: activated.body.mission.version,
    runId: leadRunId,
  });
  assert.equal(boundLead.status, 200, JSON.stringify(boundLead.body));

  const contributionIds = [randomUUID(), randomUUID()] as const;
  const plan = await input.request("n2-prerequisite-lead", "POST", `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/council/commands`, {
    missionId,
    command: "plan",
    commandId: randomUUID(),
    expectedVersion: boundLead.body.mission.version,
    contributions: [
      { contributionId: contributionIds[0], assigneeAgentId: alpha.id, title: "Alpha contribution", ownedPaths: ["alpha.txt"] },
      { contributionId: contributionIds[1], assigneeAgentId: beta.id, title: "Beta contribution", ownedPaths: ["beta.txt"] },
    ],
  });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  let mission = plan.body.mission;
  const materialized: Array<{ contributionId: string; childIssueId: string; actor: string; agent: AgentIdentity; commit: string }> = [];
  for (const [index, contributionId] of contributionIds.entries()) {
    const response = await input.request("n2-prerequisite-lead", "POST", `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/council/commands`, {
      missionId,
      command: "materialize",
      commandId: randomUUID(),
      expectedVersion: mission.version,
      contributionId,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.outcome, "confirmed");
    mission = response.body.mission;
    materialized.push({
      contributionId,
      childIssueId: response.body.effect.issue.id,
      actor: index === 0 ? "n2-prerequisite-alpha" : "n2-prerequisite-beta",
      agent: index === 0 ? alpha : beta,
      commit: index === 0 ? candidate.alphaCommit : candidate.betaCommit,
    });
  }

  const settleReservation = async (reservationId: string) => {
    const current = await input.request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(periodKey)}`);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    const settled = await input.request("human", "POST", admissionPath, {
      companyId,
      command: "settle",
      settlement: {
        commandId: randomUUID(),
        companyId,
        periodKey,
        reservationId,
        usage: { status: "known", source: "fixture:local-sandbox", units: 0 },
        remainingExposure: { status: "known", source: "fixture:local-sandbox", units: 0 },
        expectedVersion: current.body.envelope.version,
      },
    });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.reservation.status, "settled");
  };

  for (const contribution of materialized) {
    const started = await input.request("human", "PATCH", `/api/issues/${contribution.childIssueId}`, { status: "in_progress" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const runId = await input.createFixtureRun(contribution.actor, contribution.childIssueId);
    fixtureHeartbeatRuns.push({
      actor: contribution.actor,
      runId,
      companyId,
      agentId: contribution.agent.id,
      issueId: contribution.childIssueId,
      status: "running",
      fixtureSource: "fixture:n2-prerequisite:deterministic-heartbeat",
    });
    const checkout = await input.request(contribution.actor, "POST", `/api/issues/${contribution.childIssueId}/checkout`, {
      agentId: contribution.agent.id,
      expectedStatuses: ["in_progress"],
    });
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    const reservationId = randomUUID();
    const bound = await input.request("human", "POST", `${missionPath}/commands`, {
      companyId,
      command: "fixture-bind-contribution-run",
      fixtureSource: "fixture:local-sandbox",
      commandId: randomUUID(),
      expectedVersion: mission.version,
      contributionId: contribution.contributionId,
      reservationId,
      requestedUnits: runReservationUnits,
      runId,
    });
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    mission = bound.body.mission;
    const recorded = await input.request(contribution.actor, "POST", `/api/plugins/${input.pluginId}/api/issues/${contribution.childIssueId}/council/commands`, {
      missionId,
      command: "record-contribution",
      commandId: randomUUID(),
      expectedVersion: mission.version,
      contributionId: contribution.contributionId,
      commit: contribution.commit,
    });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
    mission = recorded.body.mission;
    const done = await input.request("human", "PATCH", `/api/issues/${contribution.childIssueId}`, { status: "done" });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await settleReservation(reservationId);
  }

  const attachment = await uploadBundle({
    baseUrl: input.baseUrl,
    cookie: input.cookie,
    companyId,
    issueId: rootIssueId,
    bytes: candidate.bundleBytes,
    sha256: candidate.sha256,
  });
  const published = await input.request("n2-prerequisite-lead", "POST", `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/council/commands`, {
    missionId,
    command: "publish",
    commandId: randomUUID(),
    expectedVersion: mission.version,
    attachmentId: attachment.id,
    expectedSha256: candidate.sha256,
    baseCommit: candidate.baseCommit,
    candidateCommit: candidate.candidateCommit,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.mission.aggregate.phase, "ready_for_review");
  await settleReservation(rootReservationId);

  const finalMission = await input.request("human", "GET", `${missionPath}?companyId=${companyId}`);
  const finalAdmission = await input.request("human", "GET", `${admissionPath}?companyId=${companyId}&periodKey=${encodeURIComponent(periodKey)}`);
  assert.equal(finalMission.status, 200, JSON.stringify(finalMission.body));
  assert.equal(finalAdmission.status, 200, JSON.stringify(finalAdmission.body));
  assert.equal(finalMission.body.mission.aggregate.phase, "ready_for_review");
  assert.equal(finalMission.body.mission.aggregate.control.status, "inactive");
  assert.equal(finalMission.body.n2, null);
  assert.equal(finalMission.body.n1.participants.length, 2);
  assert.equal(new Set(finalMission.body.n1.participants.map((entry: any) => entry.assigneeAgentId)).size, 2);
  assert(finalMission.body.n1.participants.every((entry: any) => /^[0-9a-f]{40}$/.test(entry.commit)));
  assert.equal(finalMission.body.n1.candidate.outcome, "verified");
  assert.equal(finalMission.body.n1.candidate.publicationEligible, true);
  const reservations = finalAdmission.body.envelope.reservations as any[];
  assert.equal(reservations.length, 3);
  // Keep the complete per-reservation terminal invariant adjacent to the runtime readback.
  // fallow-ignore-next-line complexity
  assert(reservations.every((entry) => entry.status === "settled"
    && entry.usage?.status === "known" && entry.usage.units === 0
    && entry.remainingExposure?.status === "known" && entry.remainingExposure.units === 0));
  assert.equal(finalAdmission.body.envelope.exposure.status, "known");
  assert.equal(finalAdmission.body.envelope.exposure.units, 0);

  const fixtureRunByAgent = new Map(fixtureHeartbeatRuns.map((entry) => [entry.agentId, entry]));
  const runReadbacks = await Promise.all([lead, alpha, beta, reviewer].map(async (agent) => {
    const response = await input.request(
      "human",
      "GET",
      `/api/companies/${companyId}/heartbeat-runs?agentId=${encodeURIComponent(agent.id)}&limit=1000&summary=1`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const expected = fixtureRunByAgent.get(agent.id);
    if (!expected) {
      assert.deepEqual(response.body, []);
      return { agentId: agent.id, fixtureRunId: null, runCount: 0, runs: [] };
    }
    assert.equal(response.body.length, 1, JSON.stringify(response.body));
    const [run] = response.body;
    assert.equal(run.id, expected.runId);
    assert.equal(run.companyId, expected.companyId);
    assert.equal(run.agentId, expected.agentId);
    assert.equal(run.status, expected.status);
    assert.equal(run.invocationSource, "on_demand");
    assert.equal(run.triggerDetail, expected.fixtureSource);
    assert.equal(run.contextSnapshot?.issueId, expected.issueId);
    assert.equal(run.wakeupRequestId, null);
    assert.equal(run.processStartedAt, null);
    return {
      agentId: agent.id,
      fixtureRunId: expected.runId,
      runCount: 1,
      runs: [{
        id: run.id,
        companyId: run.companyId,
        agentId: run.agentId,
        status: run.status,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        issueId: run.contextSnapshot?.issueId,
        wakeupRequestId: run.wakeupRequestId,
        processStartedAt: run.processStartedAt,
      }],
    };
  }));

  return {
    companyId,
    issuePrefix: company.body.issuePrefix as string,
    projectId,
    missionId,
    rootIssueId,
    missionPath,
    admissionPath,
    periodKey,
    providerFreePrerequisite: true,
    runReservationUnits,
    periodAllowanceUnits,
    repository: candidate.repository,
    baseCommit: candidate.baseCommit,
    candidate: {
      attachmentId: attachment.id,
      sha256: candidate.sha256,
      candidateCommit: candidate.candidateCommit,
    },
    contributionIds,
    agents: { lead: lead.body, contributorA: alpha.body, contributorB: beta.body, reviewer: reviewer.body },
    mission: finalMission.body,
    admission: finalAdmission.body,
    fixtureHeartbeatRuns,
    runReadbacks,
    stopBoundary: "ready_for_review; N2 state absent; reviewer not started",
  };
}
