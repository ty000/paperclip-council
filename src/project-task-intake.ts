import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, createMission, getMission, getMissionByRootIssue, MissionError, parseMissionMandate, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { executeN1BoardCommand, type N1State } from "./n1-missions.js";
import { configureContinuity } from "./continuity-configuration.js";
import { readNativeG4Profile } from "./g4-native.js";
import { handleN5Board } from "./n5-runtime.js";
import { operatingProfileHash } from "./project-mandate-state.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { prepareHierarchy } from "./hierarchy-intake.js";
import type { HierarchyState } from "./hierarchy-contract.js";
import { listProjectMandates, projectIssues, projectMandateRow, projectTable, type ProjectMandate, type ProjectMandateSnapshot } from "./project-mandate-state.js";
import { readProjectMandate } from "./project-mandate-state.js";
import { LINEAR_ORIGIN, type LinearPreparation } from "./linear-intake-contract.js";
import { readLinearIntake } from "./linear-intake-validation.js";
import { linearMissionObjective, prepareLinearTasks } from "./linear-intake-preparation.js";
import { assertLinearSource } from "./linear-intake-revalidation.js";
import { validateRosterPair } from "./rosters.js";

type IntakeState = { createBody?: Record<string, unknown>; snapshot?: ProjectMandateSnapshot;
  hierarchy?: HierarchyState;
  linearIntake?: LinearPreparation;
  commands: Record<string, Record<string, unknown>>; questions: Record<string, { message: string; confirmed: boolean }>;
  plan?: { key: string; body: string } };
type Intake = { companyId: string; rootIssueId: string; projectId: string; revisionId: string; missionId: string; version: number; state: IntakeState };
function fromRow(row: any): Intake {
  return { companyId: row.company_id, rootIssueId: row.root_issue_id, projectId: row.project_id, revisionId: row.policy_revision_id,
    missionId: row.mission_id, version: Number(row.version), state: typeof row.state === "string" ? JSON.parse(row.state) : row.state };
}
async function save(ctx: PluginContext, intake: Intake, state: IntakeState) {
  const result = await ctx.db.execute(`UPDATE ${projectTable(ctx, "project_task_intakes")} SET state = $1::jsonb, version = version + 1, updated_at = now()
    WHERE company_id = $2 AND root_issue_id = $3 AND version = $4`, [JSON.stringify(state), intake.companyId, intake.rootIssueId, intake.version]);
  if (result.rowCount !== 1) throw new MissionError(409, "project_intake_version", "Retain the original task intake; concurrent state changed");
  return { ...intake, state, version: intake.version + 1 };
}
async function command(ctx: PluginContext, intake: Intake, m: MissionRecord, key: string, details: Record<string, unknown>) {
  if (!intake.state.commands[key]) intake = await save(ctx, intake, { ...intake.state,
    commands: { ...intake.state.commands, [key]: { companyId: m.companyId, command: key, commandId: randomUUID(), expectedVersion: m.version, ...details } } });
  return { intake, body: intake.state.commands[key]! };
}

/** One native question per retained condition, even after a lost response. It never wakes a model or grants rights. */
async function question(ctx: PluginContext, initial: Intake, policy: ProjectMandate, error: unknown) {
  const code = error instanceof MissionError ? error.code : "project_intake_transport";
  let intake = initial; let pending = intake.state.questions[code];
  if (!pending) {
    pending = { message: error instanceof MissionError ? error.message.slice(0, 2000) : "Native readback is unavailable; inspect the retained intake before any continuation", confirmed: false };
    intake = await save(ctx, intake, { ...intake.state, questions: { ...intake.state.questions, [code]: pending } });
  }
  if (pending.confirmed) return;
  const interaction = await ctx.issues.askUserQuestions(intake.rootIssueId, { idempotencyKey: `council:intake:${intake.revisionId}:${intake.rootIssueId}:${code}`,
    addresseeUserId: policy.authorizedBy, continuationPolicy: "none", title: "Council — information ou décision requise",
    payload: { version: 1, title: "Compléter la tâche dans le mandat existant", questions: [{ id: "project-task", selectionMode: "single", required: true,
      prompt: `${pending.message}\nMandat de projet : ${policy.revisionId}. Corrigez la tâche ou sa politique puis indiquez la décision. Cette réponse ne donne aucun droit supplémentaire.`,
      options: [{ id: "decision", label: "Indiquer la précision ou la décision", freeText: true }] }] } }, intake.companyId);
  if (interaction.issueId !== intake.rootIssueId || interaction.addresseeUserId !== policy.authorizedBy) throw new MissionError(409, "project_question_binding", "Native question is not addressed to the pinned owner on this task");
  await save(ctx, intake, { ...intake.state, questions: { ...intake.state.questions, [code]: { ...pending, confirmed: true } } });
}

function requireManualRoot(root: Awaited<ReturnType<PluginContext["issues"]["get"]>>, policy: ProjectMandate) {
  if (!root || root.parentId || !["backlog", ...(policy.content.hierarchy?.adoptExistingChildren ? ["blocked"] : [])].includes(root.status) || root.originKind !== "manual" || root.assigneeAgentId !== policy.content.leadAgentId) {
    throw new MissionError(409, "project_task_eligibility", "Use a manual parentless task in Backlog assigned to the declared project lead");
  }
}
async function requireCurrentPolicy(ctx: PluginContext, policy: ProjectMandate) {
  const latest = await readProjectMandate(ctx, policy.companyId, policy.projectId);
  if (!latest?.content.enabled || latest.revisionId !== policy.revisionId || (await ctx.companies.get(policy.companyId))?.defaultResponsibleUserId !== policy.authorizedBy
      || operatingProfileHash(await ctx.config.get(policy.companyId)) !== policy.content.operatingProfileHash) {
    throw new MissionError(409, "project_authority_changed", "Preparation requires the original current owner and enabled mandate");
  }
}
function requireFreshLinearReceipt(receipt: LinearPreparation["preparationReceipt"]) {
  if (!receipt || Date.now() >= Date.parse(receipt.validUntil)) throw new MissionError(409, "linear_source_pending", "A fresh original-source observation is required before this effect");
}
async function requireLinearRoster(ctx: PluginContext, policy: ProjectMandate) {
  const pair = await validateRosterPair(ctx, policy.companyId, policy.content.teamRosterId, policy.content.councilRosterId);
  if (!pair.eligible || pair.team.head.publishedRevision !== policy.content.teamRevision || pair.council.head.publishedRevision !== policy.content.councilRevision) {
    throw new MissionError(409, "hierarchy_roster_drift", "Preparation requires the current pinned contributor and reviewer rosters");
  }
}
async function prepareImported(ctx: PluginContext, initial: Intake, policy: ProjectMandate, issues: Awaited<ReturnType<typeof projectIssues>>) {
  let intake = initial;
  await requireLinearRoster(ctx, policy);
  const snapshot = await readLinearIntake(ctx, policy, intake.rootIssueId, issues, intake.state.linearIntake);
  if (!intake.state.linearIntake) intake = await save(ctx, intake, { ...intake.state, linearIntake: { snapshot, effects: {} } });
  const preparationReceipt = await assertLinearSource(ctx, policy, intake.missionId, snapshot.subject, "preparation");
  intake = await save(ctx, intake, { ...intake.state, linearIntake: { ...intake.state.linearIntake!, preparationReceipt } });
  await prepareLinearTasks(ctx, intake.state.linearIntake!, async linearIntake => {
    intake = await save(ctx, intake, { ...intake.state, linearIntake });
  }, async () => { await requireCurrentPolicy(ctx, policy); requireFreshLinearReceipt(intake.state.linearIntake?.preparationReceipt); });
  await readLinearIntake(ctx, policy, intake.rootIssueId, await projectIssues(ctx, intake.companyId, intake.projectId), intake.state.linearIntake);
  return intake;
}
async function pinTask(ctx: PluginContext, initial: Intake, policy: ProjectMandate, issues: Awaited<ReturnType<typeof projectIssues>>) {
  let intake = initial;
  let root = await ctx.issues.get(intake.rootIssueId, intake.companyId);
  if (root?.originKind === LINEAR_ORIGIN) {
    intake = await prepareImported(ctx, intake, policy, issues);
    root = await ctx.issues.get(intake.rootIssueId, intake.companyId);
  } else requireManualRoot(root, policy);
  if (!root) throw new MissionError(409, "project_task_missing", "The original root must remain readable");
  const hierarchy = await prepareHierarchy(ctx, policy, root.id, issues, intake.state.linearIntake?.snapshot);
  if (!root.title.trim() || !root.description?.trim()) throw new MissionError(422, "project_task_description", "Describe the expected result in this task before admission");
  if (!intake.state.linearIntake && root.title.length + root.description.length > 8000) throw new MissionError(422, "project_task_description", "Task source exceeds the bounded 8000 character mission objective");
  const existing = await getMissionByRootIssue(ctx, intake.companyId, intake.rootIssueId);
  if (existing) throw new MissionError(409, "project_task_already_managed", "This root already belongs to another mission; retain its original identity");
  const { criteria, commitments, taskDocumentRevisionId } = await taskCriteria(ctx, intake, policy);
  const objective = intake.state.linearIntake ? linearMissionObjective(intake.state.linearIntake) : `${root.title}\n\n${root.description}`;
  const mandate = parseMissionMandate({ ...policy.content.template, objective, acceptanceCriteria: criteria, commitments });
  const createBody = { companyId: intake.companyId, command: "create", commandId: randomUUID(), missionId: intake.missionId,
    rootIssueId: root.id, projectId: intake.projectId, teamRosterId: policy.content.teamRosterId, teamRevision: policy.content.teamRevision,
    councilRosterId: policy.content.councilRosterId, councilRevision: policy.content.councilRevision, mandate };
  const snapshot: ProjectMandateSnapshot = { projectId: intake.projectId, revisionId: policy.revisionId, version: policy.version,
    authorizedBy: policy.authorizedBy, operatingProfileHash: policy.content.operatingProfileHash, mandateHash: canonicalPayloadHash(mandate),
    allowedPaths: policy.content.allowedPaths, publication: policy.content.publication,
    ...(policy.content.completion ? { completion: policy.content.completion } : {}),
    ...(intake.state.linearIntake ? { linearIntake: { subject: intake.state.linearIntake.snapshot.subject, bodySha256: intake.state.linearIntake.snapshot.bodySha256 } } : {}),
    source: { rootIssueId: root.id, title: root.title, descriptionHash: canonicalPayloadHash(root.description), taskDocumentRevisionId } };
  return save(ctx, intake, { ...intake.state, createBody, snapshot, ...(hierarchy ? { hierarchy } : {}) });
}

async function taskCriteria(ctx: PluginContext, intake: Intake, policy: ProjectMandate) {
  let criteria = policy.content.template.acceptanceCriteria, commitments = policy.content.template.commitments;
  let taskDocumentRevisionId: string | null = null;
  if (policy.content.criteriaSource === "task-document") {
    const doc = await ctx.issues.documents.get(intake.rootIssueId, "council-task", intake.companyId);
    let parsed: any;
    try { parsed = doc && JSON.parse(doc.body); } catch { /* reported below without inventing task criteria */ }
    if (!parsed || !doc?.latestRevisionId || Array.isArray(parsed) || Object.keys(parsed).some(key => !["acceptanceCriteria", "commitments"].includes(key))) {
      throw new MissionError(422, "project_task_criteria", "Add a council-task JSON document containing acceptanceCriteria and optional commitments only; project limits and rights remain fixed");
    }
    criteria = parsed.acceptanceCriteria; commitments = parsed.commitments ?? commitments; taskDocumentRevisionId = doc.latestRevisionId;
  }
  return { criteria, commitments, taskDocumentRevisionId };
}

async function preparePublication(ctx: PluginContext, initial: Intake, m: MissionRecord, policy: ProjectMandate) {
  const publication = policy.content.publication;
  if (!publication || m.aggregate.n5 || m.aggregate.phase !== "ready_for_review" || m.aggregate.n2) return;
  await assertProjectDeparture(ctx, m);
  let intake = initial;
  if (!intake.state.plan) {
    const n1 = m.aggregate.n1 as N1State;
    if (!n1.candidate || n1.contributions.some(slot => !slot.commit)) throw new MissionError(409, "project_plan_evidence", "Complete contribution commits and the verified integrated candidate are required");
    const body = JSON.stringify({ missionId: m.missionId, mandateHash: canonicalPayloadHash(m.aggregate.mandate),
      plannerAgentId: policy.content.leadAgentId, orchestratorAgentId: policy.content.leadAgentId, integrationLeadAgentId: policy.content.leadAgentId,
      qaAgentId: publication.qaAgentId, work: n1.contributions.map(slot => ({ assigneeAgentId: slot.assigneeAgentId,
        sourceRefs: [`issue:${slot.childIssueId}`, `git:${slot.commit}`], ownedPaths: slot.ownedPaths, dependencies: m.aggregate.hierarchy?.leaves?.find(leaf => leaf.issueId === slot.childIssueId)?.blockedByIssueIds.map(id => `issue:${id}`) ?? [],
        evidenceRefs: [`git:${slot.commit}`], skills: [], interface: slot.title })) });
    intake = await save(ctx, intake, { ...intake.state, plan: { key: `council-plan-${m.missionId}`, body } });
  }
  const plan = intake.state.plan!;
  let doc = await ctx.issues.documents.get(m.rootIssueId, plan.key, m.companyId);
  if (!doc) {
    await ctx.issues.documents.upsert({ companyId: m.companyId, issueId: m.rootIssueId, key: plan.key, format: "markdown", title: "Plan de publication Council", body: plan.body });
    doc = await ctx.issues.documents.get(m.rootIssueId, plan.key, m.companyId);
  }
  if (doc?.body !== plan.body || !doc.latestRevisionId) throw new MissionError(409, "project_plan_readback", "Retain the original immutable operational plan; no overwrite or replacement key");
  const prepared = await command(ctx, intake, m, "configure-delivery", { planRevisionId: doc.latestRevisionId, planDocumentKey: plan.key,
    publisherAgentId: publication.publisherAgentId, repository: publication.repository, baseRef: publication.baseRef,
    headRef: `${publication.headRefPrefix}-${m.missionId}`, ...(publication.contract ? { contract: publication.contract } : {}) });
  const result = await handleN5Board(ctx, { companyId: m.companyId, routeKey: "mission-command", method: "POST", params: { companyId: m.companyId, missionId: m.missionId },
    actor: { actorType: "user", userId: policy.authorizedBy }, body: prepared.body } as any);
  if (result.status !== 200) throw new MissionError(result.status, "project_publication_configuration", "Persisted publication command did not apply; inspect the original command");
}

async function advance(ctx: PluginContext, initial: Intake, latest: ProjectMandate, issues: Awaited<ReturnType<typeof projectIssues>>) {
  let intake = initial;
  const rows = await ctx.db.query<any>(`SELECT * FROM ${projectTable(ctx, "project_mandates")} WHERE revision_id = $1 AND company_id = $2 AND project_id = $3`, [intake.revisionId, intake.companyId, intake.projectId]);
  if (!rows[0]) throw new MissionError(409, "project_policy_missing", "Pinned project policy is missing");
  const policy = projectMandateRow(rows[0]);
  try {
    if (!latest.content.enabled || latest.revisionId !== intake.revisionId || (await ctx.companies.get(intake.companyId))?.defaultResponsibleUserId !== policy.authorizedBy
        || operatingProfileHash(await ctx.config.get(intake.companyId)) !== policy.content.operatingProfileHash) {
      throw new MissionError(409, "project_authority_changed", "Project owner, operating profile or policy revision changed; retain the original intake without new effects");
    }
    if (!intake.state.createBody) intake = await pinTask(ctx, intake, policy, issues);
    // Replays use the persisted full payload. The root is never recreated.
    await createMission(ctx, intake.companyId, policy.authorizedBy, intake.state.createBody);
    let m = (await getMission(ctx, intake.companyId, intake.missionId))!;
    if (!m.aggregate.projectMandate) m = await n2Cas(ctx, m, { ...m.aggregate, projectMandate: intake.state.snapshot!,
      ...(intake.state.hierarchy ? { hierarchy: intake.state.hierarchy } : {}) });
    else if (canonicalPayloadHash(m.aggregate.projectMandate) !== canonicalPayloadHash(intake.state.snapshot)) throw new MissionError(409, "project_snapshot_conflict", "Original task and project snapshot changed");
    await assertProjectDeparture(ctx, m);
    if (!m.aggregate.continuity) {
      const prepared = await command(ctx, intake, m, "configure-continuity", { authorizeProgression: true, n3Slots: policy.content.n3Slots });
      intake = prepared.intake;
      await configureContinuity(ctx, m, policy.authorizedBy, prepared.body, { n2CommandCas, runtimeReceipt, runtimeUuid });
      m = (await getMission(ctx, intake.companyId, intake.missionId))!;
    }
    const activated = await activateTask(ctx, intake, m, policy, issues);
    intake = activated.intake; m = activated.mission;
    await preparePublication(ctx, intake, m, policy);
  } catch (error) {
    if (error instanceof MissionError && error.code === "linear_source_pending") return;
    // Re-read after any ambiguous database response; never write from an obsolete intake version.
    const current = await ctx.db.query<any>(`SELECT * FROM ${projectTable(ctx, "project_task_intakes")} WHERE company_id = $1 AND root_issue_id = $2`, [intake.companyId, intake.rootIssueId]);
    await question(ctx, current[0] ? fromRow(current[0]) : intake, policy, error);
  }
}

async function activateTask(ctx: PluginContext, intake: Intake, m: MissionRecord, policy: ProjectMandate, issues: Awaited<ReturnType<typeof projectIssues>>) {
  if (m.aggregate.n1) return { intake, mission: m };
  const root = await ctx.issues.get(m.rootIssueId, m.companyId);
  const source = intake.state.snapshot!.source;
  const doc = source.taskDocumentRevisionId ? await ctx.issues.documents.get(m.rootIssueId, "council-task", m.companyId) : null;
  if (root?.title !== source.title || canonicalPayloadHash(root.description) !== source.descriptionHash
      || source.taskDocumentRevisionId && doc?.latestRevisionId !== source.taskDocumentRevisionId
      || !m.aggregate.hierarchy?.leaves && issues.some(issue => issue.parentId === m.rootIssueId)) {
    throw new MissionError(409, "project_task_source_changed", "Task source or children changed after the pinned intake; retain the original mission without activation");
  }
  if (intake.state.linearIntake) {
    await readLinearIntake(ctx, policy, intake.rootIssueId, await projectIssues(ctx, intake.companyId, intake.projectId), intake.state.linearIntake);
    const admissionReceipt = await assertLinearSource(ctx, policy, intake.missionId, intake.state.linearIntake.snapshot.subject, "admission");
    intake = await save(ctx, intake, { ...intake.state, linearIntake: { ...intake.state.linearIntake, admissionReceipt } });
  }
  const profile = await readNativeG4Profile(ctx, m.companyId);
  if (!profile) throw new MissionError(409, "project_admission_missing", "Existing native operating period required; no budget reset");
  const prepared = await command(ctx, intake, m, "activate", { periodKey: profile.periodKey, reservationId: randomUUID(), requestedUnits: profile.runReservationUnits });
  if (prepared.intake.state.linearIntake) requireFreshLinearReceipt(prepared.intake.state.linearIntake.admissionReceipt);
  await executeN1BoardCommand(ctx, { companyId: m.companyId, missionId: m.missionId, actorUserId: policy.authorizedBy, body: prepared.body });
  return { intake: prepared.intake, mission: (await getMission(ctx, intake.companyId, intake.missionId))! };
}

function eligibleRoot(issue: Awaited<ReturnType<typeof projectIssues>>[number], policy: ProjectMandate) {
  if (issue.parentId || policy.content.baselineRootIds.includes(issue.id)) return false;
  if (issue.originKind === LINEAR_ORIGIN) return Boolean(policy.content.linearIntake) && issue.status === "blocked" && issue.assigneeAgentId === null;
  return issue.originKind === "manual" && ["backlog", ...(policy.content.hierarchy?.adoptExistingChildren ? ["blocked"] : [])].includes(issue.status)
    && issue.assigneeAgentId === policy.content.leadAgentId;
}

/** Called by the existing native job before mission progression. No competing scheduler or agent. */
export async function reconcileProjectTasks(ctx: PluginContext) {
  for (const policy of await listProjectMandates(ctx)) {
    if (!policy.content.enabled) continue;
    const issues = await projectIssues(ctx, policy.companyId, policy.projectId);
    for (const root of issues.filter(issue => eligibleRoot(issue, policy))) {
      await ctx.db.execute(`INSERT INTO ${projectTable(ctx, "project_task_intakes")} (company_id, root_issue_id, project_id, policy_revision_id, mission_id, state)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT DO NOTHING`, [policy.companyId, root.id, policy.projectId, policy.revisionId, randomUUID(), JSON.stringify({ commands: {}, questions: {} })]);
    }
    const rows = await ctx.db.query<any>(`SELECT * FROM ${projectTable(ctx, "project_task_intakes")} WHERE company_id = $1 AND project_id = $2 ORDER BY created_at, root_issue_id LIMIT 101`, [policy.companyId, policy.projectId]);
    if (rows.length > 100) throw new MissionError(409, "project_intake_bound", "More than 100 intakes require an explicit scan plan; no truncated execution");
    for (const row of rows) await advance(ctx, fromRow(row), policy, issues);
  }
}
