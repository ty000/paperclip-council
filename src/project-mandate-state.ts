import { canonicalPayloadHash } from "./mission-primitives.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionMandate } from "./missions.js";
import type { N3OpinionSlot } from "./n3-opinions.js";

export type ProjectPublication = { publisherAgentId: string; qaAgentId: string; repository: string; baseRef: string; headRefPrefix: string };
export type ProjectMandateContent = {
  enabled: boolean; ownerUserId: string; leadAgentId: string;
  teamRosterId: string; teamRevision: string; councilRosterId: string; councilRevision: string;
  n3Slots: N3OpinionSlot[]; template: Omit<MissionMandate, "objective">;
  criteriaSource: "project-defaults" | "task-document"; allowedPaths: string[];
  publication: ProjectPublication | null; operatingProfileHash: string;
  baselineRootIds: string[];
  hierarchy?: import("./hierarchy-contract.js").HierarchyPolicy;
};
export type ProjectMandate = { companyId: string; projectId: string; version: number; revisionId: string;
  authorizedBy: string; content: ProjectMandateContent };
export type ProjectMandateSnapshot = { projectId: string; revisionId: string; version: number; authorizedBy: string;
  operatingProfileHash: string; mandateHash: string; allowedPaths: string[]; publication: ProjectPublication | null;
  source: { rootIssueId: string; title: string; descriptionHash: string; taskDocumentRevisionId: string | null } };

export function projectTable(ctx: PluginContext, name: "project_mandates" | "project_task_intakes") {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe Council namespace");
  return `"${ctx.db.namespace}".${name}`;
}
type PolicyRow = { company_id: string; project_id: string; version: string | number; revision_id: string;
  authorized_by: string; content: ProjectMandateContent | string };
export function projectMandateRow(row: PolicyRow): ProjectMandate {
  return { companyId: row.company_id, projectId: row.project_id, version: Number(row.version), revisionId: row.revision_id,
    authorizedBy: row.authorized_by, content: typeof row.content === "string" ? JSON.parse(row.content) : row.content };
}
export async function readProjectMandate(ctx: PluginContext, companyId: string, projectId: string) {
  const rows = await ctx.db.query<PolicyRow>(`SELECT * FROM ${projectTable(ctx, "project_mandates")}
    WHERE company_id = $1 AND project_id = $2 ORDER BY version DESC LIMIT 1`, [companyId, projectId]);
  return rows[0] ? projectMandateRow(rows[0]) : null;
}
export async function listProjectMandates(ctx: PluginContext) {
  const rows = await ctx.db.query<PolicyRow>(`SELECT DISTINCT ON (company_id, project_id) * FROM ${projectTable(ctx, "project_mandates")}
    ORDER BY company_id, project_id, version DESC LIMIT 101`, []);
  if (rows.length > 100) throw new Error("More than 100 project mandates require an explicit intake scan plan");
  return rows.map(projectMandateRow);
}

export async function projectIssues(ctx: PluginContext, companyId: string, projectId: string) {
  const issues = await ctx.issues.list({ companyId, projectId, limit: 501, includePluginOperations: true });
  if (issues.length > 500) throw new Error("Project inventory exceeds the complete 500 issue intake bound");
  if (issues.some(issue => issue.companyId !== companyId || issue.projectId !== projectId)) throw new Error("Project inventory scope mismatch");
  return issues;
}

export function operatingProfileHash(config: Record<string, unknown>) {
  return canonicalPayloadHash(Object.fromEntries(["n1OperatingProfile", "n2RuntimeProfile", "modelVariantsEnabled", "modelProfileMapping", "workspacePreflight", "nativeWakeGuardEnabled", "nativeRunLimit", "n5PublisherPreflightEnabled"]
    .map(key => [key, config[key] ?? null])));
}
