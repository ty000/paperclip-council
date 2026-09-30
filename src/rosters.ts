import { randomUUID } from "node:crypto";
import type {
  Agent,
  PluginApiRequestInput,
  PluginContext,
  PluginPerformActionContext,
} from "@paperclipai/plugin-sdk";

export type RosterKind = "team" | "council";
export type RosterLifecycle = "draft" | "active" | "suspended" | "retired";

export type RosterMember = {
  agentId: string;
  responsibilities: string[];
};

export type RosterContent = {
  members: RosterMember[];
  integrationLeadAgentId: string | null;
  finalReviewerAgentId: string | null;
  requiredPerspectives: string[];
};

export type RosterRevision = {
  companyId: string;
  rosterId: string;
  revision: string;
  kind: RosterKind;
  name: string;
  projectId: string | null;
  content: RosterContent;
  createdByUserId: string;
  createdAt: string;
};

export type RosterHead = {
  companyId: string;
  rosterId: string;
  publishedRevision: string;
  lifecycle: RosterLifecycle;
  version: number;
  auditEntries: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};

export type RosterSnapshot = {
  head: RosterHead;
  revision: RosterRevision;
};

export type RosterValidationFinding = {
  code: string;
  message: string;
  rosterId?: string;
  agentId?: string;
};

export type RosterPairValidation = {
  eligible: boolean;
  errors: RosterValidationFinding[];
  prerequisites: Array<{ code: string; status: "ready" | "pending" | "unsupported"; message: string }>;
  team: RosterSnapshot;
  council: RosterSnapshot;
};

type RevisionRow = {
  company_id: string;
  roster_id: string;
  revision: string;
  kind: RosterKind;
  name: string;
  project_id: string | null;
  content: unknown;
  created_by_user_id: string;
  created_at: Date | string;
};

type HeadRow = {
  company_id: string;
  roster_id: string;
  published_revision: string;
  lifecycle: RosterLifecycle;
  version: string | number;
  audit_entries: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type SnapshotRow = Omit<RevisionRow, "created_at"> & Omit<HeadRow, "created_at" | "updated_at"> & {
  head_created_at: Date | string;
  head_updated_at: Date | string;
  revision_created_at: Date | string;
};

export class RosterError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "RosterError";
  }
}

function asRecord(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RosterError(400, "malformed_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RosterError(400, "malformed_request", `${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredString(value, label);
}

function positiveVersion(value: unknown, label = "expectedVersion"): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RosterError(400, "malformed_request", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new RosterError(400, "malformed_request", `${label} must be an array`);
  const result = value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new RosterError(422, "duplicate_value", `${label} contains duplicate values`);
  }
  return result;
}

function parseMembers(value: unknown): RosterMember[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RosterError(422, "members_required", "At least one roster member is required");
  }
  const members = value.map((entry, index) => {
    const record = asRecord(entry, `members[${index}]`);
    return {
      agentId: requiredString(record.agentId, `members[${index}].agentId`),
      responsibilities: stringList(record.responsibilities, `members[${index}].responsibilities`),
    };
  });
  if (new Set(members.map((member) => member.agentId)).size !== members.length) {
    throw new RosterError(422, "duplicate_member", "A Paperclip agent can appear only once in a roster revision");
  }
  return members;
}

export function parseRosterDraft(value: unknown) {
  const body = asRecord(value);
  const kind = body.kind;
  if (kind !== "team" && kind !== "council") {
    throw new RosterError(422, "invalid_kind", "kind must be team or council");
  }
  const members = parseMembers(body.members);
  const integrationLeadAgentId = optionalString(body.integrationLeadAgentId, "integrationLeadAgentId");
  const finalReviewerAgentId = optionalString(body.finalReviewerAgentId, "finalReviewerAgentId");
  const requiredPerspectives = body.requiredPerspectives === undefined
    ? []
    : stringList(body.requiredPerspectives, "requiredPerspectives");
  return {
    kind,
    name: requiredString(body.name, "name").slice(0, 120),
    projectId: optionalString(body.projectId, "projectId"),
    content: { members, integrationLeadAgentId, finalReviewerAgentId, requiredPerspectives },
  } satisfies Omit<RosterRevision, "companyId" | "rosterId" | "revision" | "createdByUserId" | "createdAt">;
}

function safeInteger(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label}`);
  return parsed;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid timestamp from roster store");
  return date.toISOString();
}

function parseContent(value: unknown): RosterContent {
  const record = asRecord(value, "stored roster content");
  return {
    members: parseMembers(record.members),
    integrationLeadAgentId: optionalString(record.integrationLeadAgentId, "integrationLeadAgentId"),
    finalReviewerAgentId: optionalString(record.finalReviewerAgentId, "finalReviewerAgentId"),
    requiredPerspectives: stringList(record.requiredPerspectives ?? [], "requiredPerspectives"),
  };
}

function parseRevision(row: RevisionRow): RosterRevision {
  return {
    companyId: row.company_id,
    rosterId: row.roster_id,
    revision: row.revision,
    kind: row.kind,
    name: row.name,
    projectId: row.project_id,
    content: parseContent(row.content),
    createdByUserId: row.created_by_user_id,
    createdAt: timestamp(row.created_at),
  };
}

function parseHead(row: HeadRow): RosterHead {
  return {
    companyId: row.company_id,
    rosterId: row.roster_id,
    publishedRevision: row.published_revision,
    lifecycle: row.lifecycle,
    version: safeInteger(row.version, "head version"),
    auditEntries: Array.isArray(row.audit_entries) ? row.audit_entries as Array<Record<string, unknown>> : [],
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function table(ctx: PluginContext, name: "roster_revisions" | "roster_heads"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.${name}`;
}

function snapshotSelect(ctx: PluginContext): string {
  return `SELECT h.company_id, h.roster_id, h.published_revision, h.lifecycle, h.version,
    h.audit_entries, h.created_at AS head_created_at, h.updated_at AS head_updated_at,
    r.revision, r.kind, r.name, r.project_id, r.content, r.created_by_user_id,
    r.created_at AS revision_created_at
    FROM ${table(ctx, "roster_heads")} h
    JOIN ${table(ctx, "roster_revisions")} r
      ON r.company_id = h.company_id AND r.roster_id = h.roster_id AND r.revision = h.published_revision`;
}

function parseSnapshot(row: SnapshotRow): RosterSnapshot {
  return {
    head: parseHead({ ...row, created_at: row.head_created_at, updated_at: row.head_updated_at }),
    revision: parseRevision({ ...row, created_at: row.revision_created_at }),
  };
}

export async function getRoster(ctx: PluginContext, companyId: string, rosterId: string): Promise<RosterSnapshot | null> {
  const rows = await ctx.db.query<SnapshotRow>(
    `${snapshotSelect(ctx)} WHERE h.company_id = $1 AND h.roster_id = $2`,
    [companyId, rosterId],
  );
  return rows[0] ? parseSnapshot(rows[0]) : null;
}

export async function listRosters(ctx: PluginContext, companyId: string): Promise<RosterSnapshot[]> {
  const rows = await ctx.db.query<SnapshotRow>(
    `${snapshotSelect(ctx)} WHERE h.company_id = $1 ORDER BY h.updated_at DESC, h.roster_id`,
    [companyId],
  );
  return rows.map(parseSnapshot);
}

export async function listRosterHistory(
  ctx: PluginContext,
  companyId: string,
  rosterId: string,
): Promise<RosterRevision[]> {
  const rows = await ctx.db.query<RevisionRow>(
    `SELECT company_id, roster_id, revision, kind, name, project_id, content, created_by_user_id, created_at
      FROM ${table(ctx, "roster_revisions")}
      WHERE company_id = $1 AND roster_id = $2 ORDER BY revision DESC`,
    [companyId, rosterId],
  );
  return rows.map(parseRevision);
}

async function insertRevision(
  ctx: PluginContext,
  companyId: string,
  rosterId: string,
  draft: ReturnType<typeof parseRosterDraft>,
  actorUserId: string,
): Promise<RosterRevision> {
  const revisionId = randomUUID();
  const insert = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "roster_revisions")}
      (company_id, roster_id, revision, kind, name, project_id, content, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [companyId, rosterId, revisionId, draft.kind, draft.name, draft.projectId, JSON.stringify(draft.content), actorUserId],
  );
  if (insert.rowCount !== 1) throw new Error("Roster revision insert did not affect one row");
  const rows = await ctx.db.query<RevisionRow>(
    `SELECT company_id, roster_id, revision, kind, name, project_id, content, created_by_user_id, created_at
      FROM ${table(ctx, "roster_revisions")}
      WHERE company_id = $1 AND roster_id = $2 AND revision = $3`,
    [companyId, rosterId, revisionId],
  );
  if (!rows[0]) throw new Error("Roster revision insert returned no row");
  return parseRevision(rows[0]);
}

function auditEntry(action: string, actorUserId: string, details: Record<string, unknown> = {}) {
  return { action, actorUserId, at: new Date().toISOString(), ...details };
}

export async function createRoster(
  ctx: PluginContext,
  input: { companyId: string; actorUserId: string; rosterId?: string; draft: ReturnType<typeof parseRosterDraft> },
): Promise<RosterSnapshot> {
  const rosterId = input.rosterId ?? randomUUID();
  const revision = await insertRevision(ctx, input.companyId, rosterId, input.draft, input.actorUserId);
  const audit = [auditEntry("created", input.actorUserId, { revision: revision.revision })];
  const insert = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "roster_heads")}
      (company_id, roster_id, published_revision, lifecycle, version, audit_entries)
      VALUES ($1, $2, $3, 'draft', 1, $4::jsonb)
      ON CONFLICT (company_id, roster_id) DO NOTHING`,
    [input.companyId, rosterId, revision.revision, JSON.stringify(audit)],
  );
  if (insert.rowCount !== 1) {
    throw new RosterError(409, "roster_exists", "A roster with this ID already exists; the inserted revision is unreferenced");
  }
  return (await getRoster(ctx, input.companyId, rosterId))!;
}

export async function reviseRoster(
  ctx: PluginContext,
  input: {
    companyId: string;
    rosterId: string;
    expectedVersion: number;
    actorUserId: string;
    draft: ReturnType<typeof parseRosterDraft>;
  },
): Promise<{ outcome: "applied" | "conflict"; roster: RosterSnapshot; orphanedRevision?: string }> {
  const before = await getRoster(ctx, input.companyId, input.rosterId);
  if (!before) throw new RosterError(404, "roster_not_found", "Roster not found");
  if (before.head.lifecycle === "retired") {
    throw new RosterError(409, "roster_retired", "Retired rosters cannot be revised");
  }
  if (before.revision.kind !== input.draft.kind) {
    throw new RosterError(422, "kind_immutable", "Roster kind cannot change across revisions");
  }
  const revision = await insertRevision(ctx, input.companyId, input.rosterId, input.draft, input.actorUserId);
  const audit = auditEntry("revised", input.actorUserId, {
    fromRevision: before.head.publishedRevision,
    toRevision: revision.revision,
  });
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx, "roster_heads")}
      SET published_revision = $1, lifecycle = 'draft', version = version + 1,
        audit_entries = audit_entries || $2::jsonb, updated_at = now()
      WHERE company_id = $3 AND roster_id = $4 AND version = $5 AND lifecycle <> 'retired'`,
    [revision.revision, JSON.stringify([audit]), input.companyId, input.rosterId, input.expectedVersion],
  );
  const roster = await getRoster(ctx, input.companyId, input.rosterId);
  if (!roster) throw new Error("Roster disappeared after revision publication");
  return update.rowCount === 1
    ? { outcome: "applied", roster }
    : { outcome: "conflict", roster, orphanedRevision: revision.revision };
}

function validateRosterShape(roster: RosterSnapshot): RosterValidationFinding[] {
  const errors: RosterValidationFinding[] = [];
  const { content } = roster.revision;
  const memberIds = new Set(content.members.map((member) => member.agentId));
  if (roster.revision.kind === "team") {
    if (!content.integrationLeadAgentId || !memberIds.has(content.integrationLeadAgentId)) {
      errors.push({ code: "integration_lead_required", rosterId: roster.head.rosterId, message: "Team requires one member as integration lead" });
    }
    if (content.finalReviewerAgentId) {
      errors.push({ code: "team_final_reviewer_forbidden", rosterId: roster.head.rosterId, message: "Team cannot declare a final reviewer" });
    }
  } else {
    if (!content.finalReviewerAgentId || !memberIds.has(content.finalReviewerAgentId)) {
      errors.push({ code: "final_reviewer_required", rosterId: roster.head.rosterId, message: "Council requires one member as final reviewer" });
    }
    if (content.integrationLeadAgentId) {
      errors.push({ code: "council_integration_lead_forbidden", rosterId: roster.head.rosterId, message: "Council cannot declare an integration lead" });
    }
  }
  for (const member of content.members) {
    if (member.responsibilities.length === 0) {
      errors.push({ code: "responsibility_required", rosterId: roster.head.rosterId, agentId: member.agentId, message: "Every member needs at least one responsibility" });
    }
  }
  return errors;
}

function isEligibleAgent(agent: Agent): boolean {
  return agent.status === "active" || agent.status === "idle" || agent.status === "running";
}

async function validateAgentAndProjectReferences(
  ctx: PluginContext,
  companyId: string,
  rosters: RosterSnapshot[],
): Promise<RosterValidationFinding[]> {
  const errors: RosterValidationFinding[] = [];
  const agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  for (const roster of rosters) {
    if (roster.revision.companyId !== companyId) {
      errors.push({ code: "foreign_company_roster", rosterId: roster.head.rosterId, message: "Roster belongs to another company" });
      continue;
    }
    if (roster.revision.projectId) {
      const project = await ctx.projects.get(roster.revision.projectId, companyId);
      if (!project || project.companyId !== companyId || project.archivedAt) {
        errors.push({ code: "project_incompatible", rosterId: roster.head.rosterId, message: "Selected project is unavailable or belongs to another company" });
      }
    }
    for (const member of roster.revision.content.members) {
      const agent = byId.get(member.agentId);
      if (!agent || agent.companyId !== companyId) {
        errors.push({ code: "agent_foreign_or_missing", rosterId: roster.head.rosterId, agentId: member.agentId, message: "Selected agent is not available in this company" });
      } else if (!isEligibleAgent(agent)) {
        errors.push({ code: "agent_ineligible", rosterId: roster.head.rosterId, agentId: member.agentId, message: `Agent ${agent.name} is ${agent.status} and cannot activate this roster` });
      }
    }
  }
  return errors;
}

export async function validateRosterPair(
  ctx: PluginContext,
  companyId: string,
  teamRosterId: string,
  councilRosterId: string,
): Promise<RosterPairValidation> {
  const team = await getRoster(ctx, companyId, teamRosterId);
  const council = await getRoster(ctx, companyId, councilRosterId);
  if (!team || !council) throw new RosterError(404, "roster_not_found", "Team or council roster not found in this company");
  const errors = [...validateRosterShape(team), ...validateRosterShape(council)];
  if (team.revision.kind !== "team") errors.push({ code: "team_kind_required", rosterId: teamRosterId, message: "Selected team roster is not a team" });
  if (council.revision.kind !== "council") errors.push({ code: "council_kind_required", rosterId: councilRosterId, message: "Selected council roster is not a council" });
  if (team.head.lifecycle === "retired" || council.head.lifecycle === "retired") {
    errors.push({ code: "retired_roster", message: "Retired rosters cannot be activated or selected for future use" });
  }
  errors.push(...await validateAgentAndProjectReferences(ctx, companyId, [team, council]));
  if (team.revision.projectId !== council.revision.projectId) {
    errors.push({ code: "project_scope_mismatch", message: "Team and council must use the same project restriction" });
  }
  const integrationLead = team.revision.content.integrationLeadAgentId;
  const finalReviewer = council.revision.content.finalReviewerAgentId;
  if (integrationLead && finalReviewer && integrationLead === finalReviewer) {
    errors.push({ code: "self_review_conflict", agentId: integrationLead, message: "Integration lead and final reviewer must be different agents" });
  }
  const executionAgents = new Set(team.revision.content.members.map((member) => member.agentId));
  for (const reviewer of council.revision.content.members) {
    if (executionAgents.has(reviewer.agentId)) {
      errors.push({ code: "execution_review_conflict", agentId: reviewer.agentId, message: "An execution team member cannot be a counted council reviewer" });
    }
  }
  return {
    eligible: errors.length === 0,
    errors,
    prerequisites: [
      { code: "configuration_saved", status: "ready", message: "Roster revisions are saved and inspectable." },
      { code: "owner_destination", status: "ready", message: "Company default responsible user is the configured owner destination." },
      { code: "native_review_path", status: "pending", message: "Native mission review path is verified when an L2 mission is persisted." },
      { code: "mandate_and_limits", status: "pending", message: "Mission mandate and operating limits are supplied per mission." },
      { code: "decision_reconciliation", status: "unsupported", message: "L0 G3 uncertain-decision reconciliation remains unqualified." },
      { code: "runtime_budget_exposure", status: "unsupported", message: "L0 G4 aggregate runtime exposure remains unqualified." },
    ],
    team,
    council,
  };
}

async function configuredOwner(ctx: PluginContext, companyId: string): Promise<string> {
  const company = await ctx.companies.get(companyId);
  if (!company || company.id !== companyId) throw new RosterError(404, "company_not_found", "Company not found");
  if (!company.defaultResponsibleUserId) {
    throw new RosterError(422, "owner_not_configured", "Company default responsible user must be configured before roster mutation");
  }
  return company.defaultResponsibleUserId;
}

async function requireOwner(ctx: PluginContext, companyId: string, actorUserId: string | null): Promise<string> {
  const ownerUserId = await configuredOwner(ctx, companyId);
  if (!actorUserId || actorUserId !== ownerUserId) {
    throw new RosterError(403, "owner_required", "Only the configured company owner can mutate Council rosters");
  }
  return ownerUserId;
}

async function transitionRoster(
  ctx: PluginContext,
  input: { companyId: string; rosterId: string; expectedVersion: number; actorUserId: string; target: "suspended" | "retired" },
): Promise<RosterSnapshot> {
  const lifecycleGuard = input.target === "suspended"
    ? "lifecycle = 'active'"
    : "lifecycle IN ('draft', 'active', 'suspended')";
  const audit = auditEntry(input.target, input.actorUserId);
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx, "roster_heads")}
      SET lifecycle = $1, version = version + 1, audit_entries = audit_entries || $2::jsonb, updated_at = now()
      WHERE company_id = $3 AND roster_id = $4 AND version = $5 AND ${lifecycleGuard}`,
    [input.target, JSON.stringify([audit]), input.companyId, input.rosterId, input.expectedVersion],
  );
  const roster = await getRoster(ctx, input.companyId, input.rosterId);
  if (!roster) throw new RosterError(404, "roster_not_found", "Roster not found");
  if (update.rowCount !== 1) {
    throw new RosterError(409, "version_or_lifecycle_conflict", "Roster version or lifecycle is stale", { current: roster });
  }
  return roster;
}

export async function activateRosterPair(
  ctx: PluginContext,
  input: {
    companyId: string;
    teamRosterId: string;
    teamExpectedVersion: number;
    councilRosterId: string;
    councilExpectedVersion: number;
    actorUserId: string;
  },
) {
  const validation = await validateRosterPair(ctx, input.companyId, input.teamRosterId, input.councilRosterId);
  if (!validation.eligible) {
    throw new RosterError(422, "pair_ineligible", "Roster pair is not eligible for activation", validation.errors);
  }
  const audit = JSON.stringify([auditEntry("activated", input.actorUserId, {
    teamRosterId: input.teamRosterId,
    councilRosterId: input.councilRosterId,
  })]);
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx, "roster_heads")}
      SET lifecycle = 'active', version = version + 1, audit_entries = audit_entries || $1::jsonb, updated_at = now()
      WHERE company_id = $2 AND lifecycle <> 'retired' AND (
        (roster_id = $3 AND version = $4) OR (roster_id = $5 AND version = $6)
      )`,
    [audit, input.companyId, input.teamRosterId, input.teamExpectedVersion, input.councilRosterId, input.councilExpectedVersion],
  );
  if (update.rowCount !== 2) {
    const current = await Promise.all([
      getRoster(ctx, input.companyId, input.teamRosterId),
      getRoster(ctx, input.companyId, input.councilRosterId),
    ]);
    throw new RosterError(409, "version_conflict", "One or both roster versions are stale; no pair was activated", { current });
  }
  return {
    validation,
    team: await getRoster(ctx, input.companyId, input.teamRosterId),
    council: await getRoster(ctx, input.companyId, input.councilRosterId),
    missionActivation: "unavailable" as const,
  };
}

function commandBody(value: unknown) {
  const body = asRecord(value);
  return { body, command: requiredString(body.command, "command") };
}

export async function executeRosterCommand(
  ctx: PluginContext,
  input: { companyId: string; actorUserId: string | null; rosterId?: string; body: unknown },
): Promise<unknown> {
  const ownerUserId = await requireOwner(ctx, input.companyId, input.actorUserId);
  const { body, command } = commandBody(input.body);
  if (command === "create") {
    return await createRoster(ctx, {
      companyId: input.companyId,
      actorUserId: ownerUserId,
      rosterId: optionalString(body.rosterId, "rosterId") ?? undefined,
      draft: parseRosterDraft(body.roster),
    });
  }
  if (command === "validate-pair") {
    return await validateRosterPair(
      ctx,
      input.companyId,
      requiredString(body.teamRosterId, "teamRosterId"),
      requiredString(body.councilRosterId, "councilRosterId"),
    );
  }
  if (command === "activate-pair") {
    return await activateRosterPair(ctx, {
      companyId: input.companyId,
      actorUserId: ownerUserId,
      teamRosterId: requiredString(body.teamRosterId, "teamRosterId"),
      teamExpectedVersion: positiveVersion(body.teamExpectedVersion, "teamExpectedVersion"),
      councilRosterId: requiredString(body.councilRosterId, "councilRosterId"),
      councilExpectedVersion: positiveVersion(body.councilExpectedVersion, "councilExpectedVersion"),
    });
  }
  const rosterId = input.rosterId ?? requiredString(body.rosterId, "rosterId");
  if (command === "revise") {
    const result = await reviseRoster(ctx, {
      companyId: input.companyId,
      rosterId,
      expectedVersion: positiveVersion(body.expectedVersion),
      actorUserId: ownerUserId,
      draft: parseRosterDraft(body.roster),
    });
    if (result.outcome === "conflict") {
      throw new RosterError(409, "version_conflict", "Roster version is stale; candidate revision remains unreferenced", result);
    }
    return result;
  }
  if (command === "suspend" || command === "retire") {
    return await transitionRoster(ctx, {
      companyId: input.companyId,
      rosterId,
      expectedVersion: positiveVersion(body.expectedVersion),
      actorUserId: ownerUserId,
      target: command === "suspend" ? "suspended" : "retired",
    });
  }
  throw new RosterError(400, "unknown_command", `Unknown roster command: ${command}`);
}

function companyIdFromRequest(input: PluginApiRequestInput): string {
  const companyId = requiredString(input.params.companyId, "companyId path parameter");
  if (companyId !== input.companyId) {
    throw new RosterError(403, "company_scope_mismatch", "Path company does not match the host-authorized company scope");
  }
  return companyId;
}

export async function handleRosterApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    const companyId = companyIdFromRequest(input);
    if (input.routeKey === "rosters-list") {
      return { status: 200, body: { rosters: await listRosters(ctx, companyId) } };
    }
    if (input.routeKey === "roster-read") {
      const rosterId = requiredString(input.params.rosterId, "rosterId");
      const roster = await getRoster(ctx, companyId, rosterId);
      if (!roster) throw new RosterError(404, "roster_not_found", "Roster not found");
      return { status: 200, body: { roster, history: await listRosterHistory(ctx, companyId, rosterId) } };
    }
    if (input.routeKey === "rosters-command" || input.routeKey === "roster-command") {
      const body = asRecord(input.body);
      const result = await executeRosterCommand(ctx, {
        companyId,
        actorUserId: input.actor.actorType === "user" ? input.actor.userId ?? null : null,
        rosterId: input.params.rosterId,
        body,
      });
      return { status: input.routeKey === "rosters-command" && body.command === "create" ? 201 : 200, body: result };
    }
    return { status: 404, body: { error: "Unknown roster route" } };
  } catch (error) {
    if (error instanceof RosterError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}

export function registerRosterBridge(ctx: PluginContext) {
  ctx.data.register("council-rosters", async (params) => {
    const companyId = requiredString(params.companyId, "companyId");
    const rosters = await listRosters(ctx, companyId);
    const rosterId = optionalString(params.rosterId, "rosterId");
    return {
      rosters,
      selected: rosterId ? await getRoster(ctx, companyId, rosterId) : null,
      history: rosterId ? await listRosterHistory(ctx, companyId, rosterId) : [],
      agents: await ctx.agents.list({ companyId, limit: 200, offset: 0 }),
      projects: await ctx.projects.list({ companyId, limit: 200, offset: 0 }),
      ownerUserId: (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? null,
      missionActivation: "unavailable",
    };
  });
  ctx.actions.register("council-roster-command", async (params, context: PluginPerformActionContext) => {
    const companyId = context.companyId;
    if (!companyId) throw new RosterError(403, "company_scope_required", "A host-authorized company scope is required");
    return await executeRosterCommand(ctx, {
      companyId,
      actorUserId: context.actor.type === "user" ? context.actor.userId : null,
      body: params,
    });
  });
}
