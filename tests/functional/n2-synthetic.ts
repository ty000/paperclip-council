import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type ApiResult = { status: number; body: any; headers: Headers };
type ApiRequest = (actor: string, method: string, path: string, body?: unknown) => Promise<ApiResult>;

export type CandidateFixture = {
  baseCommit: string;
  contributionACommit: string;
  contributionBCommit: string;
  v1: { path: string; bytes: Buffer; sha256: string; candidateCommit: string };
  v2: { path: string; bytes: Buffer; sha256: string; candidateCommit: string };
};

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

export async function createCandidateFixture(runtime: string): Promise<CandidateFixture> {
  const repository = resolve(runtime, "n2-synthetic-candidate");
  await mkdir(repository, { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "n2-synthetic@example.test"]);
  git(repository, ["config", "user.name", "N2 Synthetic Executor"]);
  await writeFile(resolve(repository, "README.md"), "synthetic N2 candidate\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "base"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "base", baseCommit]);

  git(repository, ["switch", "-c", "contribution-a"]);
  await writeFile(resolve(repository, "alpha.txt"), "alpha v1\n");
  git(repository, ["add", "alpha.txt"]);
  git(repository, ["commit", "-m", "alpha contribution"]);
  const contributionACommit = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "main"]);
  git(repository, ["switch", "-c", "contribution-b"]);
  await writeFile(resolve(repository, "beta.txt"), "beta v1\n");
  git(repository, ["add", "beta.txt"]);
  git(repository, ["commit", "-m", "beta contribution"]);
  const contributionBCommit = git(repository, ["rev-parse", "HEAD"]);

  git(repository, ["switch", "-c", "candidate-v1"]);
  git(repository, ["merge", "--no-ff", "contribution-a", "-m", "integrate V1"]);
  const v1Commit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "candidate", v1Commit]);
  const v1Path = resolve(runtime, "n2-synthetic-v1.bundle");
  git(repository, ["bundle", "create", v1Path, "refs/heads/base", "refs/heads/candidate"]);
  const v1Bytes = await readFile(v1Path);

  git(repository, ["switch", "contribution-b"]);
  git(repository, ["switch", "-c", "candidate-v2"]);
  git(repository, ["merge", "--no-ff", "--no-commit", "contribution-a"]);
  await writeFile(resolve(repository, "alpha.txt"), "alpha v2 corrected\n");
  git(repository, ["add", "alpha.txt"]);
  git(repository, ["commit", "-m", "integrate corrected V2"]);
  const v2Commit = git(repository, ["rev-parse", "HEAD"]);
  git(repository, ["branch", "-f", "candidate", v2Commit]);
  const v2Path = resolve(runtime, "n2-synthetic-v2.bundle");
  git(repository, ["bundle", "create", v2Path, "refs/heads/base", "refs/heads/candidate"]);
  const v2Bytes = await readFile(v2Path);

  return {
    baseCommit,
    contributionACommit,
    contributionBCommit,
    v1: {
      path: v1Path,
      bytes: v1Bytes,
      sha256: createHash("sha256").update(v1Bytes).digest("hex"),
      candidateCommit: v1Commit,
    },
    v2: {
      path: v2Path,
      bytes: v2Bytes,
      sha256: createHash("sha256").update(v2Bytes).digest("hex"),
      candidateCommit: v2Commit,
    },
  };
}

async function uploadBundle(input: {
  baseUrl: string;
  cookie: string;
  companyId: string;
  issueId: string;
  candidate: CandidateFixture["v1"] | CandidateFixture["v2"];
  filename: string;
}) {
  const form = new FormData();
  form.append("file", new Blob([input.candidate.bytes], { type: "application/octet-stream" }), input.filename);
  const response = await fetch(`${input.baseUrl}/api/companies/${input.companyId}/issues/${input.issueId}/attachments`, {
    method: "POST",
    headers: { cookie: input.cookie, origin: input.baseUrl },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.sha256, input.candidate.sha256);
  return body;
}

async function inspectMission(request: ApiRequest, missionPath: string, companyId: string) {
  const response = await request("human", "GET", `${missionPath}?companyId=${companyId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function waitForN2Status(
  request: ApiRequest,
  missionPath: string,
  companyId: string,
  expected: "correction_requested" | "accepted",
) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const mission = await inspectMission(request, missionPath, companyId);
    if (mission.n2?.status === expected) return mission;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`synthetic N2 finished-event handler did not reach ${expected}`);
}

async function settleUsage(input: {
  request: ApiRequest;
  missionPath: string;
  admissionPath: string;
  companyId: string;
  periodKey: string;
  target: "review" | "correction";
  round?: 1 | 2;
}) {
  const mission = await inspectMission(input.request, input.missionPath, input.companyId);
  const admission = await input.request(
    "human",
    "GET",
    `${input.admissionPath}?companyId=${input.companyId}&periodKey=${encodeURIComponent(input.periodKey)}`,
  );
  assert.equal(admission.status, 200, JSON.stringify(admission.body));
  const response = await input.request("human", "POST", `${input.missionPath}/commands`, {
    companyId: input.companyId,
    command: "settle-n2-usage",
    commandId: randomUUID(),
    expectedVersion: mission.mission.version,
    target: input.target,
    ...(input.round ? { round: input.round } : {}),
    settlementCommandId: randomUUID(),
    expectedAdmissionVersion: admission.body.envelope.version,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

export async function runSyntheticN2(input: {
  request: ApiRequest;
  pluginId: string;
  baseUrl: string;
  cookie: string;
  runtime: string;
  companyId: string;
  projectId: string;
  ownerUserId: string;
  secretId: string;
  agents: { lead: string; contributorA: string; contributorB: string; reviewer: string };
  freshRun: (actor: string, issueId: string) => Promise<string>;
  bindActorRun: (actor: string, runId: string) => void;
  completeRun: (runId: string, issueId: string, agentId: string, usageUnits: number) => Promise<void>;
  seedMission: (missionId: string, aggregate: Record<string, unknown>) => Promise<void>;
  evidence: Record<string, any>;
}) {
  const candidate = await createCandidateFixture(input.runtime);
  const rosterBase = `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/rosters`;
  const team = await input.request("human", "POST", rosterBase, {
    companyId: input.companyId,
    command: "create",
    roster: {
      kind: "team",
      name: "Synthetic N2 team",
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
  const council = await input.request("human", "POST", rosterBase, {
    companyId: input.companyId,
    command: "create",
    roster: {
      kind: "council",
      name: "Synthetic N2 council",
      projectId: input.projectId,
      members: [{ agentId: input.agents.reviewer, responsibilities: ["final_reviewer"] }],
      integrationLeadAgentId: null,
      finalReviewerAgentId: input.agents.reviewer,
      requiredPerspectives: [],
    },
  });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  assert.equal(council.status, 201, JSON.stringify(council.body));
  const rosterPair = await input.request("human", "POST", rosterBase, {
    companyId: input.companyId,
    command: "activate-pair",
    teamRosterId: team.body.head.rosterId,
    teamExpectedVersion: team.body.head.version,
    councilRosterId: council.body.head.rosterId,
    councilExpectedVersion: council.body.head.version,
  });
  assert.equal(rosterPair.status, 200, JSON.stringify(rosterPair.body));
  const reviewPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [{
      id: randomUUID(),
      type: "review",
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId: input.agents.reviewer }],
    }],
  };
  const root = await input.request("human", "POST", `/api/companies/${input.companyId}/issues`, {
    title: "Synthetic N2 nominal integration",
    description: "Provider-free N1 fixture input followed by the real N2 integration path.",
    projectId: input.projectId,
    status: "in_progress",
    assigneeAgentId: input.agents.lead,
    executionPolicy: reviewPolicy,
  });
  assert.equal(root.status, 201, JSON.stringify(root.body));
  const rootIssueId = root.body.id as string;
  const contributionIds = [randomUUID(), randomUUID()] as const;
  const childIssues: any[] = [];
  for (const [index, details] of [
    { title: "Synthetic alpha contribution", assigneeAgentId: input.agents.contributorA },
    { title: "Synthetic beta contribution", assigneeAgentId: input.agents.contributorB },
  ].entries()) {
    const child = await input.request("human", "POST", `/api/companies/${input.companyId}/issues`, {
      ...details,
      description: "Initial N1 fixture evidence; no provider was invoked.",
      projectId: input.projectId,
      parentId: rootIssueId,
      status: "done",
    });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    childIssues[index] = child.body;
  }

  const v1Attachment = await uploadBundle({
    baseUrl: input.baseUrl,
    cookie: input.cookie,
    companyId: input.companyId,
    issueId: rootIssueId,
    candidate: candidate.v1,
    filename: "n2-synthetic-v1.bundle",
  });
  const v2Attachment = await uploadBundle({
    baseUrl: input.baseUrl,
    cookie: input.cookie,
    companyId: input.companyId,
    issueId: rootIssueId,
    candidate: candidate.v2,
    filename: "n2-synthetic-v2.bundle",
  });

  const missionId = randomUUID();
  const missionBase = `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/missions`;
  const created = await input.request("human", "POST", missionBase, {
    companyId: input.companyId,
    command: "create",
    commandId: randomUUID(),
    missionId,
    rootIssueId,
    projectId: input.projectId,
    teamRosterId: team.body.head.rosterId,
    teamRevision: rosterPair.body.team.revision.revision,
    councilRosterId: council.body.head.rosterId,
    councilRevision: rosterPair.body.council.revision.revision,
    mandate: {
      objective: "Validate one synthetic N2 correction and acceptance path",
      acceptanceCriteria: ["V2 changes alpha.txt and receives a fresh independent review"],
      commitments: ["No model or provider call"],
      limits: {
        taskPolicy: "three deterministic N2 runs",
        periodPolicy: "ephemeral provider-free qualification",
        correctionLimit: 1,
        elapsedMinutes: 30,
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const leadRunId = await input.freshRun("executor", rootIssueId);
  const checkout = await input.request("executor", "POST", `/api/issues/${rootIssueId}/checkout`, {
    agentId: input.agents.lead,
    expectedStatuses: ["in_progress"],
  });
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  const aggregate = created.body.mission.aggregate as Record<string, any>;
  await input.seedMission(missionId, {
    ...aggregate,
    phase: "integrating",
    control: { status: "active" },
    n1: {
      periodKey: `fixture-prepared-${missionId}`,
      activationReservationId: randomUUID(),
      activatedAt: new Date().toISOString(),
      rootDispatchState: "requested",
      rootDispatchRunId: leadRunId,
      rootDispatchMode: "fixture",
      contributions: [
        {
          contributionId: contributionIds[0], assigneeAgentId: input.agents.contributorA,
          title: "Synthetic alpha contribution", ownedPaths: ["alpha.txt"],
          issueState: "confirmed", childIssueId: childIssues[0].id,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: randomUUID(),
          commit: candidate.contributionACommit, authorRunId: randomUUID(),
        },
        {
          contributionId: contributionIds[1], assigneeAgentId: input.agents.contributorB,
          title: "Synthetic beta contribution", ownedPaths: ["beta.txt"],
          issueState: "confirmed", childIssueId: childIssues[1].id,
          dispatchState: "requested", dispatchReservationId: randomUUID(), dispatchRunId: randomUUID(),
          commit: candidate.contributionBCommit, authorRunId: randomUUID(),
        },
      ],
    },
    journal: [...aggregate.journal, {
      action: "synthetic_n1_fixture_prepared",
      boundary: "initial state only; no N2 state, decision, receipt, or transition was written",
      at: new Date().toISOString(),
    }],
  });
  const agentCommandPath = `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/council/commands`;
  const published = await input.request("executor", "POST", agentCommandPath, {
    missionId,
    command: "publish",
    commandId: randomUUID(),
    expectedVersion: created.body.mission.version,
    attachmentId: v1Attachment.id,
    expectedSha256: candidate.v1.sha256,
    baseCommit: candidate.baseCommit,
    candidateCommit: candidate.v1.candidateCommit,
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.mission.aggregate.phase, "ready_for_review");
  assert.equal(published.body.mission.aggregate.n1.candidate.outcome, "verified");
  await input.completeRun(leadRunId, rootIssueId, input.agents.lead, 0);

  const now = Date.now();
  const profile = {
    kind: "paperclip-orchestration-tokens-v1",
    periodKey: `n2-synthetic-${missionId}`,
    periodStart: new Date(now - 60_000).toISOString(),
    periodEnd: new Date(now + 60 * 60_000).toISOString(),
    periodAllowanceUnits: 100,
    runReservationUnits: 20,
    initialKnownUsageUnits: 0,
    initialExposureUnits: 0,
    initialTokenAccountingSource: `synthetic-harness:${missionId}`,
    maxCorrections: 1,
  };
  const configured = await input.request("human", "POST", `/api/plugins/${input.pluginId}/config`, {
    companyId: input.companyId,
    configJson: {
      apiBaseUrl: input.baseUrl,
      councilAgentId: input.agents.reviewer,
      councilApiKey: { type: "secret_ref", secretId: input.secretId },
      n1OperatingProfile: profile,
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const accountingSource = `plugin-config:n1OperatingProfile:initial-token-accounting:${profile.initialTokenAccountingSource}`;
  const admissionPath = `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/admission`;
  const admission = await input.request("human", "POST", admissionPath, {
    companyId: input.companyId,
    command: "configure",
    configuration: {
      commandId: randomUUID(),
      companyId: input.companyId,
      periodKey: profile.periodKey,
      periodStart: profile.periodStart,
      periodEnd: profile.periodEnd,
      measurement: {
        status: "known",
        source: "paperclip:issues.summaries.getOrchestration:terminal-token-ledger",
        unit: "tokens",
      },
      allowance: {
        status: "known", source: accountingSource,
        periodUnits: profile.periodAllowanceUnits, taskUnits: profile.runReservationUnits, knownUsageUnits: 0,
      },
      exposure: { status: "known", source: accountingSource, units: 0 },
      limits: { maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 },
    },
  });
  assert.equal(admission.status, 200, JSON.stringify(admission.body));

  const missionPath = `${missionBase}/${missionId}`;
  const beforeReview = await inspectMission(input.request, missionPath, input.companyId);
  const initialSubmissionId = randomUUID();
  const started = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId: input.companyId,
    command: "start-review",
    commandId: randomUUID(),
    expectedVersion: beforeReview.mission.version,
    submissionId: initialSubmissionId,
    reservationId: randomUUID(),
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.outcome, "prepared");
  assert.deepEqual(started.body.nativeTransition, {
    method: "PATCH", path: `/api/issues/${rootIssueId}`, body: { status: "in_review" },
  });

  const reviewerRun1 = await input.freshRun("council", rootIssueId);
  const refusedTransition = await input.request("council", "PATCH", `/api/issues/${rootIssueId}`, { status: "in_review" });
  assert.equal(refusedTransition.status, 409, JSON.stringify(refusedTransition.body));
  const transitioned1 = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, { status: "in_review" });
  assert.equal(transitioned1.status, 200, JSON.stringify(transitioned1.body));
  assert.equal(transitioned1.body.status, "in_review");
  assert.equal(transitioned1.body.assigneeAgentId, input.agents.reviewer);
  assert.equal(transitioned1.body.executionState?.currentParticipant?.agentId, input.agents.reviewer);
  assert.equal(transitioned1.body.executionState?.returnAssignee?.agentId, input.agents.lead);
  const refusedInspect = await input.request("executor", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(refusedInspect.status, 403, JSON.stringify(refusedInspect.body));
  const reviewerInspection1 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(reviewerInspection1.status, 200, JSON.stringify(reviewerInspection1.body));
  assert.equal(reviewerInspection1.body.n2.status, "review_handoff");
  assert.equal(reviewerInspection1.body.n2.submission.submissionId, initialSubmissionId);
  const confirmed1 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "confirm-review-handoff",
    commandId: randomUUID(),
    expectedVersion: reviewerInspection1.body.version,
  });
  assert.equal(confirmed1.status, 200, JSON.stringify(confirmed1.body));
  const reviewingInspection1 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(reviewingInspection1.status, 200, JSON.stringify(reviewingInspection1.body));
  assert.equal(reviewingInspection1.body.n2.status, "reviewing");
  assert.equal(reviewingInspection1.body.n2.review.handoff.reviewerRunId, reviewerRun1);
  const correctionOperationId = randomUUID();
  const correctionDecision = await input.request("council", "POST", `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/decision`, {
    operationId: correctionOperationId,
    verdict: "changes_requested",
    correctionReservationId: randomUUID(),
    justification: "alpha.txt must contain the corrected V2 marker.",
    resultReference: `council:n2:submission:${initialSubmissionId}`,
  });
  assert.equal(correctionDecision.status, 202, JSON.stringify(correctionDecision.body));
  assert.equal(correctionDecision.body.prepared, true);
  await input.completeRun(reviewerRun1, rootIssueId, input.agents.reviewer, 12);
  const appliedCorrection = await waitForN2Status(input.request, missionPath, input.companyId, "correction_requested");
  assert.equal(appliedCorrection.n2.review.verdict.verdict, "changes_requested");

  const leadRuntime = await input.request("human", "PATCH", `/api/agents/${input.agents.lead}`, {
    adapterConfig: { command: "/usr/bin/true" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } },
  });
  assert.equal(leadRuntime.status, 200, JSON.stringify(leadRuntime.body));
  let mission = await inspectMission(input.request, missionPath, input.companyId);
  const correctionStart = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId: input.companyId,
    command: "start-correction",
    commandId: randomUUID(),
    expectedVersion: mission.mission.version,
  });
  assert.equal(correctionStart.status, 200, JSON.stringify(correctionStart.body));
  assert.equal(correctionStart.body.outcome, "requested");
  const correctionRunId = correctionStart.body.mission.aggregate.n2.correction.runId as string;
  assert.match(correctionRunId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  input.bindActorRun("executor", correctionRunId);
  const correctionInspection = await input.request("executor", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(correctionInspection.status, 200, JSON.stringify(correctionInspection.body));
  assert.equal(correctionInspection.body.n2.status, "correcting");
  assert.equal(correctionInspection.body.n2.correction.runId, correctionRunId);
  const preparedV2 = await input.request("executor", "POST", agentCommandPath, {
    missionId,
    command: "prepare-resubmission",
    commandId: randomUUID(),
    expectedVersion: correctionInspection.body.version,
    submissionId: randomUUID(),
    attachmentId: v2Attachment.id,
    expectedSha256: candidate.v2.sha256,
    baseCommit: candidate.baseCommit,
    candidateCommit: candidate.v2.candidateCommit,
    correctedPaths: ["alpha.txt"],
  });
  assert.equal(preparedV2.status, 200, JSON.stringify(preparedV2.body));
  assert.equal(preparedV2.body.mission.aggregate.n2.status, "resubmission_prepared");
  const preparedInspection = await input.request("executor", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(preparedInspection.status, 200, JSON.stringify(preparedInspection.body));
  assert.equal(preparedInspection.body.n2.status, "resubmission_prepared");
  assert.equal(preparedInspection.body.n2.correction.runId, correctionRunId);
  await input.completeRun(correctionRunId, rootIssueId, input.agents.lead, 12);
  await settleUsage({
    request: input.request, missionPath, admissionPath, companyId: input.companyId,
    periodKey: profile.periodKey, target: "correction",
  });

  const product = await input.request("human", "POST", `/api/issues/${rootIssueId}/work-products`, {
    type: "commit", provider: "github", title: "Synthetic corrected V2",
    status: "ready_for_review",
    metadata: {
      repo: "ty000/paperclip-council", branch: "codex/council-n2-synthetic",
      sha: candidate.v2.candidateCommit, baseCommit: candidate.baseCommit,
    },
  });
  assert.equal(product.status, 201, JSON.stringify(product.body));
  const manifest = await input.request("human", "PUT", `/api/issues/${rootIssueId}/documents/delivery-manifest`, {
    title: "Synthetic delivery manifest",
    format: "markdown",
    body: JSON.stringify({
      repository: "https://github.com/ty000/paperclip-council.git",
      branch: "codex/council-n2-synthetic",
      baseCommit: candidate.baseCommit,
      approvedCommit: candidate.v2.candidateCommit,
      bundleAttachmentId: v2Attachment.id,
      bundleSha256: candidate.v2.sha256,
      deliveryWorkspacePath: "/home/davy-lp/workspace/paperclip-council",
      assigneeAgentId: input.agents.lead,
    }),
    changeSummary: "Prepare the exact provider-free V2 for final Council review",
  });
  assert.equal(manifest.status, 201, JSON.stringify(manifest.body));

  mission = await inspectMission(input.request, missionPath, input.companyId);
  const secondReview = await input.request("human", "POST", `${missionPath}/commands`, {
    companyId: input.companyId,
    command: "start-resubmitted-review",
    commandId: randomUUID(),
    expectedVersion: mission.mission.version,
    reservationId: randomUUID(),
  });
  assert.equal(secondReview.status, 200, JSON.stringify(secondReview.body));
  assert.equal(secondReview.body.outcome, "prepared");
  const reviewerRun2 = await input.freshRun("council", rootIssueId);
  const transitioned2 = await input.request("human", "PATCH", `/api/issues/${rootIssueId}`, { status: "in_review" });
  assert.equal(transitioned2.status, 200, JSON.stringify(transitioned2.body));
  assert.equal(transitioned2.body.assigneeAgentId, input.agents.reviewer);
  assert.equal(transitioned2.body.executionState?.currentParticipant?.agentId, input.agents.reviewer);
  assert.equal(transitioned2.body.executionState?.returnAssignee?.agentId, input.agents.lead);
  const reviewerInspection2 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(reviewerInspection2.status, 200, JSON.stringify(reviewerInspection2.body));
  assert.equal(reviewerInspection2.body.n2.status, "review_handoff");
  assert.equal(reviewerInspection2.body.n2.submission.ordinal, 2);
  const confirmed2 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "confirm-review-handoff",
    commandId: randomUUID(),
    expectedVersion: reviewerInspection2.body.version,
  });
  assert.equal(confirmed2.status, 200, JSON.stringify(confirmed2.body));
  const reviewingInspection2 = await input.request("council", "POST", agentCommandPath, {
    missionId,
    command: "inspect",
  });
  assert.equal(reviewingInspection2.status, 200, JSON.stringify(reviewingInspection2.body));
  assert.equal(reviewingInspection2.body.n2.status, "reviewing");
  assert.equal(reviewingInspection2.body.n2.review.handoff.reviewerRunId, reviewerRun2);
  const finalSubmissionId = reviewingInspection2.body.n2.submission.submissionId as string;
  const approvalOperationId = randomUUID();
  const approval = await input.request("council", "POST", `/api/plugins/${input.pluginId}/api/issues/${rootIssueId}/decision`, {
    operationId: approvalOperationId,
    verdict: "approved",
    approvedCommit: candidate.v2.candidateCommit,
    justification: "The corrected V2 marker is present and the candidate remains bounded.",
    resultReference: `council:n2:submission:${finalSubmissionId}`,
  });
  assert.equal(approval.status, 202, JSON.stringify(approval.body));
  assert.equal(approval.body.prepared, true);
  await input.completeRun(reviewerRun2, rootIssueId, input.agents.reviewer, 12);
  await waitForN2Status(input.request, missionPath, input.companyId, "accepted");

  const finalMission = await inspectMission(input.request, missionPath, input.companyId);
  assert.equal(finalMission.mission.aggregate.phase, "accepted");
  assert.equal(finalMission.n2.status, "accepted");
  assert.equal(finalMission.mission.aggregate.n2.correctionsUsed, 1);
  assert.equal(finalMission.n2.submissions.length, 2);
  assert.equal(finalMission.n2.usage.complete, true);
  assert.notEqual(finalMission.n2.submissions[0].candidateCommit, finalMission.n2.submissions[1].candidateCommit);
  assert.notEqual(finalMission.n2.submissions[0].sha256, finalMission.n2.submissions[1].sha256);
  const decisions = await input.request(
    "human", "GET", `/api/plugins/${input.pluginId}/api/companies/${input.companyId}/decisions?companyId=${input.companyId}`,
  );
  assert.equal(decisions.status, 200, JSON.stringify(decisions.body));
  const receiptByOperation = new Map(decisions.body.receipts
    .filter((entry: any) => entry.issueId === rootIssueId)
    .map((entry: any) => [entry.operationId, entry]));
  const n2Receipts = [
    receiptByOperation.get(correctionOperationId),
    receiptByOperation.get(approvalOperationId),
  ];
  assert(n2Receipts.every(Boolean), "both synthetic N2 decision receipts must persist");
  assert.deepEqual(n2Receipts.map((entry: any) => entry.verdict), ["changes_requested", "approved"]);
  assert(n2Receipts.every((entry: any) => entry.state === "native_observed"));

  input.evidence.results.n2SyntheticUuidAdmission = "PASS";
  input.evidence.results.n2SyntheticPreparedOperatorTransition = "PASS";
  input.evidence.results.n2SyntheticUnauthorizedIdentityRefused = "PASS";
  input.evidence.results.n2SyntheticChangedV2Verified = "PASS";
  input.evidence.results.n2SyntheticFreshReviewAccepted = "PASS";
  input.evidence.results.n2SyntheticUsageSettled = "PASS";
  input.evidence.syntheticN2 = {
    proofClass: "synthetic-provider-free-integration",
    companyId: input.companyId,
    missionId,
    rootIssueId,
    missionPath,
    operatorBoundary: {
      preparedExecutor: "authenticated human operator through PATCH /api/issues/:id",
      outsideHarnessAccess: "the mission command returns method, path, and body for a signed-in mission owner/operator to apply",
      automationStatus: "human-assisted; no autonomous executor consumes prepared in this mini-lot",
    },
    deterministicExecutors: {
      reviewer: "the harness drives authenticated Council commands under explicit ephemeral reviewer run identities",
      correction: "Paperclip requestWakeup creates a process-adapter run using /usr/bin/true; the harness drives the authenticated correction command under that exact run identity",
      usage: "terminal run rows, zero-cost token events, and the SDK finished-event delivery are explicitly synthetic provider-free fixtures; the shared plugin handler, admission, settlement, receipt, and public issue mutation paths are real",
    },
    regressions: {
      uuidEffectAccepted: true,
      publicTransitionActorsObserved: true,
      unauthorizedReviewerPatchStatus: refusedTransition.status,
      unauthorizedN2InspectStatus: refusedInspect.status,
      reviewerInspectBeforeAndAfterConfirmation: true,
      finishedEventDelivery: "synthetic SDK fixture; not native heartbeat delivery proof",
      correctionLeadInspectBeforeAndAfterPreparation: true,
      intendedHumanPatchStatus: transitioned1.status,
    },
    candidates: {
      v1: { attachmentId: v1Attachment.id, sha256: candidate.v1.sha256, commit: candidate.v1.candidateCommit },
      v2: { attachmentId: v2Attachment.id, sha256: candidate.v2.sha256, commit: candidate.v2.candidateCommit, correctedPaths: ["alpha.txt"] },
    },
    mission: finalMission,
    decisionReceipts: n2Receipts,
  };
  return { missionId, rootIssueId, missionPath, finalMission };
}
