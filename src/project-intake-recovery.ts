import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, canonicalPayloadHash } from "./mission-primitives.js";
import { operatingProfileHash, projectTable, type ProjectMandate } from "./project-mandate-state.js";
import { readTaskIntake } from "./project-intake-rebind.js";

type RecoveryState = { repositoryHold?: { status: "held" | "released" }; questions?: Record<string, unknown> };

/** A question's confirmed flag acknowledges publication, never an owner decision.
 * Existing occupied intakes without the new marker are held as well. */
export function repositoryIntakeHeld(state: RecoveryState) {
  return state.repositoryHold ? state.repositoryHold.status === "held" : Boolean(state.questions?.repository_occupied);
}

/** Owner authorization only releases the retained request for the existing job.
 * The next pass repeats normal source/admission checks under its original IDs. */
export async function resumeRepositoryIntake(ctx: PluginContext, policy: ProjectMandate, ownerId: string, body: Record<string, any>) {
  if (policy.authorizedBy !== ownerId || !policy.content.enabled
      || (await ctx.companies.get(policy.companyId))?.defaultResponsibleUserId !== ownerId
      || operatingProfileHash(await ctx.config.get(policy.companyId)) !== policy.content.operatingProfileHash) {
    throw new MissionError(403, "project_resume_authority", "The current owner and unchanged enabled operating mandate must authorize recovery");
  }
  const row = await readTaskIntake(ctx, policy.companyId, policy.projectId, body.rootIssueId);
  if (!row || row.company_id !== policy.companyId || row.project_id !== policy.projectId || row.root_issue_id !== body.rootIssueId) {
    throw new MissionError(404, "project_intake_missing", "The exact retained project intake is required");
  }
  const hash = canonicalPayloadHash(body), history = row.state.repositoryResumptions ?? [];
  const prior = history.find((entry: any) => entry.commandId === body.commandId);
  if (prior) {
    if (prior.payloadHash !== hash || prior.ownerUserId !== ownerId) throw new MissionError(409, "project_resume_identity", "Retain the original recovery command payload and owner");
    return { outcome: "replayed", intake: row };
  }
  if (!repositoryIntakeHeld(row.state) || row.version !== body.expectedIntakeVersion
      || row.policy_revision_id !== policy.revisionId || body.policyRevisionId !== policy.revisionId
      || body.authorizeResume !== true || history.length >= 20) {
    throw new MissionError(409, "project_resume_unavailable", "Explicit recovery requires the original occupied intake at its current version and pinned policy", { currentVersion: row.version });
  }
  const state = { ...row.state, repositoryHold: { ...row.state.repositoryHold, status: "released" },
    repositoryResumptions: [...history, { commandId: body.commandId, payloadHash: hash, ownerUserId: ownerId,
      policyRevisionId: policy.revisionId, resumedAt: new Date().toISOString(), heldIntakeVersion: row.version }] };
  const result = await ctx.db.execute(`UPDATE ${projectTable(ctx, "project_task_intakes")} SET state = $1::jsonb, version = version + 1, updated_at = now()
    WHERE company_id = $2 AND project_id = $3 AND root_issue_id = $4 AND version = $5 AND policy_revision_id = $6`,
    [JSON.stringify(state), policy.companyId, policy.projectId, row.root_issue_id, row.version, policy.revisionId]);
  if (result.rowCount !== 1) throw new MissionError(409, "project_resume_version", "Original intake changed concurrently; read its retained state before recovery");
  return { outcome: "applied", intake: await readTaskIntake(ctx, policy.companyId, policy.projectId, row.root_issue_id) };
}
