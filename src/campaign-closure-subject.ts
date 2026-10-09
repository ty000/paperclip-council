import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { completionEvidence } from "./completion-evidence.js";
import { integratedResult } from "./integration-contract.js";
import { assertIntegrationRecoveryStable } from "./integration-recovery.js";
import { LINEAR_READINESS_KEY, LINEAR_SOURCE_KEY, parseLinearReadiness, parseLinearSource } from "./linear-intake-contract.js";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";
import { listCampaignMembers } from "./repository-campaign.js";
import type { CampaignClosureSubject, CampaignCoverageSource, CampaignDeliveryResult } from "./campaign-closure-contract.js";
import { descriptionMatchesSource } from "./hierarchy-runtime.js";
import { physicalAgent } from "./model-state.js";

type SourceReadback = ReturnType<typeof parseLinearSource>;

function readinessReceipt(document: NonNullable<Awaited<ReturnType<PluginContext["issues"]["documents"]["get"]>>>, body: ReturnType<typeof parseLinearReadiness>) {
  const intent = { companyId: document.companyId, issueId: document.issueId, key: document.key,
    title: document.title, format: document.format, body: document.body };
  return { nativeId: document.id, revisionId: document.latestRevisionId, revisionNumber: document.latestRevisionNumber,
    contentSha256: canonicalPayloadHash(intent), nativeRootId: body.nativeRootId,
    planSha256: body.planSha256, sourceSha256: body.sourceSha256 };
}

async function readPinnedSources(ctx: PluginContext, root: MissionRecord) {
  const subject = root.aggregate.linearContinuity!.binding.subject;
  const readinessDocument = await ctx.issues.documents.get(root.rootIssueId, LINEAR_READINESS_KEY, root.companyId);
  if (!readinessDocument || readinessDocument.id !== subject.readinessDocumentId
      || readinessDocument.latestRevisionId !== subject.readinessRevisionId) {
    throw new MissionError(409, "campaign_review_readiness", "The original campaign readiness revision must remain exact");
  }
  const readiness = parseLinearReadiness(readinessDocument.body);
  if (!readiness.campaign || readiness.campaign.mode !== FIXED_CAMPAIGN_MODE
      || readiness.campaign.materialSourceSha256 !== root.aggregate.linearContinuity!.sourceSha256
      || canonicalPayloadHash(readinessReceipt(readinessDocument, readiness)) !== subject.readinessSha256) {
    throw new MissionError(409, "campaign_review_readiness", "The campaign source and pinned readiness receipt must remain exact");
  }
  const nodes = root.aggregate.hierarchy?.nodes ?? [];
  if (!nodes.length || nodes.length !== readiness.correspondence.length) {
    throw new MissionError(409, "campaign_review_source_inventory", "The full pinned campaign hierarchy is required for global coverage");
  }
  const sources = new Map<string, { parsed: SourceReadback; bodySha256: string; revisionId: string; issueId: string }>();
  for (const entry of readiness.correspondence) {
    const node = nodes.find(item => item.issueId === entry.nativeId);
    const pinned = node?.linearSource;
    const document = await ctx.issues.documents.get(entry.nativeId, LINEAR_SOURCE_KEY, root.companyId);
    if (!node || !pinned || !document?.latestRevisionId || document.latestRevisionId !== pinned.documentRevisionId
        || canonicalPayloadHash(document.body) !== pinned.bodySha256) {
      throw new MissionError(409, "campaign_review_source_stale", "Every leaf, parent and campaign source document must retain its exact pinned revision");
    }
    const parsed = parseLinearSource(document.body);
    if (parsed.source.uuid !== entry.sourceId || parsed.source.updatedAt !== entry.sourceRevision
        || parsed.source.projectId !== readiness.campaign.projectId) {
      throw new MissionError(409, "campaign_review_source_stale", "A source document no longer matches its exact campaign identity");
    }
    sources.set(entry.sourceId, { parsed, bodySha256: pinned.bodySha256, revisionId: pinned.documentRevisionId, issueId: entry.nativeId });
  }
  return { readiness, sources };
}

async function assertNativeSourceState(ctx: PluginContext, root: MissionRecord,
  readback: Awaited<ReturnType<typeof readPinnedSources>>, members: MissionRecord[]) {
  const memberIds = new Set(members.map(member => member.rootIssueId));
  for (const node of root.aggregate.hierarchy!.nodes!) {
    const member = members.find(item => item.rootIssueId === node.issueId);
    const expectedAgentId = node.assigneeAgentId && member
      ? physicalAgent(member, node.assigneeAgentId, { issueId: node.issueId }) : node.assigneeAgentId;
    const issue = await ctx.issues.get(node.issueId, root.companyId);
    const relations = await ctx.issues.relations.get(node.issueId, root.companyId);
    if (!issue || issue.companyId !== root.companyId || issue.projectId !== root.projectId
        || issue.parentId !== node.parentId || issue.title !== node.title
        || issue.assigneeAgentId !== expectedAgentId || issue.checkoutRunId || issue.executionRunId
        || !descriptionMatchesSource(member ?? root,
          node.issueId, issue.description, node.descriptionHash)
        || canonicalPayloadHash(relations.blockedBy.map(item => item.id).sort()) !== canonicalPayloadHash(node.blockedByIssueIds)) {
      throw new MissionError(409, "campaign_review_native_drift", "The original native hierarchy, content and dependencies must remain exact");
    }
    const expectedStatus = node.historicalStatus ?? (memberIds.has(node.issueId) ? "done" : null);
    if (expectedStatus ? issue.status !== expectedStatus : !["backlog", "blocked"].includes(issue.status)) {
      throw new MissionError(409, "campaign_review_manual_done", "A manual Done or changed terminal state cannot replace proof-closed campaign work");
    }
    const correspondence = readback.readiness.correspondence.find(item => item.nativeId === node.issueId);
    if (!correspondence || correspondence.sourceId !== readback.sources.get(correspondence.sourceId)?.parsed.source.uuid) {
      throw new MissionError(409, "campaign_review_source_inventory", "Native and source identities must retain complete one-to-one coverage");
    }
  }
}

function publicationInventory(root: MissionRecord, members: MissionRecord[]) {
  const publications = root.aggregate.linearContinuity!.publications;
  const plan = publications.filter(item => (item.payload.campaignPlan as { schema?: string } | undefined)?.schema === "council-linear-delivery-plan-v1");
  const deliveries = publications.filter(item => (item.payload.campaignDelivery as { schema?: string } | undefined)?.schema === "council-linear-delivery-result-v1");
  const ids = deliveries.map(item => (item.payload.campaignDelivery as { sourceMissionId: string }).sourceMissionId);
  if (plan.length !== 1 || deliveries.length !== members.length || new Set(ids).size !== ids.length
      || members.some(member => !ids.includes(member.missionId)) || [...plan, ...deliveries].some(item => !item.acknowledgement)) {
    throw new MissionError(409, "campaign_review_publication", "The acknowledged plan and every exact delivery publication are required before global review");
  }
  return [...plan, ...deliveries];
}

function coverageSources(root: MissionRecord, readback: Awaited<ReturnType<typeof readPinnedSources>>) {
  const coverage: CampaignCoverageSource[] = [];
  root.aggregate.mandate.acceptanceCriteria.forEach((label, index) => coverage.push({ criterionId: `criterion:${index + 1}`,
    kind: "criterion", label, sourceSha256: canonicalPayloadHash({ kind: "criterion", index, label }) }));
  root.aggregate.mandate.commitments.forEach((label, index) => coverage.push({ criterionId: `commitment:${index + 1}`,
    kind: "commitment", label, sourceSha256: canonicalPayloadHash({ kind: "commitment", index, label }) }));
  for (const mapping of readback.readiness.campaign!.nativeMapping) {
    const source = readback.sources.get(mapping.sourceId)!;
    coverage.push({ criterionId: `source:${mapping.sourceId}`, kind: mapping.role, label: source.parsed.source.title,
      sourceSha256: canonicalPayloadHash({ source: source.parsed.source, role: mapping.role }),
      sourceDocument: { issueId: source.issueId, key: LINEAR_SOURCE_KEY, revisionId: source.revisionId, bodySha256: source.bodySha256,
        selector: "source" } });
  }
  const campaignRoot = readback.sources.get(readback.readiness.sourceRootId)!;
  const milestone = campaignRoot.parsed.campaign!.milestone;
  coverage.push({ criterionId: `milestone:${milestone.id}`, kind: "milestone", label: milestone.name,
    sourceSha256: canonicalPayloadHash(milestone), sourceDocument: { issueId: campaignRoot.issueId, key: LINEAR_SOURCE_KEY,
      revisionId: campaignRoot.revisionId, bodySha256: campaignRoot.bodySha256, selector: "campaign.milestone" } });
  for (const kind of ["prd", "tad"] as const) {
    const reference = campaignRoot.parsed.campaign!.referenceContents[kind];
    coverage.push({ criterionId: `reference:${kind}`, kind, label: `${kind.toUpperCase()} ${reference.version}`,
      sourceSha256: canonicalPayloadHash(reference), sourceDocument: { issueId: campaignRoot.issueId, key: LINEAR_SOURCE_KEY,
        revisionId: campaignRoot.revisionId, bodySha256: campaignRoot.bodySha256, selector: `campaign.referenceContents.${kind}` } });
  }
  if (!coverage.length || coverage.length > 64 || new Set(coverage.map(item => item.criterionId)).size !== coverage.length) {
    throw new MissionError(409, "campaign_review_coverage_bound", "Global source coverage must be complete, unique and bounded to 64 rows");
  }
  return coverage;
}

async function deliveryResults(ctx: PluginContext, root: MissionRecord, members: MissionRecord[],
  readback: Awaited<ReturnType<typeof readPinnedSources>>) {
  const results: CampaignDeliveryResult[] = [];
  for (const member of members.sort((left, right) => left.missionId.localeCompare(right.missionId))) {
    const completion = member.aggregate.completion;
    if (completion?.state !== "closed" || !completion.documentRevisionId
        || completion.proofId !== canonicalPayloadHash(completionEvidence(member))) {
      throw new MissionError(409, "campaign_review_delivery_proof", "Every delivery must retain its exact proof-closed review result");
    }
    await assertIntegrationRecoveryStable(ctx, member);
    const document = await ctx.issues.documents.get(member.rootIssueId, completion.documentKey, member.companyId);
    if (!document || document.latestRevisionId !== completion.documentRevisionId || document.body !== completion.body) {
      throw new MissionError(409, "campaign_review_delivery_proof", "A delivery completion document is missing or stale");
    }
    const sourceId = readback.readiness.correspondence.find(item => item.nativeId === member.rootIssueId)?.sourceId;
    if (!sourceId) throw new MissionError(409, "campaign_review_delivery_source", "Every managed delivery must retain its original campaign source");
    const integrated = integratedResult(member), integratedResultSha256 = canonicalPayloadHash(integrated);
    results.push({ resultId: `delivery:${member.missionId}`, sourceId, missionId: member.missionId, issueId: member.rootIssueId,
      proofId: completion.proofId, completionDocument: { key: completion.documentKey, revisionId: completion.documentRevisionId,
        bodySha256: canonicalPayloadHash(document.body) }, integratedResult: integrated as unknown as Record<string, unknown>, integratedResultSha256 });
  }
  return results;
}

export async function currentCampaignClosureSubject(ctx: PluginContext, root: MissionRecord): Promise<CampaignClosureSubject> {
  if (root.aggregate.linearContinuity?.mode !== FIXED_CAMPAIGN_MODE || root.aggregate.repositoryCampaign) {
    throw new MissionError(409, "campaign_review_root", "Global review belongs only to the fixed campaign control root");
  }
  const members = await listCampaignMembers(ctx, root);
  if (!members.length || members.some(member => member.aggregate.completion?.state !== "closed")) {
    throw new MissionError(409, "campaign_review_members", "All managed delivery members must be proof-closed before global review");
  }
  const readback = await readPinnedSources(ctx, root);
  await assertNativeSourceState(ctx, root, readback, members);
  const publications = publicationInventory(root, members);
  const coverage = coverageSources(root, readback);
  const results = await deliveryResults(ctx, root, members, readback);
  const mandateSha256 = canonicalPayloadHash({ mandate: root.aggregate.mandate, projectMandate: root.aggregate.projectMandate,
    compositions: root.aggregate.compositions, responsibilities: root.aggregate.responsibilities,
    hierarchy: root.aggregate.hierarchy });
  const priorPublicationSha256s = publications.map(item => item.payloadSha256).sort();
  const allowedProofIds = [...new Set(results.flatMap(result => [result.resultId, result.proofId,
    result.completionDocument.revisionId, result.completionDocument.bodySha256, result.integratedResultSha256])
    .concat(priorPublicationSha256s))].sort();
  return { schema: "council-linear-campaign-review-subject-v1", campaignRootMissionId: root.missionId,
    sourceSha256: root.aggregate.linearContinuity.sourceSha256, mandateSha256,
    coverageSha256: canonicalPayloadHash(coverage), resultsSha256: canonicalPayloadHash(results),
    coverage, results, priorPublicationSha256s, allowedProofIds };
}

export async function campaignTerminalStatusUpdates(ctx: PluginContext, root: MissionRecord) {
  const { readiness } = await readPinnedSources(ctx, root);
  const active = readiness.correspondence.filter(item => item.status === "blocked");
  const rootEntry = active.find(item => item.sourceId === readiness.sourceRootId);
  if (!rootEntry || active.length > 33) throw new MissionError(409, "campaign_review_status_bound", "Terminal status publication requires the active source root and at most 33 active sources");
  return [...active.filter(item => item !== rootEntry).map(item => ({ sourceId: item.sourceId, state: "completed" as const })),
    { sourceId: rootEntry.sourceId, state: "completed" as const }];
}

export function assertIndependentCampaignReviewer(root: MissionRecord, members: MissionRecord[], reviewerPhysicalAgentId: string) {
  const logicalAuthors = new Set([root, ...members].flatMap(mission => mission.aggregate.compositions.team.members.map(member => member.agentId)));
  const physicalAuthors = new Set<string>(logicalAuthors);
  for (const member of [root, ...members]) for (const launch of member.aggregate.modelSelection?.tasks.flatMap(task => task.launches) ?? []) {
    if (logicalAuthors.has(launch.logicalAgentId)) physicalAuthors.add(launch.agentId);
  }
  if (logicalAuthors.has(root.aggregate.responsibilities.finalReviewerAgentId) || physicalAuthors.has(reviewerPhysicalAgentId)) {
    throw new MissionError(409, "campaign_review_independence", "The single global reviewer must be physically independent from every author and integrator");
  }
}
