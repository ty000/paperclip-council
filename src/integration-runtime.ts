import { randomUUID } from "node:crypto";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError } from "./mission-primitives.js";
import { getMission, type MissionRecord } from "./missions.js";
import { n2Cas, n2CommandCas, runtimeReceipt, runtimeUuid } from "./n2-missions.js";
import { bindPublisher, resumeN5Creation } from "./n5-runtime.js";
import { acceptedN5Submission } from "./n5-preflight.js";
import { assertCurrentN5Plan, observeN5Native } from "./n5-native.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { assertContinuityDeparture } from "./continuity-policy.js";
import { assertNativeRunInventory } from "./native-runs.js";
import { validateGithubFeedback, githubFeedbackStates } from "./pr-contract.js";
import { integratedResult, validateIntegrationReport, integrationReportState } from "./integration-contract.js";

export async function startIntegratedDelivery(ctx: PluginContext, m: MissionRecord) {
  const n5 = m.aggregate.n5!, p = n5.publication!;
  if (n5.integration) return m;
  await assertProjectDeparture(ctx, m); assertContinuityDeparture(m);
  if (!n5.authority.contract?.integration || !p.settledAt || !p.observation?.matchesCandidate || p.observation.state !== "open") {
    throw new MissionError(409, "integration_admission", "Explicit integration authority and settled exact PR required");
  }
  const candidate = acceptedN5Submission(m);
  if (canonicalPayloadHash(candidate) !== canonicalPayloadHash(p.submission)) throw new MissionError(409, "integration_candidate_changed", "Fresh independent review is required for a changed candidate");
  m = await n2Cas(ctx, m, { ...m.aggregate, n5: { ...n5,
    integration: { previousPublication: structuredClone(p), state: "pending" },
    publication: { operation: "integrate", targetUrl: p.observation.url, intentId: randomUUID(), submission: candidate,
      issueId: null, runId: null, reservationId: randomUUID(), settlementCommandId: randomUUID(),
      createdAt: new Date().toISOString(), creation: "preparing", wake: "pending", state: "pending" } } });
  // The existing publisher creation/admission/wake owns this new, bounded run.
  return resumeN5Creation(ctx, m);
}

async function claimMerge(ctx: PluginContext, m: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const n5 = m.aggregate.n5!, p = n5.publication!, integration = n5.integration!;
  if (integration.mergeClaimedAt) throw new MissionError(409, "merge_effect_claimed", "Original merge intent was consumed; read back this PR, never merge again");
  await assertProjectDeparture(ctx, m); assertContinuityDeparture(m); await assertNativeRunInventory(ctx, m);
  await assertCurrentN5Plan(ctx, m);
  if (canonicalPayloadHash(acceptedN5Submission(m)) !== canonicalPayloadHash(p.submission)) throw new MissionError(409, "integration_candidate_changed", "Candidate or review revision changed before merge");
  const previous = { ...m, aggregate: { ...m.aggregate, n5: { ...n5, publication: integration.previousPublication } } };
  const observation = await observeN5Native(ctx, previous);
  if (!observation.matchesCandidate || observation.state !== "open" || observation.draft || observation.url !== p.targetUrl) throw new MissionError(409, "integration_native_head", "Fresh exact native open PR required before consuming merge authority");
  const before = validateIntegrationReport(m, body.integrationReport, input.actor.runId!);
  if (before.state !== "open" || before.baseContainsIntegrated) throw new MissionError(409, "integration_premerge", "Exact unmerged PR and immutable source base required");
  const feedbackMission = { ...m, aggregate: { ...m.aggregate, n5: { ...n5, publication: { ...p, claimedAt: p.createdAt } } } };
  const feedback = validateGithubFeedback(feedbackMission, body.feedbackReport, input.actor, observation);
  const states = githubFeedbackStates(n5.authority.contract!, feedback);
  if (states.checks !== "passed" || states.reviews !== "approved") throw new MissionError(409, "integration_review_pending", "Fresh exact-head checks and independent approval required");
  const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate, n5: { ...n5,
    publication: { ...p, claimedAt: new Date().toISOString(), state: "unknown", feedbackReport: feedback },
    integration: { ...integration, state: "unknown", mergeClaimedAt: new Date().toISOString(), mergeCommandId: String(body.commandId) } } });
  return { ...result, effectPermission: result.outcome === "applied" ? "execute" : "none" };
}

export async function handleIntegrationAgent(ctx: PluginContext, initial: MissionRecord, input: PluginApiRequestInput, body: Record<string, unknown>) {
  const m = await bindPublisher(ctx, initial, input), n5 = m.aggregate.n5!, p = n5.publication!;
  if (p.operation !== "integrate" || !n5.integration || !n5.authority.contract?.integration) throw new MissionError(403, "integration_scope", "Historical publication contracts do not delegate merge authority");
  const prior = runtimeReceipt(m, runtimeUuid(body.commandId, "commandId"), input.actor.agentId!, canonicalPayloadHash(body));
  if (prior) return { outcome: "replayed", effectPermission: "none", mission: m, receipt: prior };
  if (body.command === "n5-claim-merge") return claimMerge(ctx, m, input, body);
  if (!n5.integration.mergeClaimedAt) throw new MissionError(409, "integration_intent_required", "Retain the original claimed merge intent before reconciliation");
  const report = validateIntegrationReport(m, body.integrationReport, input.actor.runId!);
  if (Date.parse(report.observedAt) < Date.parse(n5.integration.mergeClaimedAt)) throw new MissionError(409, "integration_old_report", "Read back after the merge claim");
  if (n5.integration.report?.integratedCommit && n5.integration.report.integratedCommit !== report.integratedCommit) throw new MissionError(409, "integration_commit_changed", "Retain the originally observed merge commit; recovery is a separate PR");
  const state = integrationReportState(n5.authority.contract.integration, report);
  const result = await n2CommandCas(ctx, m, body, "agent", input.actor.agentId!, { ...m.aggregate,
    n5: { ...n5, integration: { ...n5.integration, report, reportHash: canonicalPayloadHash(report), state } } });
  // Cooperative terminal handoff: settlement happens through the existing driver.
  await ctx.issues.update(p.issueId!, { status: "blocked" }, m.companyId);
  return { ...result, effectPermission: "none" };
}

export async function recordParentObligations(ctx: PluginContext, m: MissionRecord, body: Record<string, unknown>, actorId: string) {
  const n5 = m.aggregate.n5, integration = n5?.integration, required = n5?.authority.contract?.integration?.parentObligations;
  if (!integration || !required?.length) throw new MissionError(409, "parent_obligations_scope", "Integrated delivery and explicit separate parent obligations required");
  await assertProjectDeparture(ctx, m);
  const result = integratedResult(m);
  const key = `council-parent-obligations-${m.missionId}`;
  const doc = await ctx.issues.documents.get(m.rootIssueId, key, m.companyId);
  let evidence: { missionId: string; integratedReportHash: string; obligations: Array<{ criterion: string; evidenceRefs: string[] }> };
  try { evidence = JSON.parse(doc?.body ?? ""); } catch { throw new MissionError(409, "parent_obligations_document", "Exact native parent evidence document required"); }
  if (!doc || doc.latestRevisionId !== body.documentRevisionId || evidence.missionId !== m.missionId || evidence.integratedReportHash !== result.reportHash
      || !Array.isArray(evidence.obligations) || evidence.obligations.length !== required.length
      || required.some(criterion => evidence.obligations.filter(o => o.criterion === criterion).length !== 1)
      || evidence.obligations.some(o => !Array.isArray(o.evidenceRefs) || !o.evidenceRefs.length || o.evidenceRefs.length > 20 || o.evidenceRefs.some(r => typeof r !== "string" || !r.trim() || r.length > 1000))) {
    throw new MissionError(409, "parent_obligations_binding", "Every own parent criterion must bind the exact integrated result and referenced evidence");
  }
  return n2CommandCas(ctx, m, body, "user", actorId, { ...m.aggregate, n5: { ...n5!, integration: { ...integration,
    obligations: { documentId: doc.id, revisionId: doc.latestRevisionId!, bodyHash: canonicalPayloadHash(doc.body), evidenceRefs: evidence.obligations.flatMap(o => o.evidenceRefs) } } } });
}

export async function handleIntegrationRequest(ctx: PluginContext, input: PluginApiRequestInput) {
  const body = input.body as Record<string, unknown>;
  const m = await getMission(ctx, input.companyId, runtimeUuid(body.missionId, "missionId"));
  if (!m) throw new MissionError(404, "mission_not_found", "Mission not found");
  return { status: 200, body: await handleIntegrationAgent(ctx, m, input, body) };
}
