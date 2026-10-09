import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createCandidateFixture } from "./n2-synthetic.js";

type ApiResult = { status: number; body: any; headers: Headers };
type ApiRequest = (actor: string, method: string, path: string, body?: unknown) => Promise<ApiResult>;
type FixtureRun = { actor: string; runId: string; companyId: string; agentId: string; issueId: string };

function attachmentForm(bytes: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "draft-candidate.bundle");
  return form;
}

export async function runDraftUploadProof(input: {
  request: ApiRequest;
  pluginId: string;
  runtime: string;
  companyId: string;
  projectId: string;
  ownerUserId: string;
  agents: { lead: string; contributorA: string; contributorB: string; reviewer: string };
  createFixtureRun: (actor: string, issueId: string, source: "fixture:draft-upload-proof:integrator") => Promise<string>;
  finishFixtureRuns: (runs: ReadonlyArray<FixtureRun>) => Promise<{
    terminalRuns: Array<{ id: string; status: string; finishedAt: unknown; wakeupRequestId: unknown; processStartedAt: unknown }>;
    issueLocks: Array<{ id: string; checkoutRunId: unknown; executionRunId: unknown }>;
    activeRunCount: number;
    openCheckoutCount: number;
    openExecutionCount: number;
  }>;
  seedMission: (missionId: string, aggregate: Record<string, unknown>) => Promise<void>;
}) {
  const candidate = await createCandidateFixture(input.runtime);
  const rosterPath = `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/rosters`;
  const team = await input.request("human", "POST", rosterPath, {
    companyId: input.companyId,
    command: "create",
    roster: {
      kind: "team",
      name: "Draft upload proof team",
      projectId: input.projectId,
      members: [
        { agentId: input.agents.lead, responsibilities: ["integration_lead"] },
        { agentId: input.agents.contributorA, responsibilities: ["contributor"] },
        { agentId: input.agents.contributorB, responsibilities: ["contributor"] },
      ],
      integrationLeadAgentId: input.agents.lead,
      finalReviewerAgentId: null,
      requiredPerspectives: [],
    },
  });
  const council = await input.request("human", "POST", rosterPath, {
    companyId: input.companyId,
    command: "create",
    roster: {
      kind: "council",
      name: "Draft upload proof council",
      projectId: input.projectId,
      members: [{ agentId: input.agents.reviewer, responsibilities: ["final_reviewer"] }],
      integrationLeadAgentId: null,
      finalReviewerAgentId: input.agents.reviewer,
      requiredPerspectives: [],
    },
  });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  assert.equal(council.status, 201, JSON.stringify(council.body));
  const pair = await input.request("human", "POST", rosterPath, {
    companyId: input.companyId,
    command: "activate-pair",
    teamRosterId: team.body.head.rosterId,
    teamExpectedVersion: team.body.head.version,
    councilRosterId: council.body.head.rosterId,
    councilExpectedVersion: council.body.head.version,
  });
  assert.equal(pair.status, 200, JSON.stringify(pair.body));

  const root = await input.request("human", "POST", `/api/companies/${input.companyId}/issues`, {
    title: "Draft publication product task",
    description: "Provider-free product subject for the admitted integration upload proof.",
    projectId: input.projectId,
    status: "in_progress",
    assigneeAgentId: input.agents.lead,
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));
  const integration = await input.request("human", "POST", `/api/companies/${input.companyId}/issues`, {
    title: "Draft publication integration task",
    description: "Exact admitted task for the integration candidate.",
    projectId: input.projectId,
    status: "in_progress",
    assigneeAgentId: input.agents.lead,
  });
  assert.equal(integration.status, 201, JSON.stringify(integration.body));

  const contributionIds = [randomUUID(), randomUUID()] as const;
  const childIssues: any[] = [];
  for (const details of [
    { title: "Draft proof alpha", assigneeAgentId: input.agents.contributorA },
    { title: "Draft proof beta", assigneeAgentId: input.agents.contributorB },
  ]) {
    const child = await input.request("human", "POST", `/api/companies/${input.companyId}/issues`, {
      ...details,
      description: "Closed provider-free contribution fixture.",
      projectId: input.projectId,
      parentId: root.body.id,
      status: "done",
    });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    childIssues.push(child.body);
  }

  const missionId = randomUUID();
  const missionPath = `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/missions/${missionId}`;
  const created = await input.request("human", "POST", `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/missions`, {
    companyId: input.companyId,
    command: "create",
    commandId: randomUUID(),
    missionId,
    rootIssueId: root.body.id,
    projectId: input.projectId,
    teamRosterId: team.body.head.rosterId,
    teamRevision: pair.body.team.revision.revision,
    councilRosterId: council.body.head.rosterId,
    councilRevision: pair.body.council.revision.revision,
    mandate: {
      objective: "Verify admitted integration upload and draft publication binding",
      acceptanceCriteria: ["The exact Git bundle is accepted only from the admitted integration task"],
      commitments: ["Provider-free fixture only", "Stop at ready_for_review"],
      limits: {
        taskPolicy: "one unexecuted integrator fixture run",
        periodPolicy: "ephemeral isolated qualification",
        correctionLimit: 1,
        elapsedMinutes: 10,
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const runId = await input.createFixtureRun("executor", integration.body.id, "fixture:draft-upload-proof:integrator");
  const checkout = await input.request("executor", "POST", `/api/issues/${integration.body.id}/checkout`, {
    agentId: input.agents.lead,
    expectedStatuses: ["in_progress"],
  });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));

  const now = new Date().toISOString();
  const proof = (attachmentId: string, commit: string, changedPath: string, segmentRootCommit: string) => ({
    protocol: "council-contribution-proof-v1",
    attachmentId,
    sha256: "f".repeat(64),
    byteSize: 1,
    segmentRootCommit,
    commit,
    changedPaths: [changedPath],
    checks: [{ name: "fixture-closed-contribution", status: "passed", detail: "Fixture closes only the prerequisite contribution state" }],
    verifiedAt: now,
    closedAt: now,
  });
  const aggregate = created.body.mission.aggregate as Record<string, any>;
  await input.seedMission(missionId, {
    ...aggregate,
    phase: "integrating",
    control: { status: "active" },
    projectMandate: {
      projectId: input.projectId,
      revisionId: randomUUID(),
      version: 1,
      authorizedBy: input.ownerUserId,
      operatingProfileHash: "fixture:draft-upload-proof",
      mandateHash: "fixture:draft-upload-proof",
      allowedPaths: ["alpha.txt", "beta.txt"],
      publication: {
        publisherAgentId: input.agents.reviewer,
        qaAgentId: input.agents.reviewer,
        repository: "fixture/council-draft-upload",
        baseRef: "main",
        headRefPrefix: "codex/draft-upload",
        contract: {
          protocol: "council-pr-contract-v1",
          draftOnly: true,
          result: "draft-pr",
          feedback: "review-and-correct",
          requiredChecks: ["fixture-ci"],
        },
      },
      completion: { protocol: "council-proof-close-v1", result: "draft-pr" },
      source: {
        rootIssueId: root.body.id,
        title: root.body.title,
        descriptionHash: "fixture:draft-upload-proof",
        taskDocumentRevisionId: null,
      },
    },
    n1: {
      periodKey: `fixture-draft-upload-${missionId}`,
      activationReservationId: randomUUID(),
      activatedAt: now,
      rootDispatchState: "requested",
      rootDispatchRunId: runId,
      rootDispatchMode: "fixture",
      sourceBaseCommit: candidate.baseCommit,
      integration: {
        taskId: randomUUID(),
        reservationId: randomUUID(),
        settlementCommandId: randomUUID(),
        issueId: integration.body.id,
        creation: "confirmed",
        wake: "claimed",
        runId,
      },
      contributions: [
        {
          contributionId: contributionIds[0],
          assigneeAgentId: input.agents.contributorA,
          title: "Draft proof alpha",
          ownedPaths: ["alpha.txt"],
          issueState: "confirmed",
          childIssueId: childIssues[0].id,
          dispatchState: "requested",
          dispatchReservationId: randomUUID(),
          dispatchRunId: randomUUID(),
          commit: candidate.contributionACommit,
          authorRunId: randomUUID(),
          proof: proof(randomUUID(), candidate.contributionACommit, "alpha.txt", candidate.baseCommit),
        },
        {
          contributionId: contributionIds[1],
          assigneeAgentId: input.agents.contributorB,
          title: "Draft proof beta",
          ownedPaths: ["beta.txt"],
          issueState: "confirmed",
          childIssueId: childIssues[1].id,
          dispatchState: "requested",
          dispatchReservationId: randomUUID(),
          dispatchRunId: randomUUID(),
          commit: candidate.contributionBCommit,
          authorRunId: randomUUID(),
          proof: proof(randomUUID(), candidate.contributionBCommit, "beta.txt", candidate.baseCommit),
        },
      ],
    },
    journal: [...aggregate.journal, {
      action: "draft_upload_fixture_prepared",
      boundary: "Prerequisite state only; no provider, wakeup, review, publisher or completion result was executed.",
      actorAgentId: input.agents.lead,
      runId,
      at: now,
    }],
  });

  const upload = async (issueId: string) => {
    const response = await input.request("executor", "POST", `/api/companies/${input.companyId}/issues/${issueId}/attachments`, attachmentForm(candidate.v1.bytes));
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.sha256, candidate.v1.sha256);
    assert.equal(response.body.issueId, issueId);
    return response.body;
  };
  const wrongAttachment = await upload(root.body.id);
  const commandPath = `/api/plugins/${input.pluginId}/api/issues/${integration.body.id}/council/commands`;
  const rejected = await input.request("executor", "POST", commandPath, {
    missionId,
    command: "publish",
    commandId: randomUUID(),
    expectedVersion: created.body.mission.version,
    attachmentId: wrongAttachment.id,
    expectedSha256: candidate.v1.sha256,
    baseCommit: candidate.baseCommit,
    candidateCommit: candidate.v1.candidateCommit,
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "integration_failed");
  assert(Number.isSafeInteger(rejected.body.details?.currentVersion));

  const correctAttachment = await upload(integration.body.id);
  assert.equal(correctAttachment.sha256, wrongAttachment.sha256);
  assert.equal(correctAttachment.byteSize, wrongAttachment.byteSize);
  const published = await input.request("executor", "POST", commandPath, {
    missionId,
    command: "publish",
    commandId: randomUUID(),
    expectedVersion: rejected.body.details.currentVersion,
    attachmentId: correctAttachment.id,
    expectedSha256: candidate.v1.sha256,
    baseCommit: candidate.baseCommit,
    candidateCommit: candidate.v1.candidateCommit,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.mission.aggregate.phase, "ready_for_review");
  assert.equal(published.body.mission.aggregate.control.status, "inactive");
  assert.equal(published.body.mission.aggregate.n1.candidate.outcome, "verified");
  assert.equal(published.body.mission.aggregate.n1.candidate.subject.issueId, root.body.id);
  assert.equal(published.body.mission.aggregate.n1.candidate.candidate.attachmentId, correctAttachment.id);
  assert.equal(published.body.mission.aggregate.n1.candidate.candidate.attachmentIssueId, integration.body.id);
  assert.equal(published.body.mission.aggregate.n1.candidate.candidate.baseCommit, candidate.baseCommit);
  assert.equal(published.body.mission.aggregate.n1.candidate.candidate.candidateCommit, candidate.v1.candidateCommit);
  assert.equal(published.body.mission.aggregate.n1.candidate.candidate.sha256, candidate.v1.sha256);

  const readback = await input.request("human", "GET", `${missionPath}?companyId=${input.companyId}`);
  assert.equal(readback.status, 200, JSON.stringify(readback.body));
  assert.equal(readback.body.mission.aggregate.phase, "ready_for_review");
  assert.equal(readback.body.mission.aggregate.n1.candidate.candidate.attachmentIssueId, integration.body.id);
  const lifecycle = await input.finishFixtureRuns([{
    actor: "executor",
    runId,
    companyId: input.companyId,
    agentId: input.agents.lead,
    issueId: integration.body.id,
  }]);
  assert.equal(lifecycle.activeRunCount, 0);
  assert.equal(lifecycle.openCheckoutCount, 0);
  assert.equal(lifecycle.openExecutionCount, 0);

  return {
    proofClass: "public-route authenticated integrator draft upload",
    missionId,
    rootIssueId: root.body.id,
    integrationIssueId: integration.body.id,
    integrator: { agentId: input.agents.lead, runId, authentication: "agent API key plus Paperclip-Agent-Run-Id" },
    candidate: {
      baseCommit: candidate.baseCommit,
      candidateCommit: candidate.v1.candidateCommit,
      sha256: candidate.v1.sha256,
      byteSize: candidate.v1.bytes.byteLength,
    },
    wrongAttachment: {
      id: wrongAttachment.id,
      issueId: root.body.id,
      sha256: wrongAttachment.sha256,
      publishStatus: rejected.status,
      publishCode: rejected.body.code,
    },
    admittedAttachment: {
      id: correctAttachment.id,
      issueId: integration.body.id,
      sha256: correctAttachment.sha256,
      publishStatus: published.status,
    },
    publicReadback: {
      phase: readback.body.mission.aggregate.phase,
      control: readback.body.mission.aggregate.control,
      productSubjectIssueId: readback.body.mission.aggregate.n1.candidate.subject.issueId,
      attachmentIssueId: readback.body.mission.aggregate.n1.candidate.candidate.attachmentIssueId,
    },
    fixtureLifecycle: {
      runCount: lifecycle.terminalRuns.length,
      terminalStatuses: lifecycle.terminalRuns.map((run) => run.status),
      activeRunCount: lifecycle.activeRunCount,
      openCheckoutCount: lifecycle.openCheckoutCount,
      openExecutionCount: lifecycle.openExecutionCount,
    },
    usage: {
      classification: "fixture",
      heartbeatRows: 1,
      providerInvocations: 0,
      modelRuns: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    },
    stopBoundary: "ready_for_review; no reviewer or publisher run",
  };
}
