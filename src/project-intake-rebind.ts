import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, canonicalPayloadHash } from "./mission-primitives.js";
import { projectTable, type ProjectMandate } from "./project-mandate-state.js";

type IntakeRow = { company_id: string; project_id: string; root_issue_id: string; policy_revision_id: string; mission_id: string; version: number; state: any };
export async function readTaskIntake(ctx: PluginContext, companyId: string, projectId: string, rootId: string) {
  const rows = await ctx.db.query<IntakeRow>(`SELECT * FROM ${projectTable(ctx, "project_task_intakes")} WHERE company_id = $1 AND project_id = $2 AND root_issue_id = $3`, [companyId, projectId, rootId]);
  const row = rows[0];
  return row ? { ...row, version: Number(row.version), state: typeof row.state === "string" ? JSON.parse(row.state) : row.state } : null;
}

/** Explicit owner revision change, confined to a receipt with zero preparation/effects. */
export async function rebindUnstartedTask(ctx: PluginContext, policy: ProjectMandate, ownerId: string, body: Record<string, any>) {
  const row = await readTaskIntake(ctx, policy.companyId, policy.projectId, body.rootIssueId);
  const hash = canonicalPayloadHash(body);
  const old = row?.state.policyRebindings?.find((entry: any) => entry.commandId === body.commandId);
  if (old) {
    if (old.payloadHash !== hash || old.ownerUserId !== ownerId) throw new MissionError(409, "project_rebind_identity", "Reuse the original task rebind payload and owner");
    return { outcome: "replayed", intake: row };
  }
  if (!row || row.version !== body.expectedIntakeVersion || body.policyRevisionId !== policy.revisionId || !policy.content.enabled
      || policy.authorizedBy !== ownerId || policy.content.baselineRootIds.includes(row.root_issue_id) || body.authorizeRebind !== true
      || row.state.createBody || row.state.snapshot || row.state.plan || Object.keys(row.state.commands ?? {}).length || (row.state.policyRebindings?.length ?? 0) >= 20) {
    throw new MissionError(409, "project_rebind_unavailable", "Rebind only an explicitly included, unprepared intake at its exact version; retain all existing effects", { currentVersion: row?.version ?? null });
  }
  const state = { ...row.state, policyRebindings: [...row.state.policyRebindings ?? [], { commandId: body.commandId, payloadHash: hash,
    ownerUserId: ownerId, fromRevisionId: row.policy_revision_id, toRevisionId: policy.revisionId }] };
  const result = await ctx.db.execute(`UPDATE ${projectTable(ctx, "project_task_intakes")} SET state = $1::jsonb, policy_revision_id = $2, version = version + 1, updated_at = now()
    WHERE company_id = $3 AND project_id = $4 AND root_issue_id = $5 AND version = $6 AND NOT (state ? 'createBody')`,
    [JSON.stringify(state), policy.revisionId, policy.companyId, policy.projectId, row.root_issue_id, row.version]);
  if (result.rowCount !== 1) throw new MissionError(409, "project_rebind_version", "Task intake changed concurrently; no replacement");
  return { outcome: "applied", intake: await readTaskIntake(ctx, policy.companyId, policy.projectId, row.root_issue_id) };
}
