// Repository arbitration is exercised with real SQL in repository-occupation tests.
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: vi.fn(async () => {}), releaseReconciledRepository: vi.fn(async () => {}) }));
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { PluginContext, PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, type MissionRecord, type MissionReceipt } from "../src/missions.js";
import { MODEL_CATALOGUE } from "../src/model-catalogue.js";
import { modelLaunch, type ModelLaunch } from "../src/model-state.js";
import { bindVariantIssue, claimVariantWake, observeVariantRun, prepareVariantLaunch, recordVariantWake } from "../src/model-runtime.js";
import { n2Cas, n2CommandCas, nativeN2Profile, reserveN2Run } from "../src/n2-missions.js";
import { readAdmission, reserveAdmission } from "../src/admission.js";
import { readOrdinaryRun, settleOrdinaryRunUsage } from "../src/g4-native.js";
import { createContributionIssueEffect, reconcileContributionIssueEffect } from "../src/contribution-effects.js";
import { acceptedN5Submission } from "../src/n5-preflight.js";
import { handleN5Agent, handleN5Board, reconcileN5, startN5Publication } from "../src/n5-runtime.js";
import { requestN5Correction, rebindN5Plan } from "../src/n5-continuation.js";
import { executeOrdinaryN2Agent } from "../src/n2-ordinary-agent.js";
import { readN5Plan } from "../src/n5-native.js";
import { coordinationTask } from "../src/n6-coordination-state.js";
import { reconcileCoordination } from "../src/n6-work-runtime.js";
import { handleN6WorkAgent } from "../src/n6-work-api.js";

vi.mock("../src/model-runtime.js", () => ({ prepareVariantLaunch: vi.fn(), bindVariantIssue: vi.fn(), claimVariantWake: vi.fn(), recordVariantWake: vi.fn(), observeVariantRun: vi.fn() }));
vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: vi.fn() }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2Cas: vi.fn(), n2CommandCas: vi.fn(), nativeN2Profile: vi.fn(), reserveN2Run: vi.fn() }));
vi.mock("../src/admission.js", async original => ({ ...await original(), readAdmission: vi.fn(), reserveAdmission: vi.fn() }));
vi.mock("../src/g4-native.js", async original => ({ ...await original(), readOrdinaryRun: vi.fn(), settleOrdinaryRunUsage: vi.fn() }));
vi.mock("../src/n5-native.js", () => ({ assertCurrentN5Plan: vi.fn(), readN5Plan: vi.fn(), observeN5Native: vi.fn() }));
vi.mock("../src/n5-preflight.js", () => ({ acceptedN5Submission: vi.fn() }));
vi.mock("../src/contribution-effects.js", async original => ({ ...await original(), createContributionIssueEffect: vi.fn(), reconcileContributionIssueEffect: vi.fn() }));

let current: MissionRecord;
let physical: string;
function persist(m: MissionRecord, aggregate: MissionRecord["aggregate"]) {
  current = { ...m, version: m.version + 1, aggregate };
  return current;
}
function changeLaunch(m: MissionRecord, key: string, patch: Partial<ModelLaunch>) {
  const state = m.aggregate.modelSelection!;
  return persist(m, { ...m.aggregate, modelSelection: { ...state, tasks: state.tasks.map(task => ({ ...task,
    launches: task.launches.map(launch => launch.launchKey === key ? { ...launch, ...patch } : launch) })) } });
}
function binding(input: Parameters<typeof prepareVariantLaunch>[2]): ModelLaunch {
  return { ...input, issueId: input.issueId ?? null, agentId: physical, roleKey: "role", profileId: "sol-medium", requestedProfileId: "sol-medium",
    mappingRevision: "1", variantRevision: "1", selectedAt: new Date().toISOString(), state: "selected", runId: null,
    rationale: "Test selected variant", authority: "default", ascent: false };
}
function request(issueId: string, agentId: string, runId: string, command: string): PluginApiRequestInput {
  return { routeKey: "mission-agent-command", method: "POST", path: `/issues/${issueId}/council/commands`, query: {}, headers: {},
    companyId: current.companyId, params: { issueId }, actor: { actorType: "agent", agentId, actorId: agentId, runId },
    body: { missionId: current.missionId, command } };
}
beforeEach(() => {
  vi.resetAllMocks(); physical = randomUUID();
  const lead = randomUUID(), reviewer = randomUUID(), publisher = randomUUID(), submissionId = randomUUID();
  current = { companyId: randomUUID(), projectId: randomUUID(), missionId: randomUUID(), rootIssueId: randomUUID(), ownerUserId: randomUUID(), version: 1,
    aggregate: { journal: [], commandReceipts: [], effectIntents: [], responsibilities: { integrationLeadAgentId: lead, finalReviewerAgentId: reviewer, requiredPerspectives: [] },
      modelSelection: { protocol: "native-variants-v1", choices: [], tasks: [] },
      n2: { ordinary: { protocol: "ordinary-cli-v1", tasks: [] }, correctionLimit: 1, correctionsUsed: 0,
        rounds: [{ round: 1 }], activeSubmissionId: submissionId, status: "accepted", application: { state: "observed" } },
      n5: { plan: { revisionId: randomUUID(), mandateHash: "mandate", plannerAgentId: lead, orchestratorAgentId: lead, integrationLeadAgentId: lead, qaAgentId: reviewer },
        authority: { publisherAgentId: publisher, repository: "owner/repo", baseRef: "main", headRef: "delivery" } } } } as unknown as MissionRecord;
  vi.mocked(getMission).mockImplementation(async () => current);
  vi.mocked(n2Cas).mockImplementation(async (_ctx, m, aggregate) => persist(m, aggregate));
  vi.mocked(n2CommandCas).mockImplementation(async (_ctx, m, body, actorType, actorId, aggregate) => {
    const receipt = { commandId: body.commandId, command: body.command, actorType, actorId, payloadHash: canonicalPayloadHash(body),
      appliedVersion: m.version + 1, result: { missionId: m.missionId, version: m.version + 1 }, recordedAt: "now" } as MissionReceipt;
    return { outcome: "applied", mission: persist(m, { ...aggregate, commandReceipts: [...m.aggregate.commandReceipts, receipt] }), receipt };
  });
  vi.mocked(prepareVariantLaunch).mockImplementation(async (_ctx, m, input) => {
    if (!m.aggregate.modelSelection) return { mission: m, binding: null };
    const prior = modelLaunch(m, input.launchKey); if (prior) return { mission: m, binding: prior };
    const launch = binding(input); const state = m.aggregate.modelSelection!;
    const task = state.tasks.find(item => item.taskKey === input.taskKey);
    const nextTask = task ? { ...task, launches: [...task.launches, launch] } : { taskKey: input.taskKey, variantRevision: "1", mapping: MODEL_CATALOGUE, launches: [launch] };
    return { mission: persist(m, { ...m.aggregate, modelSelection: { ...state, tasks: task ? state.tasks.map(item => item === task ? nextTask : item) : [...state.tasks, nextTask] } }), binding: launch };
  });
  vi.mocked(bindVariantIssue).mockImplementation(async (_ctx, m, key, issueId) => modelLaunch(m, key) ? changeLaunch(m, key, { issueId, state: "ready" }) : m);
  vi.mocked(claimVariantWake).mockImplementation(async (_ctx, m, key, persistWake) => {
    if (!modelLaunch(m, key)) return persistWake ? persistWake(m, m.aggregate) : m;
    expect(modelLaunch(m, key)?.state).toBe("ready");
    if (persistWake) {
      const state = m.aggregate.modelSelection!;
      return persistWake(m, { ...m.aggregate, modelSelection: { ...state, tasks: state.tasks.map(task => ({ ...task,
        launches: task.launches.map(launch => launch.launchKey === key ? { ...launch, state: "wake_claimed" as const } : launch) })) } });
    }
    return changeLaunch(m, key, { state: "wake_claimed" });
  });
  vi.mocked(recordVariantWake).mockImplementation(async (_ctx, m, key, runId, persistWake) => {
    const launch = modelLaunch(m, key);
    const effectiveRunId = launch?.state === "bound" && (runId === null || launch.runId === runId) ? launch.runId : runId;
    if (launch?.runId && effectiveRunId && launch.runId !== effectiveRunId) throw new Error("model_run_conflict");
    const aggregate = !launch || launch.state === "bound" && launch.runId === effectiveRunId ? m.aggregate : {
      ...m.aggregate,
      modelSelection: { ...m.aggregate.modelSelection!, tasks: m.aggregate.modelSelection!.tasks.map(task => ({ ...task,
        launches: task.launches.map(item => item.launchKey === key
          ? { ...item, runId: effectiveRunId, state: effectiveRunId ? "bound" as const : "unknown" as const } : item) })) },
    };
    return persistWake ? persistWake(m, aggregate, effectiveRunId) : persist(m, aggregate);
  });
  vi.mocked(observeVariantRun).mockImplementation(async (_ctx, m) => m);
  vi.mocked(nativeN2Profile).mockResolvedValue({ profile: { periodKey: "period" }, envelope: { version: 1, reservations: [] } } as never);
  vi.mocked(readAdmission).mockResolvedValue({ version: 1 } as never);
  vi.mocked(acceptedN5Submission).mockReturnValue({ submissionId, candidateCommit: "a".repeat(40), baseCommit: "b".repeat(40) } as never);
  vi.mocked(createContributionIssueEffect).mockImplementation(async (_ctx, intent) => ({ state: "confirmed", issue: { id: randomUUID(), assigneeAgentId: intent.assigneeAgentId } }) as never);
  vi.mocked(reconcileContributionIssueEffect).mockResolvedValue({ state: "absent" } as never);
  vi.mocked(readOrdinaryRun).mockImplementation(async (_ctx, identity) => ({ id: identity.runId, agentId: identity.agentId, status: "running", startedAt: "now", finishedAt: null }) as never);
});
function context() {
  const root = { status: "done", assigneeAgentId: current.aggregate.responsibilities.integrationLeadAgentId, description: "Root context" };
  const requestWakeup = vi.fn().mockImplementation(async (issueId: string) => {
    expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches).find(launch => launch.issueId === issueId)?.state).toBe("wake_claimed");
    return { queued: true, runId: randomUUID() };
  });
  return { agents: { get: vi.fn().mockResolvedValue({ companyId: current.companyId, adapterType: "codex_local", adapterConfig: { engine: "cli" }, status: "idle" }) },
    companies: { get: vi.fn().mockResolvedValue({ defaultResponsibleUserId: current.ownerUserId }) },
    issues: { create: vi.fn().mockResolvedValue({ id: randomUUID() }), update: vi.fn(async (_issueId: string, patch: Record<string, unknown>) => { Object.assign(root, patch); }), requestWakeup,
      get: vi.fn(async () => structuredClone(root)) } };
}
function correctionBody() {
  current.aggregate.n5!.publication = { state: "opened", settledAt: "now", observation: { state: "open" }, submission: { submissionId: current.aggregate.n2!.activeSubmissionId } } as never;
  return { command: "request-delivery-correction", commandId: randomUUID(), reservationId: randomUUID(), expectedVersion: current.version,
    reason: "Correct accepted issue", criteria: ["Fix exact defect"] };
}
function correctionRequest(body: Record<string, unknown>): PluginApiRequestInput {
  return { routeKey: "mission-command", method: "POST", path: "/mission", query: {}, headers: {}, companyId: current.companyId,
    params: { companyId: current.companyId, missionId: current.missionId },
    actor: { actorType: "user", actorId: current.ownerUserId, userId: current.ownerUserId }, body };
}
function coordination(kind: "coordinator" | "facilitator") {
  const agentId = randomUUID(); const task = coordinationTask(kind, agentId);
  current.aggregate.n6 = { coordination: { coordinatorAgentId: kind === "coordinator" ? agentId : randomUUID(), facilitatorAgentId: kind === "facilitator" ? agentId : randomUUID(),
    authorizedBy: current.ownerUserId, tasks: [task], periodKey: "period", requestedUnits: 100, allowedPriorities: ["medium"], participantAgentIds: [], state: "working" } } as never;
  return task;
}

it("launches and attributes a physical publisher while retaining its logical authority and reservation", async () => {
  const ctx = context(); const publisher = current.aggregate.n5!.authority.publisherAgentId;
  await reconcileN5(ctx as unknown as PluginContext, current);
  const p = current.aggregate.n5!.publication!;
  expect(createContributionIssueEffect).toHaveBeenCalledWith(ctx, expect.objectContaining({ assigneeAgentId: physical }));
  expect(prepareVariantLaunch).toHaveBeenCalledWith(ctx, expect.anything(), expect.objectContaining({ taskKey: "delivery", interventionKey: "publisher", launchKey: p.reservationId, logicalAgentId: publisher }));
  expect(current.aggregate.n5!.authority.publisherAgentId).toBe(publisher);
  expect(modelLaunch(current, p.reservationId)).toMatchObject({ agentId: physical, runId: p.runId, state: "bound" });
  expect((await handleN5Agent(ctx as unknown as PluginContext, request(p.issueId!, publisher, p.runId!, "n5-inspect"))).status).toBe(403);
  expect(await handleN5Agent(ctx as unknown as PluginContext, request(p.issueId!, physical, p.runId!, "n5-inspect"))).toMatchObject({
    status: 200, body: { missionId: current.missionId, rootIssueId: current.rootIssueId, version: current.version },
  });
  await reconcileN5(ctx as unknown as PluginContext, current);
  expect(settleOrdinaryRunUsage).toHaveBeenCalledWith(ctx, expect.objectContaining({ agentId: physical, reservationId: p.reservationId, runId: p.runId }));
  expect(observeVariantRun).toHaveBeenCalledWith(ctx, expect.anything(), p.reservationId);
});
it("requires fresh preflight before the one-shot publication claim and never grants another effect on replay", async () => {
  const ctx = context(); current.aggregate.n5!.authority.publisherPreflight = "publisher-run-report-v1";
  await reconcileN5(ctx as unknown as PluginContext, current);
  const p = current.aggregate.n5!.publication!;
  const input = request(p.issueId!, physical, p.runId!, "n5-claim-publication");
  input.body = { ...input.body as object, commandId: randomUUID(), expectedVersion: current.version };
  const refusal = await handleN5Agent(ctx as unknown as PluginContext, input);
  expect(refusal).toMatchObject({ status: 409, body: { code: "n5_publisher_preflight_required" } });
  expect(current.aggregate.n5!.publication!.claimedAt).toBeUndefined();
  expect(n2CommandCas).not.toHaveBeenCalled();
  input.body = { ...input.body as object, commandId: randomUUID(), expectedVersion: current.version,
    preflight: { protocol: "publisher-run-report-v1", provenance: "publisher_run_report", status: "pass",
      missionId: current.missionId, intentId: p.intentId, issueId: p.issueId, runId: p.runId,
      repository: "owner/repo", candidateCommit: p.submission.candidateCommit, baseCommit: p.submission.baseCommit,
      baseRef: "main", headRef: "delivery", remoteHead: null, observedAt: new Date().toISOString(),
      publicationWriteObserved: false, providerTurnsStartedByProbe: 0,
      checks: Object.fromEntries(["gitTool", "ghTool", "workspaceIdentity", "localCandidate", "originIdentity", "trackedFilesClean", "repositoryRead", "pushPermissionReported", "remoteBase", "remoteHeadLease"].map(key => [key, true])) } };
  expect(await handleN5Agent(ctx as unknown as PluginContext, input)).toMatchObject({ status: 200, body: { effectPermission: "execute" } });
  expect(current.aggregate.n5!.publication!.preflight).toMatchObject({ protocol: "publisher-run-report-v1", provenance: "publisher_run_report", runId: p.runId, agentId: physical });
  expect(await handleN5Agent(ctx as unknown as PluginContext, input)).toMatchObject({ status: 200, body: { effectPermission: "none" } });
  expect(n2CommandCas).toHaveBeenCalledTimes(1);
});

it("keeps an uncertain publisher wake and never selects or launches a replacement", async () => {
  const ctx = context(); ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("lost response"));
  await expect(startN5Publication(ctx as unknown as PluginContext, current)).rejects.toThrow("lost response");
  const p = current.aggregate.n5!.publication!;
  expect(modelLaunch(current, p.reservationId)?.state).toBe("unknown");
  await startN5Publication(ctx as unknown as PluginContext, current);
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(1); expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
});

it("preserves a historical publisher callback run when the original wake later returns null", async () => {
  delete current.aggregate.modelSelection;
  const ctx = context(); const callbackRun = randomUUID();
  ctx.issues.requestWakeup.mockImplementationOnce(async () => {
    current = { ...current, version: current.version + 1, aggregate: { ...current.aggregate, n5: { ...current.aggregate.n5!,
      publication: { ...current.aggregate.n5!.publication!, runId: callbackRun } } } };
    return { queued: true, runId: null };
  });

  await startN5Publication(ctx as unknown as PluginContext, current);

  expect(current.aggregate).not.toHaveProperty("modelSelection");
  expect(current.aggregate.n5!.publication!.runId).toBe(callbackRun);
});

it("reuses the durable publisher identity when selection is interrupted before it records a launch", async () => {
  const ctx = context(); vi.mocked(prepareVariantLaunch).mockRejectedValueOnce(new Error("selection interrupted"));
  await expect(startN5Publication(ctx as unknown as PluginContext, current)).rejects.toThrow("selection interrupted");
  const claimed = current.aggregate.n5!.publication!;
  expect(claimed).toMatchObject({ creation: "preparing", state: "pending", issueId: null });
  expect(modelLaunch(current, claimed.reservationId)).toBeUndefined();
  await reconcileN5(ctx as unknown as PluginContext, current);
  expect(prepareVariantLaunch).toHaveBeenNthCalledWith(1, ctx, expect.anything(), expect.objectContaining({ launchKey: claimed.reservationId }));
  expect(prepareVariantLaunch).toHaveBeenNthCalledWith(2, ctx, expect.anything(), expect.objectContaining({ launchKey: claimed.reservationId }));
  expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches)).toHaveLength(1);
  expect(createContributionIssueEffect).toHaveBeenCalledTimes(1);
});

it("reuses the selected publisher launch when the pre-create claim CAS fails", async () => {
  const ctx = context(); const ordinarySave = vi.mocked(n2Cas).getMockImplementation()!; let interrupted = false;
  vi.mocked(n2Cas).mockImplementation(async (...args) => {
    const publication = args[2].n5?.publication;
    if (!interrupted && publication?.creation === "claimed" && !publication.issueId) {
      interrupted = true; throw new Error("creation claim CAS failed");
    }
    return ordinarySave(...args);
  });
  await expect(startN5Publication(ctx as unknown as PluginContext, current)).rejects.toThrow("creation claim CAS failed");
  const claimed = current.aggregate.n5!.publication!;
  expect(claimed).toMatchObject({ creation: "preparing", state: "pending", issueId: null });
  expect(modelLaunch(current, claimed.reservationId)).toMatchObject({ state: "selected", launchKey: claimed.reservationId });
  await startN5Publication(ctx as unknown as PluginContext, current);
  expect(new Set(vi.mocked(prepareVariantLaunch).mock.calls.map(call => call[2].launchKey))).toEqual(new Set([claimed.reservationId]));
  expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches)).toHaveLength(1);
  expect(createContributionIssueEffect).toHaveBeenCalledTimes(1);
});

it("uses correlation readback only after publisher creation becomes unknown", async () => {
  const ctx = context(); vi.mocked(createContributionIssueEffect).mockResolvedValueOnce({ state: "unknown" } as never);
  await startN5Publication(ctx as unknown as PluginContext, current);
  const uncertain = current.aggregate.n5!.publication!;
  expect(uncertain).toMatchObject({ creation: "claimed", state: "pending", issueId: null });
  await startN5Publication(ctx as unknown as PluginContext, current);
  expect(reconcileContributionIssueEffect).toHaveBeenCalledTimes(1);
  expect(createContributionIssueEffect).toHaveBeenCalledTimes(1);
  expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches)).toHaveLength(1);
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it("keeps a historical claimed publisher creation readback-only", async () => {
  const ctx = context(); const reservationId = randomUUID();
  current.aggregate.n5!.publication = { intentId: randomUUID(), submission: acceptedN5Submission(current), issueId: null, runId: null,
    reservationId, settlementCommandId: randomUUID(), createdAt: new Date().toISOString(), creation: "claimed", wake: "pending", state: "pending" };
  await startN5Publication(ctx as unknown as PluginContext, current);
  expect(reconcileContributionIssueEffect).toHaveBeenCalledTimes(1);
  expect(prepareVariantLaunch).not.toHaveBeenCalled();
  expect(createContributionIssueEffect).not.toHaveBeenCalled();
  expect(modelLaunch(current, reservationId)).toBeUndefined();
});

it("resumes the same publisher launch after a pre-wake claim interruption and rejects a premature callback", async () => {
  const ctx = context(); vi.mocked(claimVariantWake).mockRejectedValueOnce(new Error("claim interrupted"));
  await expect(startN5Publication(ctx as unknown as PluginContext, current)).rejects.toThrow("claim interrupted");
  const p = current.aggregate.n5!.publication!;
  expect(p).toMatchObject({ creation: "confirmed", wake: "pending", runId: null });
  expect(modelLaunch(current, p.reservationId)?.state).toBe("ready");
  expect((await handleN5Agent(ctx as unknown as PluginContext, request(p.issueId!, physical, randomUUID(), "n5-inspect"))).status).toBe(403);
  expect(recordVariantWake).not.toHaveBeenCalled();
  await startN5Publication(ctx as unknown as PluginContext, current);
  expect(modelLaunch(current, p.reservationId)).toMatchObject({ state: "bound", launchKey: p.reservationId });
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(1); expect(createContributionIssueEffect).toHaveBeenCalledTimes(1);
  expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  expect(vi.mocked(reserveN2Run).mock.calls.every(call => call[2].reservationId === p.reservationId)).toBe(true);
});

it("persists the publisher and model wake claims in one CAS after the departure checks", async () => {
  const ctx = context(); const ordinarySave = vi.mocked(n2Cas).getMockImplementation()!;
  vi.mocked(n2Cas).mockImplementation(async (...args) => {
    const publication = args[2].n5?.publication;
    if (publication?.wake === "claimed") {
      expect(modelLaunch({ ...args[1], aggregate: args[2] }, publication.reservationId)?.state).toBe("wake_claimed");
      throw new Error("combined wake CAS failed");
    }
    return ordinarySave(...args);
  });
  await expect(startN5Publication(ctx as unknown as PluginContext, current)).rejects.toThrow("combined wake CAS failed");
  const p = current.aggregate.n5!.publication!;
  expect(p).toMatchObject({ wake: "pending", runId: null });
  expect(modelLaunch(current, p.reservationId)?.state).toBe("ready");
  expect(ctx.issues.update).not.toHaveBeenCalled();
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  vi.mocked(n2Cas).mockImplementation(ordinarySave);
  await reconcileN5(ctx as unknown as PluginContext, current);
  expect(current.aggregate.n5!.publication!.intentId).toBe(p.intentId);
  expect(modelLaunch(current, p.reservationId)?.state).toBe("bound");
  expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
});

it.each(["coordinator", "facilitator"] as const)("binds physical %s commands and keeps the shared logical coordination task", async kind => {
  const task = coordination(kind); const ctx = context(); const logical = task.agentId;
  await reconcileCoordination(ctx as unknown as PluginContext, current);
  const actual = current.aggregate.n6!.coordination!.tasks[0]!;
  expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: physical }));
  expect(prepareVariantLaunch).toHaveBeenCalledWith(ctx, expect.anything(), expect.objectContaining({ taskKey: "coordination", interventionKey: kind,
    logicalAgentId: logical, family: "orchestration", expectedRoles: [kind], launchKey: task.reservationId }));
  expect(actual.agentId).toBe(logical);
  expect((await handleN6WorkAgent(ctx as unknown as PluginContext, request(actual.issueId!, logical, actual.runId!, "n6-inspect"))).status).toBe(403);
  expect((await handleN6WorkAgent(ctx as unknown as PluginContext, request(actual.issueId!, physical, actual.runId!, "n6-inspect"))).status).toBe(200);
  expect(readOrdinaryRun).toHaveBeenCalledWith(ctx, expect.objectContaining({ agentId: physical, runId: actual.runId }));
});

it("retains the N6 admission and variant when a wake response is lost", async () => {
  const task = coordination("coordinator"); const ctx = context(); ctx.issues.requestWakeup.mockRejectedValueOnce(new Error("lost response"));
  await expect(reconcileCoordination(ctx as unknown as PluginContext, current)).rejects.toThrow("lost response");
  expect(modelLaunch(current, task.reservationId)?.state).toBe("unknown");
  await reconcileCoordination(ctx as unknown as PluginContext, current);
  expect(reserveAdmission).toHaveBeenCalledTimes(1); expect(ctx.issues.create).toHaveBeenCalledTimes(1); expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
});

it("resumes the same N6 launch after a pre-wake claim interruption and rejects a premature callback", async () => {
  const task = coordination("coordinator"); const ctx = context();
  vi.mocked(claimVariantWake).mockRejectedValueOnce(new Error("claim interrupted"));
  await expect(reconcileCoordination(ctx as unknown as PluginContext, current)).rejects.toThrow("claim interrupted");
  const interrupted = current.aggregate.n6!.coordination!.tasks[0]!;
  expect(interrupted).toMatchObject({ taskId: task.taskId, creation: "confirmed", wake: "claimed", runId: null });
  expect(modelLaunch(current, task.reservationId)?.state).toBe("ready");
  expect((await handleN6WorkAgent(ctx as unknown as PluginContext,
    request(interrupted.issueId!, physical, randomUUID(), "n6-inspect"))).status).toBe(403);
  expect(recordVariantWake).not.toHaveBeenCalled();
  await reconcileCoordination(ctx as unknown as PluginContext, current);
  expect(modelLaunch(current, task.reservationId)).toMatchObject({ state: "bound", launchKey: task.reservationId });
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(2); expect(ctx.issues.create).toHaveBeenCalledTimes(1);
  expect(ctx.issues.requestWakeup).toHaveBeenCalledTimes(1);
  expect(vi.mocked(reserveAdmission).mock.calls.every(call => call[1].reservationId === task.reservationId)).toBe(true);
});

it("prepares the resumed root variant before the one-shot owner handoff and exposes no native action on replay", async () => {
  const ctx = context(); const lead = current.aggregate.responsibilities.integrationLeadAgentId;
  current.aggregate.n5!.publication = { state: "opened", settledAt: "now", observation: { state: "open" }, submission: { submissionId: current.aggregate.n2!.activeSubmissionId } } as never;
  const body = { command: "request-delivery-correction", commandId: randomUUID(), reservationId: randomUUID(), expectedVersion: current.version, reason: "Correct accepted issue", criteria: ["Fix exact defect"] };
  const result = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(result).toMatchObject({ nativeAction: { body: { resume: true } } });
  expect(modelLaunch(current, body.reservationId)).toMatchObject({ taskKey: current.rootIssueId, interventionKey: "lead", agentId: physical, logicalAgentId: lead, state: "wake_claimed" });
  expect(current.aggregate.n2!.correctionsUsed).toBe(1); expect(current.aggregate.n2!.correction!.executorAgentId).toBe(lead);
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled(); expect(reserveN2Run).toHaveBeenCalledTimes(1);
  const replay = await handleN5Board(ctx as unknown as PluginContext, { routeKey: "mission-command", method: "POST", path: "/mission", query: {}, headers: {},
    companyId: current.companyId, params: { companyId: current.companyId, missionId: current.missionId },
    actor: { actorType: "user", actorId: current.ownerUserId, userId: current.ownerUserId }, body });
  expect(replay.body).toMatchObject({ outcome: "replayed", effectPermission: "none" });
  expect(replay.body).not.toHaveProperty("nativeAction"); expect(prepareVariantLaunch).toHaveBeenCalledTimes(1);
});

it("preserves profile guidance and detailed history added by binding before appending correction instructions", async () => {
  const ctx = context(); const body = correctionBody();
  const history = `Council profile launch ${body.reservationId}\nRead the detailed history index at /documents/history-index and every indexed part`;
  vi.mocked(bindVariantIssue).mockImplementationOnce(async (_ctx, m, key, issueId) => {
    await ctx.issues.update(issueId, { description: `Root context\n\n${history}` });
    return changeLaunch(m, key, { issueId, state: "ready" });
  });
  await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  const root = await ctx.issues.get();
  expect(root.description).toContain(history);
  expect(root.description).toContain(`Post-publication correction ${body.commandId}: ${body.reason}`);
  expect(modelLaunch(current, body.reservationId)?.state).toBe("wake_claimed");
});

it("recovers the same admitted owner request after variant selection fails, without another reservation", async () => {
  const ctx = context(); const body = correctionBody(); const before = current;
  vi.mocked(prepareVariantLaunch).mockRejectedValueOnce(new Error("variant unavailable"));
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId)).rejects.toThrow("variant unavailable");
  expect(current.aggregate.effectIntents).toContainEqual({ kind: "n5_correction_resume", state: "preparing",
    requestId: body.commandId, reservationId: body.reservationId, actorId: current.ownerUserId });
  expect(before.aggregate.effectIntents).toEqual([]);
  expect(current.aggregate.n2!.correctionsUsed).toBe(1);
  const replay = await handleN5Board(ctx as unknown as PluginContext, correctionRequest(body));
  expect(replay).toMatchObject({ status: 200, body: { outcome: "replayed", effectPermission: "execute", nativeAction: { body: { resume: true } } } });
  expect(current.aggregate.n5!.continuation).toMatchObject({ requestId: body.commandId, reopen: { reservationId: body.reservationId } });
  expect(current.aggregate.n2!.ordinary!.tasks.filter(task => task.taskId === body.commandId)).toHaveLength(1);
  expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches)).toHaveLength(1);
  expect(n2CommandCas).toHaveBeenCalledTimes(1); expect(reserveN2Run).toHaveBeenCalledTimes(1);
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
  const repeated = await handleN5Board(ctx as unknown as PluginContext, correctionRequest(body));
  expect(repeated.body).toMatchObject({ effectPermission: "none" }); expect(repeated.body).not.toHaveProperty("nativeAction");
});

it.each(["selected", "assignment_claimed", "ready"] as const)("resumes proven pre-wake preparation from %s using its original launch", async state => {
  const ctx = context(); const body = correctionBody();
  vi.mocked(bindVariantIssue).mockImplementationOnce(async (_ctx, m, key) => {
    changeLaunch(m, key, { state }); throw new Error("preparation interrupted");
  });
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId)).rejects.toThrow("preparation interrupted");
  const result = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(result).toMatchObject({ outcome: "replayed", effectPermission: "execute", nativeAction: { body: { resume: true } } });
  expect(modelLaunch(current, body.reservationId)?.state).toBe("wake_claimed");
  expect(current.aggregate.modelSelection!.tasks.flatMap(task => task.launches)).toHaveLength(1);
  expect(reserveN2Run).toHaveBeenCalledTimes(1); expect(n2CommandCas).toHaveBeenCalledTimes(1);
});

it("rejects a correction callback before its durable wake claim and then resumes the same owner handoff", async () => {
  const ctx = context(); const body = correctionBody();
  vi.mocked(claimVariantWake).mockRejectedValueOnce(new Error("claim interrupted"));
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId)).rejects.toThrow("claim interrupted");
  expect(modelLaunch(current, body.reservationId)?.state).toBe("ready");
  await expect(executeOrdinaryN2Agent(ctx as unknown as PluginContext, current,
    request(current.rootIssueId, physical, randomUUID(), "ordinary-inspect"), { command: "ordinary-inspect" }))
    .rejects.toMatchObject({ code: "ordinary_actor_binding" });
  expect(recordVariantWake).not.toHaveBeenCalled();
  const recovered = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(recovered).toMatchObject({ outcome: "replayed", effectPermission: "execute", nativeAction: { body: { resume: true } } });
  expect(modelLaunch(current, body.reservationId)?.state).toBe("wake_claimed");
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(2); expect(reserveN2Run).toHaveBeenCalledTimes(1);
});

it.each(["wake_claimed", "unknown", "bound"] as const)("never reissues the owner handoff after a %s launch", async state => {
  const ctx = context(); const body = correctionBody();
  await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  changeLaunch(current, body.reservationId, { state, runId: state === "bound" ? randomUUID() : null });
  const result = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(result).toMatchObject({ outcome: "replayed", effectPermission: "none" }); expect(result).not.toHaveProperty("nativeAction");
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(1); expect(claimVariantWake).toHaveBeenCalledTimes(1);
  expect(reserveN2Run).toHaveBeenCalledTimes(1);
});

it("recovers a lost context-write response from readback without duplicating instructions or claiming another wake", async () => {
  const ctx = context(); const body = correctionBody(); const update = ctx.issues.update.getMockImplementation()!;
  ctx.issues.update.mockImplementationOnce(async (issueId, patch) => {
    await update(issueId, patch); throw new Error("context response lost");
  });
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId)).rejects.toThrow("context response lost");
  expect(modelLaunch(current, body.reservationId)?.state).toBe("ready");
  expect(claimVariantWake).not.toHaveBeenCalled();
  const recovered = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(recovered).toMatchObject({ effectPermission: "execute" });
  const root = await ctx.issues.get();
  expect(root.description.split(`Post-publication correction ${body.commandId}`).length - 1).toBe(1);
  expect(ctx.issues.update).toHaveBeenCalledTimes(1); expect(claimVariantWake).toHaveBeenCalledTimes(1);
  expect(reserveN2Run).toHaveBeenCalledTimes(1);
});

it("does not expose resume when correction instructions cannot be read back", async () => {
  const ctx = context(); const body = correctionBody(); ctx.issues.update.mockResolvedValueOnce(undefined);
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId))
    .rejects.toMatchObject({ code: "n5_correction_context_unknown" });
  expect(modelLaunch(current, body.reservationId)?.state).toBe("ready"); expect(claimVariantWake).not.toHaveBeenCalled();
  expect(ctx.issues.requestWakeup).not.toHaveBeenCalled();
});

it.each(["proof_missing", "run_observed", "root_resumed", "payload_changed"] as const)("blocks recovery when %s", async problem => {
  const ctx = context(); const body = correctionBody();
  vi.mocked(prepareVariantLaunch).mockRejectedValueOnce(new Error("variant unavailable"));
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId)).rejects.toThrow();
  if (problem === "proof_missing") current.aggregate.effectIntents = [];
  if (problem === "run_observed") current.aggregate.n2!.ordinary!.tasks[0]!.runId = randomUUID();
  if (problem === "root_resumed") await ctx.issues.update(current.rootIssueId, { status: "in_progress" });
  const replayBody = problem === "payload_changed" ? { ...body, reason: "Different correction" } : body;
  await expect(requestN5Correction(ctx as unknown as PluginContext, current, replayBody, current.ownerUserId)).rejects.toMatchObject({ code:
    problem === "payload_changed" ? "command_identity_conflict" : problem === "root_resumed" ? "n5_reopen_target" : "n5_correction_resume_unknown" });
  expect(prepareVariantLaunch).toHaveBeenCalledTimes(1); expect(claimVariantWake).not.toHaveBeenCalled();
  expect(reserveN2Run).toHaveBeenCalledTimes(1);
});

it("keeps historical corrections one-shot without requiring a variant binding", async () => {
  const ctx = context(); const body = correctionBody(); delete current.aggregate.modelSelection;
  const result = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(result).toMatchObject({ outcome: "applied", effectPermission: "execute", nativeAction: { body: { resume: true } } });
  const replay = await requestN5Correction(ctx as unknown as PluginContext, current, body, current.ownerUserId);
  expect(replay).toMatchObject({ outcome: "replayed", effectPermission: "none" }); expect(replay).not.toHaveProperty("nativeAction");
  expect(reserveN2Run).toHaveBeenCalledTimes(1); expect(current.aggregate.n2!.correctionsUsed).toBe(1);
});

it("rebinds plan evidence under the physical lead run without changing delegated logical roles", async () => {
  const ctx = context(); const lead = current.aggregate.responsibilities.integrationLeadAgentId, runId = randomUUID();
  const launch = binding({ taskKey: current.rootIssueId, interventionKey: "lead", launchKey: randomUUID(), logicalAgentId: lead, family: "diagnosis", issueId: current.rootIssueId, expectedRoles: ["lead"] });
  current.aggregate.modelSelection!.tasks = [{ taskKey: current.rootIssueId, variantRevision: "1", mapping: MODEL_CATALOGUE, launches: [{ ...launch, state: "bound", runId }] }];
  current.aggregate.n2!.correction = { runId } as never;
  const plan = current.aggregate.n5!.plan, body = { command: "n5-rebind-plan", commandId: randomUUID(), expectedVersion: current.version, planRevisionId: randomUUID(), reason: "Exact corrected evidence" };
  vi.mocked(readN5Plan).mockResolvedValue({ ...plan, revisionId: body.planRevisionId });
  await rebindN5Plan(ctx as unknown as PluginContext, current, request(current.rootIssueId, physical, runId, "n5-rebind-plan"), body);
  expect(readOrdinaryRun).toHaveBeenCalledWith(ctx, expect.objectContaining({ agentId: physical, runId }));
  expect(current.aggregate.n5!.plan.integrationLeadAgentId).toBe(lead);
  expect(current.aggregate.commandReceipts.at(-1)?.actorId).toBe(physical);
});
