import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { executeN1BoardCommand } from "./n1-missions.js";
import { n2Cas, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import type { N3CandidateSubject } from "./n3-opinions.js";
import { assertN6AcceptedSource, assertN6Acyclic, assertN6Owner, guardOriginId, N6_GUARD_ORIGIN, readN6Guard, readN6Source } from "./n6-guards.js";
import type { N6Dependency } from "./n6-state.js";

const fresh = async (ctx: PluginContext, m: MissionRecord) => (await getMission(ctx, m.companyId, m.missionId))!;
const save = (ctx: PluginContext, m: MissionRecord, dep: N6Dependency) => n2Cas(ctx, m, { ...m.aggregate, n6: dep });

function subject(value: unknown): N3CandidateSubject {
  const v = value as N3CandidateSubject | null;
  if (!v || !/^[0-9a-f]{40}$/.test(v.candidateCommit) || !/^[0-9a-f]{64}$/.test(v.bundleSha256)
      || !/^[0-9a-f]{64}$/.test(v.mandateHash) || !Number.isSafeInteger(v.evidenceRevision) || v.evidenceRevision < 1) {
    throw new MissionError(422, "n6_invalid_subject", "Pin exact submission, candidate, bundle, evidence revision and mandate");
  }
  return { submissionId: runtimeUuid(v.submissionId, "submissionId"), candidateCommit: v.candidateCommit,
    bundleSha256: v.bundleSha256, evidenceRevision: v.evidenceRevision, mandateHash: v.mandateHash };
}

async function idleRoot(ctx: PluginContext, m: MissionRecord) {
  const root = await ctx.issues.get(m.rootIssueId, m.companyId);
  if (!root || root.companyId !== m.companyId || root.projectId !== m.projectId
      || root.assigneeAgentId !== m.aggregate.responsibilities.integrationLeadAgentId
      || !["backlog", "blocked"].includes(root.status) || root.checkoutRunId || root.executionRunId) {
    throw new MissionError(409, "n6_target_ineligible", "Dependency requires an idle backlog/blocked downstream root");
  }
  return root;
}

function admissionAuthority(body: Record<string, unknown>) {
  if (typeof body.periodKey !== "string" || !body.periodKey.trim() || body.periodKey.length > 120
      || !Number.isSafeInteger(body.requestedUnits) || Number(body.requestedUnits) < 1) {
    throw new MissionError(422, "n6_admission_authority", "Explicit bounded admission period and requested units required");
  }
  return { periodKey: body.periodKey, requestedUnits: Number(body.requestedUnits) };
}

async function configure(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  if (m.aggregate.n6 || m.aggregate.n1 || m.aggregate.phase !== "draft") throw new MissionError(409, "n6_dependency_frozen", "One predecessor may be authorized only before activation");
  const source = await getMission(ctx, m.companyId, runtimeUuid(body.sourceMissionId, "sourceMissionId"));
  if (!source) throw new MissionError(404, "n6_source_missing", "Source mission not found");
  await readN6Source(ctx, m, { sourceMissionId: source.missionId, sourceRootIssueId: source.rootIssueId });
  await assertN6Acyclic(ctx, m, source);
  await idleRoot(ctx, m);
  const admission = admissionAuthority(body);
  const dep: N6Dependency = { protocol: "accepted-result-v1", sourceMissionId: source.missionId, sourceRootIssueId: source.rootIssueId,
    expectedResult: subject(body.expectedResult), authorizedBy: actorId, authorizedAt: new Date().toISOString(),
    intentId: randomUUID(), guardIssueId: null, guardCreation: "claimed", relationConfirmed: false,
    ...admission, reservationId: randomUUID(), activationCommandId: randomUUID(), startCommandId: randomUUID() };
  const claim = await n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n6: dep,
    journal: [...m.aggregate.journal, { action: "result_dependency_authorized", sourceMissionId: source.missionId,
      expectedResult: dep.expectedResult, authorizedBy: actorId, at: dep.authorizedAt }] });
  if (claim.outcome !== "applied") return claim;
  m = claim.mission;
  // Only this successful CAS may create the native gate. Recovery reads correlation, never recreates it.
  try {
    await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, title: `Accepted result gate: ${source.missionId}`,
      description: JSON.stringify({ targetMissionId: m.missionId, sourceMissionId: source.missionId, expectedResult: dep.expectedResult,
        reason: "Source done is insufficient: exact acceptance and settled usage are required", nextActor: actorId }),
      status: "backlog", originKind: N6_GUARD_ORIGIN, originId: guardOriginId(m), actor: { actorUserId: actorId } });
  } catch { /* Ambiguous creation is retained; exact correlation readback is the only recovery. */ }
  return { outcome: "configured", mission: await reconcileN6(ctx, m) };
}

async function attachGate(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let dep = m.aggregate.n6!;
  if (!dep.guardIssueId) {
    const matches = await ctx.issues.list({ companyId: m.companyId, originKind: N6_GUARD_ORIGIN, originId: guardOriginId(m), limit: 2 });
    if (matches.length !== 1) throw new MissionError(409, "n6_guard_effect_unknown", "Gate creation is unresolved; do not create another gate");
    m = await save(ctx, m, { ...dep, guardIssueId: matches[0]!.id }); dep = m.aggregate.n6!;
  }
  await readN6Guard(ctx, m);
  const relations = await ctx.issues.relations.get(m.rootIssueId, m.companyId);
  if (!relations.blockedBy.some(issue => issue.id === dep.guardIssueId)) {
    await ctx.issues.relations.addBlockers(m.rootIssueId, [dep.guardIssueId!], m.companyId, { actorUserId: dep.authorizedBy });
  }
  const confirmed = await ctx.issues.relations.get(m.rootIssueId, m.companyId);
  if (!confirmed.blockedBy.some(issue => issue.id === dep.guardIssueId)) throw new MissionError(409, "n6_relation_unknown", "Native dependency relation must be observed");
  if (!dep.relationConfirmed) {
    const root = await idleRoot(ctx, m);
    const route = `/api/plugins/private.paperclip-council/api/issues/${m.rootIssueId}/council/commands`;
    const inspect = JSON.stringify({ command: "inspect", missionId: m.missionId });
    const description = `${root.description ?? ""}\n\nCouncil downstream mission ${m.missionId}. Result dependency: source mission ${dep.sourceMissionId}, root ${dep.sourceRootIssueId}.\nExpected accepted result: ${JSON.stringify(dep.expectedResult)}.\nWait for the native result gate; issue done alone is insufficient. After admitted dispatch, POST $PAPERCLIP_API_URL${route} with JSON ${inspect}, Authorization: Bearer $PAPERCLIP_API_KEY and X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID. Consume this exact source result; do not substitute main or a PR branch. Owner ${dep.authorizedBy} authorized the bounded N1 launch.\n`;
    await ctx.issues.update(m.rootIssueId, { status: "blocked", description }, m.companyId, { actorUserId: dep.authorizedBy });
    m = await save(ctx, m, { ...dep, guardCreation: "confirmed", relationConfirmed: true });
  }
  return m;
}

async function dispatchReady(ctx: PluginContext, initial: MissionRecord) {
  let m = initial; let dep = m.aggregate.n6!;
  if (!dep.activationBody) {
    const activationBody = { command: "activate", companyId: m.companyId, commandId: dep.activationCommandId,
      expectedVersion: m.version + 1, periodKey: dep.periodKey, reservationId: dep.reservationId, requestedUnits: dep.requestedUnits };
    m = await save(ctx, m, { ...dep, activationBody }); dep = m.aggregate.n6!;
  }
  await executeN1BoardCommand(ctx, { companyId: m.companyId, missionId: m.missionId, actorUserId: dep.authorizedBy, body: dep.activationBody! });
  m = await fresh(ctx, m); dep = m.aggregate.n6!;
  if (!dep.startBody) {
    const startBody = { command: "start-lead", companyId: m.companyId, commandId: dep.startCommandId, expectedVersion: m.version + 1 };
    m = await save(ctx, m, { ...dep, startBody }); dep = m.aggregate.n6!;
  }
  await executeN1BoardCommand(ctx, { companyId: m.companyId, missionId: m.missionId, actorUserId: dep.authorizedBy, body: dep.startBody! });
  return fresh(ctx, m);
}

/** Native gate completion uses SDK service mutation, then N1 owns the only admitted wake. */
export async function reconcileN6(ctx: PluginContext, initial: MissionRecord): Promise<MissionRecord> {
  let m = await fresh(ctx, initial);
  if (!m.aggregate.n6 || m.aggregate.n1?.rootDispatchState) return m;
  await assertN6Owner(ctx, m, m.aggregate.n6.authorizedBy);
  m = await attachGate(ctx, m);
  try { await assertN6AcceptedSource(ctx, m); }
  catch (error) {
    if (!(error instanceof MissionError)) throw error;
    return m.aggregate.n6!.blockage === error.code ? m : save(ctx, m, { ...m.aggregate.n6!, blockage: error.code });
  }
  if (!m.aggregate.n6!.verifiedAt) {
    const at = new Date().toISOString();
    m = await n2Cas(ctx, m, { ...m.aggregate, n6: { ...m.aggregate.n6!, verifiedAt: at, blockage: undefined },
      journal: [...m.aggregate.journal, { action: "result_dependency_verified", actorType: "automation", authorizedBy: m.aggregate.n6!.authorizedBy,
        sourceMissionId: m.aggregate.n6!.sourceMissionId, expectedResult: m.aggregate.n6!.expectedResult, at }] });
  }
  const guard = await readN6Guard(ctx, m);
  if (guard.status !== "done") await ctx.issues.update(guard.id, { status: "done" }, m.companyId, { actorUserId: m.aggregate.n6!.authorizedBy });
  return dispatchReady(ctx, m);
}

export async function handleN6Board(ctx: PluginContext, input: PluginApiRequestInput) {
  try {
    const body = input.body as Record<string, unknown>;
    const m = await getMission(ctx, input.companyId, runtimeUuid(input.params.missionId, "missionId"));
    if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
    const actorId = input.actor.actorType === "user" ? input.actor.userId ?? null : null;
    await assertN6Owner(ctx, m, actorId);
    if (body.command === "reconcile-result-dependency") return { status: 200, body: { outcome: "reconciled", mission: await reconcileN6(ctx, m) } };
    const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), actorId!, canonicalPayloadHash(body));
    if (prior) return { status: 200, body: { outcome: "replayed", mission: m, receipt: prior } };
    return { status: 200, body: await configure(ctx, m, body, actorId!) };
  } catch (error) {
    if (error instanceof MissionError || error instanceof AdmissionError) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}
