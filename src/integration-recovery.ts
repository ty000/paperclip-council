import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, getMission, MissionError, type MissionRecord } from "./missions.js";
import { integratedResult } from "./integration-contract.js";
import { n2CommandCas, runtimeUuid } from "./n2-missions.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { assertN6SourceAccounting } from "./n6-accounting.js";

/** A recorded assessment is consumed only while its native revision and independent result remain exact. */
export async function assertIntegrationRecoveryStable(ctx: PluginContext, m: MissionRecord) {
  const recovery = m.aggregate.n5?.integration?.recovery;
  if (!recovery) return;
  const source = await getMission(ctx, m.companyId, recovery.missionId);
  const doc = await ctx.issues.documents.get(m.rootIssueId, `council-recovery-${m.missionId}`, m.companyId);
  if (!source || source.projectId !== m.projectId || source.ownerUserId !== recovery.authorizedBy || source.aggregate.n5?.integration?.recovery
      || canonicalPayloadHash(integratedResult(source)) !== canonicalPayloadHash(recovery.result)
      || doc?.id !== recovery.documentId || doc.latestRevisionId !== recovery.revisionId || canonicalPayloadHash(doc.body) !== recovery.bodyHash) {
    throw new MissionError(409, "integration_recovery_changed", "Retain the exact independent recovery and native original-criteria assessment before consuming it");
  }
  await assertN6SourceAccounting(ctx, source);
}

/** Recovery is a separately accepted/integrated mission; rollback alone cannot complete original work. */
export async function reconcileIntegrationRecovery(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const n5 = m.aggregate.n5, i = n5?.integration;
  if (!i?.report?.integratedCommit || i.state !== "failed" || i.recovery || !n5!.publication?.settledAt
      || !["correction", "rollback"].includes(String(body.mode))) throw new MissionError(409, "integration_recovery_scope", "One owner-authorized recovery of a settled failed integration is supported; no repeated merge");
  await assertProjectDeparture(ctx, m);
  const { recovery, result } = await readRecoveryResult(ctx, m, body, actorId);
  const { doc, evidence } = await readRecoveryEvidence(ctx, m, body, i.reportHash, result.reportHash);
  const criteria = m.aggregate.mandate.acceptanceCriteria;
  const originalCriteriaVerified = evidence.criteria.length === criteria.length && criteria.every(criterion => evidence.criteria.some(c => c.criterion === criterion));
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n5: { ...n5!, integration: { ...i,
    recovery: { missionId: recovery.missionId, result, authorizedBy: actorId, mode: body.mode as "correction" | "rollback",
      documentId: doc.id, revisionId: doc.latestRevisionId!, bodyHash: canonicalPayloadHash(doc.body), originalCriteriaVerified } } } });
}

async function readRecoveryEvidence(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, originalReportHash: string | undefined, recoveryReportHash: string) {
  const doc = await ctx.issues.documents.get(m.rootIssueId, `council-recovery-${m.missionId}`, m.companyId);
  let evidence: { originalReportHash: string; recoveryReportHash: string; criteria: Array<{ criterion: string; evidenceRefs: string[] }> };
  try { evidence = JSON.parse(doc?.body ?? ""); } catch { throw new MissionError(409, "integration_recovery_document", "Native recovery assessment must pin both result proofs and remaining original criteria"); }
  if (!doc?.latestRevisionId || doc.latestRevisionId !== body.documentRevisionId || evidence.originalReportHash !== originalReportHash
      || evidence.recoveryReportHash !== recoveryReportHash || !Array.isArray(evidence.criteria) || evidence.criteria.length > 32
      || evidence.criteria.some(c => !c || typeof c.criterion !== "string" || !Array.isArray(c.evidenceRefs) || !c.evidenceRefs.length
        || c.evidenceRefs.length > 20 || c.evidenceRefs.some(r => typeof r !== "string" || !r.trim() || r.length > 1000))
      || new Set(evidence.criteria.map(c => c.criterion)).size !== evidence.criteria.length) throw new MissionError(409, "integration_recovery_evidence", "Exact bounded evidence of the recovery and original obligations is required");
  return { doc, evidence };
}

async function readRecoveryResult(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const n5 = m.aggregate.n5!, i = n5.integration!;
  const recovery = await getMission(ctx, m.companyId, runtimeUuid(body.recoveryMissionId, "recoveryMissionId"));
  if (!recovery || recovery.companyId !== m.companyId || recovery.projectId !== m.projectId || recovery.ownerUserId !== actorId
      || recovery.missionId === m.missionId || recovery.aggregate.n5?.integration?.recovery) throw new MissionError(409, "integration_recovery_identity", "A different explicitly authorized same-company/project recovery mission is required");
  await assertProjectDeparture(ctx, recovery); await assertN6SourceAccounting(ctx, recovery);
  const result = integratedResult(recovery);
  if (result.repository !== n5!.authority.repository || result.baseRef !== n5!.authority.baseRef || result.url === i.report!.url
      || recovery.aggregate.n5!.publication!.submission.baseCommit !== i.report!.integratedCommit) throw new MissionError(409, "integration_recovery_base", "A separately reviewed PR based on the failed integrated commit and same repository/base is required");
  return { recovery, result };
}
