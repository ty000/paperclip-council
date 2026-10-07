import { MissionError, canonicalPayloadHash } from "./mission-primitives.js";
import { readContinuityObservation } from "./continuity-observation.js";
import { configureContinuity } from "./continuity-configuration.js";
import type { ModelSelectionState } from "./model-state.js";
import { assertNativeRunInventory, initialNativeWakePolicy } from "./native-runs.js";
import type { NativeWakePolicy } from "./native-wake-policy.js";
import { ModelSelectionError } from "./model-state.js";
import { inspectVariant } from "./model-variants.js";
import { readWorkspacePreflightProfile, type WorkspacePreflightProfile } from "./workspace-preflight.js";
import { inspectN6 } from "./n6-state.js";
import { inspectN5 } from "./n5-state.js";
import { inspectN3 } from "./n3-state.js";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { AdmissionError } from "./admission.js";
import { executeN1BoardCommand, inspectN1State, readN1AdmissionForMission } from "./n1-missions.js";
import { executeN2BoardCommand, inspectN2State, type N2State } from "./n2-missions.js";
import {
  RosterError,
  validateRosterPair,
  type RosterSnapshot,
} from "./rosters.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RECEIPTS = 100;
const MAX_LIST_ITEMS = 50;
const N1_BOARD_COMMANDS = new Set([
  "activate",
  "start-lead",
  "prepare-n1-resume",
  "bind-resumed-lead-run",
  "fixture-bind-lead-run",
  "fixture-bind-contribution-run",
  "reconcile-lead-usage",
  "reconcile-contribution-usage",
  "recover-integration",
  "recover-candidate",
]);
const N2_BOARD_COMMANDS = new Set([
  "resume-settled-correction",
  "replace-undispatched-correction",
  "start-review",
  "start-correction",
  "start-resubmitted-review",
  "settle-n2-usage",
  "reconcile-native-n2",
  "release-native-correction",
  "reconcile-ordinary-n2",
  "replace-missing-opinion",
  "replace-missing-verdict",
  "recover-terminal-resubmission",
]);

export type MissionMandate = {
  objective: string;
  acceptanceCriteria: string[];
  commitments: string[];
  limits: {
    taskPolicy: string;
    periodPolicy: string;
    correctionLimit: number;
    elapsedMinutes: number;
  };
};

export type MissionReceipt = {
  commandId: string;
  command: "bind-resumed-lead-run" | "prepare-n1-resume" | "create" | "update-mandate" | "activate" | "start-lead" | "fixture-bind-lead-run" | "fixture-bind-contribution-run" | "plan" | "materialize" | "dispatch" | "record-contribution" | "publish" | "recover-integration" | "recover-candidate"
    | "resume-settled-correction" | "replace-undispatched-correction" | "start-review" | "confirm-review-handoff" | "start-correction" | "prepare-resubmission"
    | "start-resubmitted-review" | "settle-n2-usage" | "attest-transmission" | "reconcile-native-n2" | "release-native-correction" | "reconcile-ordinary-n2" | "replace-missing-opinion" | "replace-missing-verdict" | "recover-terminal-resubmission" | "ordinary-verdict" | "configure-continuity" | "suspend-continuity";
  actorType: "user" | "agent";
  actorId: string;
  payloadHash: string;
  appliedVersion: number;
  result: { missionId: string; version: number };
  recordedAt: string;
};

export type MissionAggregate = {
  schemaVersion: 1;
  missionId: string;
  companyId: string;
  rootIssueId: string;
  projectId: string;
  ownerUserId: string;
  mandate: MissionMandate;
  compositions: {
    status: "pinned";
    team: PinnedRoster;
    council: PinnedRoster;
  };
  responsibilities: {
    integrationLeadAgentId: string;
    finalReviewerAgentId: string;
    requiredPerspectives: string[];
  };
  phase: "draft" | "executing" | "integrating" | "ready_for_review" | "review_handoff" | "reviewing" | "correction_requested" | "correcting" | "application_unknown" | "accepted" | "blocked";
  control: { status: "inactive"; reason: "mission_not_enabled" | "candidate_ready_for_review" | "mission_accepted" } | { status: "active" } | { status: "blocked"; reason: string };
  readiness: {
    mission: "recorded";
    compositions: "pinned";
    execution: "blocked";
    blockers: MissionPrerequisite[];
  };
  journal: Array<Record<string, unknown>>;
  commandReceipts: MissionReceipt[];
  effectIntents: Array<Record<string, unknown>>;
  modelSelection?: ModelSelectionState;
  workspacePreflight?: import("./workspace-preflight.js").WorkspacePreflightProfile;
  continuity?: import("./continuity-policy.js").ContinuityPolicy;
  projectMandate?: import("./project-mandate-state.js").ProjectMandateSnapshot;
  hierarchy?: import("./hierarchy-contract.js").HierarchyState;
  nativeWakePolicy?: import("./native-wake-policy.js").NativeWakePolicy;
  n1?: Record<string, unknown>;
  n2?: N2State;
  n3?: import("./n3-state.js").N3State;
  n5?: import("./n5-state.js").N5State;
  n6?: import("./n6-state.js").N6Dependency;
};

export type PinnedRoster = {
  rosterId: string;
  revision: string;
  kind: "team" | "council";
  name: string;
  projectId: string | null;
  members: Array<{ agentId: string; responsibilities: string[] }>;
};

export type MissionPrerequisite = {
  code: string;
  status: "ready" | "pending" | "unsupported";
  message: string;
};

export type MissionRecord = {
  companyId: string;
  missionId: string;
  rootIssueId: string;
  projectId: string;
  ownerUserId: string;
  teamRosterId: string;
  teamRevision: string;
  councilRosterId: string;
  councilRevision: string;
  version: number;
  aggregate: MissionAggregate;
  createdAt: string;
  updatedAt: string;
};

type MissionRow = {
  company_id: string;
  mission_id: string;
  root_issue_id: string;
  project_id: string;
  owner_user_id: string;
  team_roster_id: string;
  team_revision: string;
  council_roster_id: string;
  council_revision: string;
  version: string | number;
  aggregate: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type CreateInput = {
  command: "create";
  commandId: string;
  missionId: string;
  rootIssueId: string;
  projectId: string;
  teamRosterId: string;
  teamRevision: string;
  councilRosterId: string;
  councilRevision: string;
  mandate: MissionMandate;
};

export { MissionError, canonicalPayloadHash } from "./mission-primitives.js";

function asRecord(value: unknown, label = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(400, "malformed_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max = 4_000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MissionError(400, "malformed_request", `${label} is required`);
  }
  const result = value.trim();
  if (result.length > max) throw new MissionError(422, "value_too_large", `${label} exceeds ${max} characters`);
  return result;
}

function uuid(value: unknown, label: string): string {
  const result = requiredString(value, label, 64);
  if (!UUID.test(result)) throw new MissionError(400, "malformed_request", `${label} must be a UUID`);
  return result;
}

function positiveInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new MissionError(400, "malformed_request", `${label} must be a positive safe integer no greater than ${max}`);
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    throw new MissionError(400, "malformed_request", `${label} must be a nonnegative bounded integer`);
  }
  return Number(value);
}

function stringList(value: unknown, label: string, maxItems = 50): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new MissionError(400, "malformed_request", `${label} must be an array of at most ${maxItems} items`);
  }
  const result = value.map((item, index) => requiredString(item, `${label}[${index}]`, 1_000));
  if (new Set(result).size !== result.length) {
    throw new MissionError(422, "duplicate_value", `${label} contains duplicate values`);
  }
  return result;
}

export function parseMissionMandate(value: unknown): MissionMandate {
  const mandate = asRecord(value, "mandate");
  const limits = asRecord(mandate.limits, "mandate.limits");
  return {
    objective: requiredString(mandate.objective, "mandate.objective"),
    acceptanceCriteria: stringList(mandate.acceptanceCriteria, "mandate.acceptanceCriteria"),
    commitments: stringList(mandate.commitments ?? [], "mandate.commitments"),
    limits: {
      taskPolicy: requiredString(limits.taskPolicy, "mandate.limits.taskPolicy", 1_000),
      periodPolicy: requiredString(limits.periodPolicy, "mandate.limits.periodPolicy", 1_000),
      correctionLimit: nonnegativeInteger(limits.correctionLimit, "mandate.limits.correctionLimit", 100),
      elapsedMinutes: positiveInteger(limits.elapsedMinutes, "mandate.limits.elapsedMinutes", 525_600),
    },
  };
}

export function parseMissionCreateInput(value: unknown): CreateInput {
  const body = asRecord(value);
  if (body.command !== "create") throw new MissionError(400, "unknown_command", "command must be create");
  return {
    command: "create",
    commandId: uuid(body.commandId, "commandId"),
    missionId: uuid(body.missionId, "missionId"),
    rootIssueId: uuid(body.rootIssueId, "rootIssueId"),
    projectId: uuid(body.projectId, "projectId"),
    teamRosterId: uuid(body.teamRosterId, "teamRosterId"),
    teamRevision: uuid(body.teamRevision, "teamRevision"),
    councilRosterId: uuid(body.councilRosterId, "councilRosterId"),
    councilRevision: uuid(body.councilRevision, "councilRevision"),
    mandate: parseMissionMandate(body.mandate),
  };
}


function namespaceTable(ctx: PluginContext, name: "missions" | "roster_heads"): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.${name}`;
}

function table(ctx: PluginContext): string {
  return namespaceTable(ctx, "missions");
}

export function missionInsertSql(ctx: PluginContext): string {
  return `INSERT INTO ${table(ctx)}
    (company_id, mission_id, root_issue_id, project_id, owner_user_id,
     team_roster_id, team_revision, council_roster_id, council_revision, aggregate)
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb
    WHERE 2 = (
      SELECT count(*) FROM (
        SELECT roster_id FROM ${namespaceTable(ctx, "roster_heads")}
        WHERE company_id = $1 AND lifecycle = 'active' AND (
          (roster_id = $6 AND published_revision = $7) OR
          (roster_id = $8 AND published_revision = $9)
        )
        FOR UPDATE
      ) AS selectable_heads
    )
    ON CONFLICT DO NOTHING`;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Invalid timestamp from mission store");
  return date.toISOString();
}

function parseMissionRow(row: MissionRow): MissionRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid mission version");
  const aggregate = asRecord(row.aggregate, "stored mission aggregate") as MissionAggregate;
  if (aggregate.schemaVersion !== 1 || !Array.isArray(aggregate.commandReceipts)) {
    throw new Error("Unsupported mission aggregate");
  }
  return {
    companyId: row.company_id,
    missionId: row.mission_id,
    rootIssueId: row.root_issue_id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    teamRosterId: row.team_roster_id,
    teamRevision: row.team_revision,
    councilRosterId: row.council_roster_id,
    councilRevision: row.council_revision,
    version,
    aggregate,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

const selectColumns = `company_id, mission_id, root_issue_id, project_id, owner_user_id,
  team_roster_id, team_revision, council_roster_id, council_revision,
  version, aggregate, created_at, updated_at`;

export async function getMission(ctx: PluginContext, companyId: string, missionId: string): Promise<MissionRecord | null> {
  const rows = await ctx.db.query<MissionRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1 AND mission_id = $2`,
    [companyId, missionId],
  );
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

async function getMissionByIdentity(
  ctx: PluginContext,
  companyId: string,
  missionId: string,
  rootIssueId: string,
) {
  const rows = await ctx.db.query<MissionRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)}
      WHERE company_id = $1 AND (mission_id = $2 OR root_issue_id = $3)
      ORDER BY CASE WHEN mission_id = $2 THEN 0 ELSE 1 END
      LIMIT 1`,
    [companyId, missionId, rootIssueId],
  );
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

export async function getMissionByRootIssue(
  ctx: PluginContext,
  companyId: string,
  rootIssueId: string,
): Promise<MissionRecord | null> {
  const rows = await ctx.db.query<MissionRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1 AND root_issue_id = $2`,
    [companyId, rootIssueId],
  );
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

/** Only exact persisted N1 operational/leaf bindings, with ambiguity retained. */
export async function getMissionByN1Issue(ctx: PluginContext, companyId: string, issueId: string): Promise<MissionRecord | null> {
  const rows = await ctx.db.query<MissionRow>(`SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1
    AND (aggregate->'n1'->'coordination'->>'issueId' = $2 OR aggregate->'n1'->'contributions' @> $3::jsonb) LIMIT 2`,
    [companyId, issueId, JSON.stringify([{ childIssueId: issueId }])]);
  if (rows.length > 1) throw new MissionError(409, "n1_task_ambiguous", "N1 task must belong to one mission");
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

/** Exact source lookup for event recovery; no bounded dashboard list or new scheduler. */
export async function getMissionsDependingOn(ctx: PluginContext, companyId: string, sourceMissionId: string): Promise<MissionRecord[]> {
  const rows = await ctx.db.query<MissionRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1 AND aggregate->'n6'->>'sourceMissionId' = $2`,
    [companyId, sourceMissionId],
  );
  return rows.map(parseMissionRow);
}

export async function listMissions(ctx: PluginContext, companyId: string): Promise<MissionRecord[]> {
  const rows = await ctx.db.query<MissionRow>(
    `SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1 ORDER BY updated_at DESC, mission_id LIMIT ${MAX_LIST_ITEMS}`,
    [companyId],
  );
  return rows.map(parseMissionRow);
}

/** Dedicated bounded scan: dashboard truncation cannot starve older delegated missions. */
export async function listContinuityMissions(ctx: PluginContext): Promise<MissionRecord[]> {
  const rows = await ctx.db.query<MissionRow>(`SELECT ${selectColumns} FROM ${table(ctx)}
    WHERE aggregate->'continuity'->>'enabled' = 'true' ORDER BY company_id, mission_id LIMIT 201`, []);
  if (rows.length > 200) throw new MissionError(409, "continuity_scan_bound", "More than 200 delegated missions require an explicit scan plan; no truncated progression");
  return rows.map(parseMissionRow);
}

/** Coordination roles own separate parentless tasks; resolve their exact persisted binding. */
export async function getMissionByN6WorkIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<MissionRecord | null> {
  const rows = await ctx.db.query<MissionRow>(`SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1
    AND aggregate->'n6'->'coordination'->'tasks' @> $2::jsonb LIMIT 2`, [companyId, JSON.stringify([{ issueId }])]);
  if (rows.length > 1) throw new MissionError(409, "n6_work_ambiguous", "Coordination task must belong to one mission");
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

/** Exact persisted task lookup; parentless tasks cannot use issue ancestry. */
export async function getMissionByOrdinaryIssue(ctx: PluginContext, companyId: string, issueId: string): Promise<MissionRecord | null> {
  const rows = await ctx.db.query<MissionRow>(`SELECT ${selectColumns} FROM ${table(ctx)} WHERE company_id = $1
    AND aggregate->'n2'->'ordinary' IS NOT NULL
    AND (aggregate->'n2'->'ordinary'->'tasks' @> $2::jsonb OR aggregate->'n5'->'publication'->>'issueId' = $3) LIMIT 2`, [companyId, JSON.stringify([{ issueId }]), issueId]);
  if (rows.length > 1) throw new MissionError(409, "ordinary_task_ambiguous", "Task is bound to multiple Council missions");
  return rows[0] ? parseMissionRow(rows[0]) : null;
}

function pinRoster(roster: RosterSnapshot): PinnedRoster {
  return {
    rosterId: roster.head.rosterId,
    revision: roster.revision.revision,
    kind: roster.revision.kind,
    name: roster.revision.name,
    projectId: roster.revision.projectId,
    members: roster.revision.content.members.map((member) => ({
      agentId: member.agentId,
      responsibilities: [...member.responsibilities],
    })),
  };
}

export function missionPrerequisites(): MissionPrerequisite[] {
  return [
    { code: "mission_recorded", status: "ready", message: "Mission state is recorded in plugin-private storage." },
    { code: "compositions_pinned", status: "ready", message: "Exact immutable team and council revisions are pinned." },
    { code: "native_review_path", status: "pending", message: "Native review handoff is not implemented in this Step A mission slice." },
    { code: "decision_reconciliation", status: "unsupported", message: "G3 uncertain-decision canonical readback remains unqualified." },
    { code: "runtime_budget_exposure", status: "unsupported", message: "G4 task/period reservation and in-flight exposure remain unqualified; dispatch is disabled." },
  ];
}

export function buildMissionAggregate(input: {
  create: CreateInput;
  companyId: string;
  ownerUserId: string;
  team: RosterSnapshot;
  council: RosterSnapshot;
  payloadHash: string;
  at: string;
}): MissionAggregate {
  const integrationLeadAgentId = input.team.revision.content.integrationLeadAgentId;
  const finalReviewerAgentId = input.council.revision.content.finalReviewerAgentId;
  if (!integrationLeadAgentId || !finalReviewerAgentId) throw new Error("Validated rosters lack accountable roles");
  const receipt: MissionReceipt = {
    commandId: input.create.commandId,
    command: "create",
    actorType: "user",
    actorId: input.ownerUserId,
    payloadHash: input.payloadHash,
    appliedVersion: 1,
    result: { missionId: input.create.missionId, version: 1 },
    recordedAt: input.at,
  };
  return {
    schemaVersion: 1,
    missionId: input.create.missionId,
    companyId: input.companyId,
    rootIssueId: input.create.rootIssueId,
    projectId: input.create.projectId,
    ownerUserId: input.ownerUserId,
    mandate: input.create.mandate,
    compositions: { status: "pinned", team: pinRoster(input.team), council: pinRoster(input.council) },
    responsibilities: {
      integrationLeadAgentId,
      finalReviewerAgentId,
      requiredPerspectives: [...input.council.revision.content.requiredPerspectives],
    },
    phase: "draft",
    control: { status: "inactive", reason: "mission_not_enabled" },
    readiness: {
      mission: "recorded",
      compositions: "pinned",
      execution: "blocked",
      blockers: missionPrerequisites(),
    },
    journal: [{ action: "mission_recorded", actorUserId: input.ownerUserId, at: input.at }],
    commandReceipts: [receipt],
    effectIntents: [],
  };
}

async function configuredOwner(ctx: PluginContext, companyId: string): Promise<string> {
  const company = await ctx.companies.get(companyId);
  if (!company || company.id !== companyId) throw new MissionError(404, "company_not_found", "Company not found");
  if (!company.defaultResponsibleUserId) {
    throw new MissionError(422, "owner_not_configured", "Company default responsible user must be configured before mission mutation");
  }
  return company.defaultResponsibleUserId;
}

async function requireOwner(ctx: PluginContext, companyId: string, actorUserId: string | null): Promise<string> {
  const ownerUserId = await configuredOwner(ctx, companyId);
  if (!actorUserId || actorUserId !== ownerUserId) {
    throw new MissionError(403, "owner_required", "Only the configured company owner can mutate Council missions");
  }
  return ownerUserId;
}

function findReceipt(mission: MissionRecord, commandId: string) {
  return mission.aggregate.commandReceipts.find((receipt) => receipt.commandId === commandId);
}

function replayOrConflict(mission: MissionRecord, commandId: string, actorId: string, payloadHash: string) {
  const receipt = findReceipt(mission, commandId);
  if (!receipt) return null;
  if (receipt.actorId !== actorId || receipt.payloadHash !== payloadHash) {
    throw new MissionError(409, "command_identity_conflict", "commandId was already used by another actor or payload");
  }
  return { outcome: "replayed" as const, mission, receipt };
}

function existingCreationResult(mission: MissionRecord, commandId: string, actorId: string, payloadHash: string) {
  const replay = replayOrConflict(mission, commandId, actorId, payloadHash);
  if (replay) return replay;
  throw new MissionError(409, "mission_exists", "A mission already exists for this mission ID or root issue", {
    missionId: mission.missionId,
    rootIssueId: mission.rootIssueId,
  });
}

export async function createMission(ctx: PluginContext, companyId: string, actorUserId: string | null, body: unknown) {
  const ownerUserId = await requireOwner(ctx, companyId, actorUserId);
  const create = parseMissionCreateInput(body);
  const payloadHash = canonicalPayloadHash(create);
  const existing = await getMissionByIdentity(ctx, companyId, create.missionId, create.rootIssueId);
  if (existing) return existingCreationResult(existing, create.commandId, ownerUserId, payloadHash);
  let team: RosterSnapshot;
  let council: RosterSnapshot;
  let useVariants = false;
  let workspacePreflight: WorkspacePreflightProfile | undefined;
  let nativeWakePolicy: NativeWakePolicy | undefined;
  try {
    const issue = await ctx.issues.get(create.rootIssueId, companyId);
    if (!issue || issue.companyId !== companyId) throw new MissionError(404, "root_issue_not_found", "Root issue not found in this company");
    if (issue.parentId) throw new MissionError(422, "root_issue_required", "Mission issue must be a root issue");
    if (issue.projectId !== create.projectId) throw new MissionError(422, "project_scope_mismatch", "Mission project must match the root issue project");
    const project = await ctx.projects.get(create.projectId, companyId);
    if (!project || project.companyId !== companyId || project.archivedAt) {
      throw new MissionError(422, "project_incompatible", "Mission project is unavailable or belongs to another company");
    }
    const validation = await validateRosterPair(ctx, companyId, create.teamRosterId, create.councilRosterId);
    if (!validation.eligible) throw new MissionError(422, "roster_pair_ineligible", "Roster pair is not eligible", validation.errors);
    if (validation.team.head.lifecycle !== "active" || validation.council.head.lifecycle !== "active") {
      throw new MissionError(409, "active_rosters_required", "New missions require active team and council roster heads");
    }
    if (validation.team.head.publishedRevision !== create.teamRevision
        || validation.council.head.publishedRevision !== create.councilRevision) {
      throw new MissionError(409, "roster_revision_not_current", "New missions must select the current published active revisions");
    }
    for (const roster of [validation.team, validation.council]) {
      if (roster.revision.projectId && roster.revision.projectId !== create.projectId) {
        throw new MissionError(422, "project_scope_mismatch", "Roster project restriction does not match the mission project");
      }
    }
    team = validation.team;
    council = validation.council;
    const variantConfig = await ctx.config.get(companyId);
    useVariants = variantConfig.modelVariantsEnabled === true && variantConfig.n2RuntimeProfile === "ordinary-cli-v1";
    workspacePreflight = readWorkspacePreflightProfile(variantConfig.workspacePreflight);
    if (workspacePreflight && !useVariants) {
      throw new MissionError(422, "workspace_preflight_profile_incompatible", "Workspace preflight requires fixed variants and the ordinary CLI runtime");
    }
    if (useVariants) {
      const ids = new Set([...team.revision.content.members, ...council.revision.content.members].map(member => member.agentId));
      for (const agentId of ids) {
        const variant = await inspectVariant(ctx, companyId, agentId, "sol-medium", "1");
        if (!variant.ready || variant.logicalAgentId !== agentId) throw new ModelSelectionError("model_roster_ineligible", "Prepare compatible catalogue anchors before creating an opted-in mission", variant);
        const role = variant.roleKey;
        const compatible = agentId === team.revision.content.integrationLeadAgentId ? role === "lead"
          : agentId === council.revision.content.finalReviewerAgentId ? role === "generalist-reviewer"
          : team.revision.content.members.some(member => member.agentId === agentId)
            ? ["executor", "contributor-1", "contributor-2", "test", "design"].includes(role ?? "")
            : Boolean(role?.endsWith("-reviewer") && role !== "generalist-reviewer");
        if (!compatible) throw new ModelSelectionError("model_roster_role_mismatch", "Catalogue role must match the structured roster responsibility", { agentId, role });
      }
    }
    if (variantConfig.n2RuntimeProfile === "ordinary-cli-v1" && variantConfig.nativeWakeGuardEnabled !== false) {
      nativeWakePolicy = await initialNativeWakePolicy(ctx, companyId, create.rootIssueId, variantConfig.nativeRunLimit);
    }
  } catch (error) {
    let appeared: MissionRecord | null = null;
    try {
      appeared = await getMissionByIdentity(ctx, companyId, create.missionId, create.rootIssueId);
    } catch {
      throw error;
    }
    if (appeared) return existingCreationResult(appeared, create.commandId, ownerUserId, payloadHash);
    throw error;
  }
  const at = new Date().toISOString();
  const aggregate = buildMissionAggregate({ create, companyId, ownerUserId, team, council, payloadHash, at });
  if (useVariants) {
    aggregate.modelSelection = { protocol: "native-variants-v1", choices: [], tasks: [] };
  }
  if (workspacePreflight) aggregate.workspacePreflight = workspacePreflight;
  if (nativeWakePolicy) aggregate.nativeWakePolicy = nativeWakePolicy;
  const insert = await ctx.db.execute(
    missionInsertSql(ctx),
    [companyId, create.missionId, create.rootIssueId, create.projectId, ownerUserId,
      create.teamRosterId, create.teamRevision, create.councilRosterId, create.councilRevision,
      JSON.stringify(aggregate)],
  );
  const mission = await getMissionByIdentity(ctx, companyId, create.missionId, create.rootIssueId);
  if (!mission) {
    throw new MissionError(
      409,
      "roster_selection_changed",
      "Team or council selection changed before the mission could be recorded; retry from current active revisions",
    );
  }
  if (insert.rowCount === 1) return { outcome: "applied" as const, mission, receipt: mission.aggregate.commandReceipts[0] };
  return existingCreationResult(mission, create.commandId, ownerUserId, payloadHash);
}

async function updateMandate(
  ctx: PluginContext,
  companyId: string,
  missionId: string,
  actorUserId: string | null,
  body: Record<string, unknown>,
) {
  const ownerUserId = await requireOwner(ctx, companyId, actorUserId);
  const commandId = uuid(body.commandId, "commandId");
  const expectedVersion = positiveInteger(body.expectedVersion, "expectedVersion");
  const mandate = parseMissionMandate(body.mandate);
  const normalized = { command: "update-mandate", commandId, missionId, expectedVersion, mandate };
  const payloadHash = canonicalPayloadHash(normalized);
  const before = await getMission(ctx, companyId, missionId);
  if (!before) throw new MissionError(404, "mission_not_found", "Mission not found");
  const replay = replayOrConflict(before, commandId, ownerUserId, payloadHash);
  if (replay) return replay;
  if (before.version !== expectedVersion) {
    throw new MissionError(409, "version_conflict", "Mission version is stale", { currentVersion: before.version });
  }
  if (before.aggregate.commandReceipts.length >= MAX_RECEIPTS) {
    throw new MissionError(409, "command_limit_reached", `Mission command receipt limit of ${MAX_RECEIPTS} is reached`);
  }
  const at = new Date().toISOString();
  const nextVersion = expectedVersion + 1;
  const receipt: MissionReceipt = {
    commandId,
    command: "update-mandate",
    actorType: "user",
    actorId: ownerUserId,
    payloadHash,
    appliedVersion: nextVersion,
    result: { missionId, version: nextVersion },
    recordedAt: at,
  };
  const next: MissionAggregate = {
    ...before.aggregate,
    mandate,
    journal: [...before.aggregate.journal, { action: "mandate_updated", actorUserId: ownerUserId, at }],
    commandReceipts: [...before.aggregate.commandReceipts, receipt],
  };
  const update = await ctx.db.execute(
    `UPDATE ${table(ctx)} SET aggregate = $1::jsonb, version = version + 1, updated_at = now()
      WHERE company_id = $2 AND mission_id = $3 AND version = $4`,
    [JSON.stringify(next), companyId, missionId, expectedVersion],
  );
  const mission = await getMission(ctx, companyId, missionId);
  if (!mission) throw new Error("Mission disappeared after CAS");
  if (update.rowCount === 1) return { outcome: "applied" as const, mission, receipt };
  const concurrentReplay = replayOrConflict(mission, commandId, ownerUserId, payloadHash);
  if (concurrentReplay) return concurrentReplay;
  throw new MissionError(409, "version_conflict", "Mission version changed concurrently", { currentVersion: mission.version });
}

export async function executeMissionCommand(ctx: PluginContext, input: {
  companyId: string;
  missionId?: string;
  actorUserId: string | null;
  body: unknown;
}) {
  const body = asRecord(input.body);
  if (body.command === "create" && !input.missionId) {
    return await createMission(ctx, input.companyId, input.actorUserId, body);
  }
  if (body.command === "update-mandate" && input.missionId) {
    return await updateMandate(ctx, input.companyId, input.missionId, input.actorUserId, body);
  }
  throw new MissionError(400, "unknown_command", "Unsupported mission command for this route");
}

function companyIdFromRequest(input: PluginApiRequestInput): string {
  const companyId = requiredString(input.params.companyId, "companyId path parameter", 64);
  if (companyId !== input.companyId) {
    throw new MissionError(403, "company_scope_mismatch", "Path company does not match the host-authorized company scope");
  }
  return companyId;
}

export function inspectMission(mission: MissionRecord) {
  const n1 = inspectN1State(mission);
  const n2 = inspectN2State(mission);
  return {
    mission,
    state: {
      recorded: true,
      compositionsPinned: true,
      executable: mission.aggregate.control.status === "active",
    },
    prerequisites: n1?.prerequisites ?? mission.aggregate.readiness.blockers,
    nextAction: (mission.aggregate.n6 && !mission.aggregate.n1?.rootDispatchState ? inspectN6(mission)?.nextAction : undefined) ?? n2?.nextAction.label ?? n1?.nextAction ?? "Resolve and qualify G4 before adding any dispatch or activation command.",
    n1,
    n2,
    n3: inspectN3(mission),
    n5: inspectN5(mission),
    n6: inspectN6(mission),
  };
}

async function inspectMissionWithAdmission(ctx: PluginContext, mission: MissionRecord) {
  return { ...inspectMission(mission), admission: await readN1AdmissionForMission(ctx, mission) };
}

async function executeMissionRouteCommand(
  ctx: PluginContext,
  input: PluginApiRequestInput,
  companyId: string,
  actorUserId: string | null,
  body: Record<string, unknown>,
  missionId: string | undefined,
) {
  const command = String(body.command);
  if (missionId && ["configure-continuity", "suspend-continuity"].includes(command)) {
    const ownerId = await requireOwner(ctx, companyId, actorUserId);
    const mission = await getMission(ctx, companyId, missionId);
    if (!mission || mission.ownerUserId !== ownerId) throw new MissionError(403, "mission_owner_required", "Exact mission owner required");
    return configureContinuity(ctx, mission, ownerId, body);
  }
  if (missionId && command === "reconcile-native-runs") {
    await requireOwner(ctx, companyId, actorUserId);
    const mission = await getMission(ctx, companyId, missionId);
    if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
    await assertNativeRunInventory(ctx, mission);
    return { outcome: "reconciled", mission };
  }
  if (missionId && N1_BOARD_COMMANDS.has(command)) {
    return executeN1BoardCommand(ctx, { companyId, missionId, actorUserId, body });
  }
  if (missionId && N2_BOARD_COMMANDS.has(command)) {
    return executeN2BoardCommand(ctx, { companyId, missionId, actorUserId, body });
  }
  return executeMissionCommand(ctx, { companyId, missionId, actorUserId, body: input.body });
}

export async function handleMissionApi(input: PluginApiRequestInput, ctx: PluginContext) {
  try {
    const companyId = companyIdFromRequest(input);
    const actorUserId = input.actor.actorType === "user" ? input.actor.userId ?? null : null;
    if (input.routeKey === "missions-list") {
      await requireOwner(ctx, companyId, actorUserId);
      const missions = await listMissions(ctx, companyId);
      return { status: 200, body: { missions: await Promise.all(missions.map((mission) => inspectMissionWithAdmission(ctx, mission))) } };
    }
    if (input.routeKey === "mission-read") {
      await requireOwner(ctx, companyId, actorUserId);
      const missionId = uuid(input.params.missionId, "missionId");
      const mission = await getMission(ctx, companyId, missionId);
      if (!mission) throw new MissionError(404, "mission_not_found", "Mission not found");
      return { status: 200, body: { ...await inspectMissionWithAdmission(ctx, mission),
        continuity: await readContinuityObservation(ctx, mission) } };
    }
    if (input.routeKey === "missions-command" || input.routeKey === "mission-command") {
      const body = asRecord(input.body);
      const missionId = input.params.missionId ? uuid(input.params.missionId, "missionId") : undefined;
      const result = await executeMissionRouteCommand(ctx, input, companyId, actorUserId, body, missionId);
      const creating = input.routeKey === "missions-command" && asRecord(input.body).command === "create";
      return { status: creating && result.outcome === "applied" ? 201 : 200, body: { ...result, inspection: await inspectMissionWithAdmission(ctx, result.mission) } };
    }
    return { status: 404, body: { error: "Unknown mission route" } };
  } catch (error) {
    if (error instanceof MissionError || error instanceof RosterError || error instanceof AdmissionError) {
      return { status: error.status, body: { error: error.message, code: error.code, details: error.details } };
    }
    throw error;
  }
}
