import { parseLinearContinuityPolicy } from "./linear-continuity-intake.js";
import { readTaskIntake, rebindUnstartedTask } from "./project-intake-rebind.js";
import { inspectProjectReadiness } from "./project-readiness.js";
import { operatingProfileHash } from "./project-mandate-state.js";
import { parseCompletionPolicy } from "./completion-contract.js";
import { parsePrContract } from "./pr-contract.js";
import { parseHierarchyPolicy } from "./hierarchy-contract.js";
import { parseLinearIntakePolicy } from "./linear-intake-contract.js";
import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, parseMissionMandate } from "./missions.js";
import { runtimeUuid } from "./n2-missions.js";
import { normalizeN3Slots } from "./n3-opinions.js";
import { validateRosterPair } from "./rosters.js";
import { readNativeG4Profile } from "./g4-native.js";
import { readAdmission } from "./admission.js";
import { assertConfiguredGithubFeedbackRefresh } from "./github-feedback-authority.js";
import { projectIssues, projectMandateRow, projectTable, readProjectMandate, type ProjectMandateContent, type ProjectPublication } from "./project-mandate-state.js";


function text(value: unknown, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new MissionError(422, "project_mandate_input", `${label} must be explicit and bounded`);
  return value.trim();
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new MissionError(422, "project_mandate_paths", "Declare 1–64 repository paths or prefixes, with . only for an explicitly authorized whole repository");
  return [...new Set(value.map(path => {
    const p = text(path, "allowedPaths", 1000).replace(/\/$/, "");
    if (p !== "." && (p.startsWith("/") || p.includes("\\") || p.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))) {
      throw new MissionError(422, "project_mandate_paths", "Paths must stay inside the project repository");
    }
    return p;
  }))];
}
async function publication(ctx: PluginContext, companyId: string, value: unknown): Promise<ProjectPublication | null> {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionError(422, "project_publication_policy", "Publication must be explicitly null or a bounded authority");
  const v = value as Record<string, unknown>;
  const result = { publisherAgentId: runtimeUuid(v.publisherAgentId, "publisherAgentId"), qaAgentId: runtimeUuid(v.qaAgentId, "qaAgentId"),
    repository: text(v.repository, "repository"), baseRef: text(v.baseRef, "baseRef"), headRefPrefix: text(v.headRefPrefix, "headRefPrefix", 120) };
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repository) || !/^codex\/[A-Za-z0-9_.-]+$/.test(result.headRefPrefix)
      || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(result.baseRef) || result.baseRef.includes("..") || result.headRefPrefix.includes("..")) {
    throw new MissionError(422, "project_publication_policy", "Exact repository, safe base and codex/ branch prefix required; no merge or deployment authority");
  }
  for (const id of [result.publisherAgentId, result.qaAgentId]) {
    const agent = await ctx.agents.get(id, companyId);
    if (!agent || agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli" || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
      throw new MissionError(422, "project_publication_actor", "Declared publisher and QA must be available CLI actors in this company");
    }
  }
  const contract = parsePrContract(v.contract);
  assertConfiguredGithubFeedbackRefresh(contract?.feedbackRefresh, (await ctx.config.get(companyId)).githubFeedbackToken);
  return { ...result, ...(contract ? { contract } : {}) };
}
async function baseline(ctx: PluginContext, companyId: string, projectId: string, included: unknown) {
  const include = included === undefined ? [] : included;
  if (!Array.isArray(include) || include.length > 20) throw new MissionError(422, "project_existing_scope", "At most 20 explicitly included existing roots are supported");
  const ids = include.map(id => runtimeUuid(id, "includedRootIssueId"));
  const issues = await projectIssues(ctx, companyId, projectId);
  if (ids.some(id => !issues.some(issue => issue.id === id && !issue.parentId))) throw new MissionError(422, "project_existing_scope", "Explicitly included roots must already belong to this project");
  return issues.filter(issue => !issue.parentId && !ids.includes(issue.id)).map(issue => issue.id);
}

async function deliveryPolicy(ctx: PluginContext, companyId: string, body: Record<string, any>) {
  const delegatedPublication = await publication(ctx, companyId, body.publication);
  const hierarchy = body.hierarchy === undefined ? undefined : parseHierarchyPolicy(body.hierarchy);
  const completion = parseCompletionPolicy(body.completion, delegatedPublication, hierarchy);
  if (delegatedPublication?.contract?.integration && (!hierarchy?.adoptExistingChildren || hierarchy.maxContributions !== 1 || completion?.result !== "integrated-verified")) throw new MissionError(422, "integration_leaf_policy", "Integrated deliveries explicitly adopt one existing code leaf and require integrated proof closure; native result dependencies sequence separate deliveries");
  return { publication: delegatedPublication, ...(hierarchy ? { hierarchy } : {}), ...(completion ? { completion } : {}) };
}

async function policyContent(ctx: PluginContext, companyId: string, projectId: string, ownerId: string, body: Record<string, any>): Promise<ProjectMandateContent> {
  const config = await ctx.config.get(companyId);
  const profile = await readNativeG4Profile(ctx, companyId);
  if (config.n2RuntimeProfile !== "ordinary-cli-v1" || config.nativeWakeGuardEnabled === false || !profile
      || !await readAdmission(ctx, { companyId, periodKey: profile.periodKey })) {
    throw new MissionError(409, "project_accounting_prerequisite", "Configure the existing ordinary admission period before enabling project intake; no budget is created or reset");
  }
  const pair = await validateRosterPair(ctx, companyId, runtimeUuid(body.teamRosterId, "teamRosterId"), runtimeUuid(body.councilRosterId, "councilRosterId"));
  if (!pair.eligible || pair.team.head.lifecycle !== "active" || pair.council.head.lifecycle !== "active") throw new MissionError(422, "project_rosters_unready", "An eligible active published pair is required");
  const leadAgentId = pair.team.revision.content.integrationLeadAgentId!;
  const teamRevision = pair.team.head.publishedRevision!; const councilRevision = pair.council.head.publishedRevision!;
  let n3Slots;
  try { n3Slots = normalizeN3Slots(body.n3Slots, pair.team.revision.content.members.map(member => member.agentId), pair.council.revision.content.finalReviewerAgentId!); }
  catch { throw new MissionError(422, "project_review_slots", "Select 2–7 distinct independent review specialties"); }
  for (const id of [...pair.team.revision.content.members.map(member => member.agentId), pair.council.revision.content.finalReviewerAgentId!, ...n3Slots.map(slot => slot.specialistAgentId)]) {
    const agent = await ctx.agents.get(id, companyId);
    if (!agent || agent.adapterType !== "codex_local" || agent.adapterConfig?.engine !== "cli" || ["paused", "terminated", "pending_approval"].includes(agent.status)) {
      throw new MissionError(422, "project_actor_unready", "Declared project actors must be available CLI actors");
    }
  }
  const mandate = parseMissionMandate({ ...body.template, objective: "Project task template" });
  const { objective: _objective, ...template } = mandate;
  if (template.limits.correctionLimit > (profile.maxCorrections ?? 0)) throw new MissionError(422, "project_correction_policy", "Project policy cannot exceed the existing operating correction bound");
  if (!["project-defaults", "task-document"].includes(body.criteriaSource)) throw new MissionError(422, "project_criteria_policy", "Explicit criteria source required");
  const allowedPaths = paths(body.allowedPaths), delivery = await deliveryPolicy(ctx, companyId, body);
  const linearIntake = parseLinearIntakePolicy(body.linearIntake, { allowedPaths, hierarchy: delivery.hierarchy, criteriaSource: body.criteriaSource },
    pair.team.revision.content.members.map(member => member.agentId).filter(id => id !== leadAgentId));
  const linearContinuity = parseLinearContinuityPolicy(body.linearContinuity, linearIntake);
  return { enabled: body.enabled === true, ownerUserId: ownerId, leadAgentId, teamRosterId: pair.team.head.rosterId, teamRevision,
    councilRosterId: pair.council.head.rosterId, councilRevision, n3Slots, template, criteriaSource: body.criteriaSource,
    allowedPaths, ...delivery, ...(linearIntake ? { linearIntake } : {}), ...(linearContinuity ? { linearContinuity } : {}),
    operatingProfileHash: operatingProfileHash(config), baselineRootIds: await baseline(ctx, companyId, projectId, body.includedRootIssueIds),
    };
}

export async function handleProjectMandate(ctx: PluginContext, input: PluginApiRequestInput) {
  const companyId = runtimeUuid(input.companyId, "companyId"), projectId = runtimeUuid(input.params.projectId, "projectId");
  const company = await ctx.companies.get(companyId); const ownerId = company?.defaultResponsibleUserId;
  if (input.actor.actorType !== "user" || !ownerId || input.actor.userId !== ownerId) throw new MissionError(403, "project_owner_required", "Company responsible owner required");
  const project = await ctx.projects.get(projectId, companyId);
  if (!project || project.companyId !== companyId || project.archivedAt) throw new MissionError(422, "project_unavailable", "Exact active company project required");
  if (input.method === "GET") {
    const policy = await readProjectMandate(ctx, companyId, projectId);
    return { status: 200, body: { policy,
      ...(input.query.readiness === "true" ? { readiness: await inspectProjectReadiness(ctx, companyId, projectId, policy) } : {}),
      ...(input.query.rootIssueId ? { intake: await readTaskIntake(ctx, companyId, projectId, runtimeUuid(input.query.rootIssueId, "rootIssueId")) } : {}) } };
  }
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new MissionError(422, "project_mandate_input", "Policy object required");
  const body = input.body as Record<string, any>;
  const commandId = runtimeUuid(body.commandId, "commandId"), hash = canonicalPayloadHash(body);
  if (body.command === "rebind-unstarted-task") {
    runtimeUuid(body.rootIssueId, "rootIssueId"); runtimeUuid(body.policyRevisionId, "policyRevisionId");
    const policy = await readProjectMandate(ctx, companyId, projectId);
    if (!policy) throw new MissionError(409, "project_policy_missing", "Explicit current project mandate required");
    return { status: 200, body: { ...await rebindUnstartedTask(ctx, policy, ownerId, body), policy } };
  }
  const prior = await ctx.db.query<any>(`SELECT * FROM ${projectTable(ctx, "project_mandates")} WHERE company_id = $1 AND project_id = $2 AND command_id = $3`, [companyId, projectId, commandId]);
  if (prior[0]) {
    if (prior[0].payload_hash !== hash || prior[0].authorized_by !== ownerId) throw new MissionError(409, "project_command_conflict", "Retain the original policy command and payload");
    return { status: 200, body: { outcome: "replayed", policy: projectMandateRow(prior[0]) } };
  }
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new MissionError(422, "project_authorization_required", "Explicit current version required");
  let content: ProjectMandateContent;
  if (body.command === "suspend") {
    const current = await readProjectMandate(ctx, companyId, projectId);
    if (!current) throw new MissionError(409, "project_policy_missing", "No project mandate to suspend");
    content = { ...current.content, enabled: false };
  } else {
    if (body.authorizeNewTasks !== true || typeof body.enabled !== "boolean") throw new MissionError(422, "project_authorization_required", "Explicit owner delegation and enabled flag for new tasks required");
    content = await policyContent(ctx, companyId, projectId, ownerId, body);
  }
  const result = await ctx.db.execute(`INSERT INTO ${projectTable(ctx, "project_mandates")}
    (company_id, project_id, version, revision_id, command_id, payload_hash, authorized_by, content)
    SELECT $1, $2, $3 + 1, $4, $5, $6, $7, $8::jsonb
    WHERE COALESCE((SELECT MAX(version) FROM ${projectTable(ctx, "project_mandates")} WHERE company_id = $1 AND project_id = $2), 0) = $3
    ON CONFLICT DO NOTHING`, [companyId, projectId, body.expectedVersion, randomUUID(), commandId, hash, ownerId, JSON.stringify(content)]);
  if (result.rowCount !== 1) throw new MissionError(409, "project_version_conflict", "Project policy changed; read the exact current version before another command");
  return { status: 200, body: { outcome: "applied", policy: await readProjectMandate(ctx, companyId, projectId) } };
}
