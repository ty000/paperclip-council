import { createHash, randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { LINEAR_READINESS_KEY, LINEAR_SOURCE_KEY } from "../src/linear-intake-contract.js";
import { campaignTerminalStatusUpdates, currentCampaignClosureSubject } from "../src/campaign-closure-subject.js";
import { hierarchyLaunchGuidance } from "../src/hierarchy-guidance.js";

const f = vi.hoisted(() => ({ members: [] as MissionRecord[], evidence: { review: "exact leaf review" },
  integrated: { url: "https://example.test/pull/1", integratedCommit: "a".repeat(40) } }));
vi.mock("../src/repository-campaign.js", async original => ({ ...await original<any>(), listCampaignMembers: async () => f.members }));
vi.mock("../src/completion-evidence.js", () => ({ completionEvidence: () => f.evidence }));
vi.mock("../src/integration-contract.js", () => ({ integratedResult: () => f.integrated }));
vi.mock("../src/integration-recovery.js", () => ({ assertIntegrationRecoveryStable: async () => {} }));

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const now = "2026-10-09T12:00:00.000Z";
function source(id: string, projectId: string, teamId: string, parentId: string | null, campaign?: any) {
  return { schema: "linear-native-source.v1", organizationId: randomUUID(), sourceSha256: digest("source"), ...(campaign ? { campaign } : {}),
    source: { id, uuid: id, parentId, teamId, projectId, title: `Source ${id}`, description: `Requirement ${id}`,
      updatedAt: now, createdAt: now, completedAt: null, canceledAt: null, archivedAt: null, status: "Todo", statusType: "unstarted",
      currentStateId: randomUUID(), relations: { blockedBy: [], blocks: [], relatedTo: [], duplicateOf: null },
      stateHistory: [{ state: { id: randomUUID(), name: "Todo", type: "unstarted" }, startedAt: now, endedAt: null }] },
    provenance: { originKind: "plugin:ty000.linear-intake", intakeId: `linear-intake-${digest("intake")}`,
      activationId: randomUUID(), rootSourceId: id, catalogSha256: digest("catalog") } };
}

let root: MissionRecord; let issues: Map<string, any>; let documents: Map<string, any>;
beforeEach(() => {
  issues = new Map(); documents = new Map();
  const companyId = randomUUID(), projectId = randomUUID(), linearProjectId = randomUUID(), teamId = randomUUID();
  const rootIssueId = randomUUID(), parentIssueId = randomUUID(), leafIssueId = randomUUID();
  const rootSourceId = randomUUID(), parentSourceId = randomUUID(), leafSourceId = randomUUID(), milestoneId = randomUUID();
  const prdContent = "Exact PRD content", tadContent = "Exact TAD content";
  const referenceContents = {
    prd: { url: "https://example.test/prd", version: "1", sha256: digest(prdContent), content: prdContent },
    tad: { url: "https://example.test/tad", version: "1", sha256: digest(tadContent), content: tadContent },
  };
  const references = { prd: { url: referenceContents.prd.url, version: "1", sha256: referenceContents.prd.sha256 },
    tad: { url: referenceContents.tad.url, version: "1", sha256: referenceContents.tad.sha256 } };
  const nativeMapping = [
    { sourceId: rootSourceId, sourceParentId: null, nativeParentSourceId: null, role: "campaign-root" },
    { sourceId: parentSourceId, sourceParentId: rootSourceId, nativeParentSourceId: rootSourceId, role: "milestone-root" },
    { sourceId: leafSourceId, sourceParentId: parentSourceId, nativeParentSourceId: parentSourceId, role: "milestone-node" },
  ];
  const campaign = { schema: "linear-milestone-campaign-readiness.v1", mode: "milestone-fixed-v1", projectId: linearProjectId,
    ticketSourceId: rootSourceId, milestoneId, references, materialSourceSha256: digest("material"),
    stateCompatibility: { status: "compatible", observationSha256: digest("state") }, nativeMapping };
  const rootCampaign = { ...campaign, marker: { schema: "linear-milestone-campaign.v1", milestoneId, ...references },
    milestone: { id: milestoneId, name: "Milestone", description: "Global result" }, referenceContents };
  const sourceBodies = [source(rootSourceId, linearProjectId, teamId, null, rootCampaign),
    source(parentSourceId, linearProjectId, teamId, rootSourceId), source(leafSourceId, linearProjectId, teamId, parentSourceId)];
  sourceBodies.forEach(body => { body.organizationId = sourceBodies[0]!.organizationId; body.provenance.rootSourceId = rootSourceId;
    body.provenance.intakeId = sourceBodies[0]!.provenance.intakeId; body.provenance.activationId = sourceBodies[0]!.provenance.activationId; });
  const nativeIds = [rootIssueId, parentIssueId, leafIssueId];
  const nodes = sourceBodies.map((body, index) => {
    const issueId = nativeIds[index]!, parentId = index ? nativeIds[index - 1]! : null;
    const doc = { id: randomUUID(), companyId, issueId, key: LINEAR_SOURCE_KEY, title: "Linear source", format: "markdown",
      body: JSON.stringify(body), latestRevisionId: randomUUID(), latestRevisionNumber: 1 };
    documents.set(`${issueId}:${LINEAR_SOURCE_KEY}`, doc);
    const status = index === 2 ? "done" : "blocked";
    issues.set(issueId, { id: issueId, companyId, projectId, parentId, title: body.source.title, description: body.source.description,
      assigneeAgentId: null, status, checkoutRunId: null, executionRunId: null });
    return { issueId, parentId, title: body.source.title, descriptionHash: canonicalPayloadHash(body.source.description),
      assigneeAgentId: null, blockedByIssueIds: [], linearSource: { originId: `linear:${body.organizationId}:${body.source.uuid}`,
        documentRevisionId: doc.latestRevisionId, bodySha256: canonicalPayloadHash(doc.body) } };
  });
  const correspondence = sourceBodies.map((body, index) => ({ sourceId: body.source.uuid, nativeId: nativeIds[index]!,
    originId: `linear:${body.organizationId}:${body.source.uuid}`, sourceRevision: now, status: "blocked" }));
  const readiness = { schema: "linear-native-readiness.v1", companyId, intakeId: sourceBodies[0]!.provenance.intakeId,
    activationId: sourceBodies[0]!.provenance.activationId, configurationFingerprint: digest("config"), requestVersion: 1,
    planSha256: digest("plan"), sourceSha256: digest("original"), targetProjectId: projectId,
    originKind: "plugin:ty000.linear-intake", nativeRootId: rootIssueId, sourceRootId: rootSourceId, correspondence,
    effects: [1, 2, 3].map(index => ({ effectKey: `effect-${index}`, intentSha256: digest(`intent-${index}`),
      result: { nativeId: rootIssueId, contentSha256: digest(`content-${index}`) }, resultSha256: digest(`result-${index}`) })),
    externalBlockers: [], importStatus: "prepared", admissionAllowed: false, implementationStarted: false,
    receivingContract: "unqualified", requiresCurrentSourceAndMandateRevalidation: true, campaign };
  const readinessDocument = { id: randomUUID(), companyId, issueId: rootIssueId, key: LINEAR_READINESS_KEY,
    title: "Linear intake readiness", format: "markdown", body: JSON.stringify(readiness), latestRevisionId: randomUUID(), latestRevisionNumber: 1 };
  documents.set(`${rootIssueId}:${LINEAR_READINESS_KEY}`, readinessDocument);
  const readinessIntent = { companyId, issueId: rootIssueId, key: LINEAR_READINESS_KEY, title: readinessDocument.title,
    format: readinessDocument.format, body: readinessDocument.body };
  const subject = { companyId, intakeId: readiness.intakeId, activationId: readiness.activationId,
    configurationFingerprint: readiness.configurationFingerprint, requestVersion: 1, nativeRootId: rootIssueId,
    targetProjectId: projectId, sourceSha256: readiness.sourceSha256, planSha256: readiness.planSha256,
    readinessDocumentId: readinessDocument.id, readinessRevisionId: readinessDocument.latestRevisionId,
    readinessSha256: canonicalPayloadHash({ nativeId: readinessDocument.id, revisionId: readinessDocument.latestRevisionId,
      revisionNumber: 1, contentSha256: canonicalPayloadHash(readinessIntent), nativeRootId: rootIssueId,
      planSha256: readiness.planSha256, sourceSha256: readiness.sourceSha256 }) };
  const memberMissionId = randomUUID(), completionBody = JSON.stringify(f.evidence);
  const completionDocument = { id: randomUUID(), companyId, issueId: leafIssueId, key: "leaf-completion", title: "Completion",
    format: "markdown", body: completionBody, latestRevisionId: randomUUID(), latestRevisionNumber: 1 };
  documents.set(`${leafIssueId}:leaf-completion`, completionDocument);
  const member = { companyId, projectId, missionId: memberMissionId, rootIssueId: leafIssueId, ownerUserId: "owner", version: 1,
    aggregate: { completion: { state: "closed", proofId: canonicalPayloadHash(f.evidence), documentKey: "leaf-completion",
      documentRevisionId: completionDocument.latestRevisionId, body: completionBody }, compositions: { team: { members: [] } } } } as unknown as MissionRecord;
  f.members = [member];
  const rootMissionId = randomUUID();
  member.aggregate.repositoryCampaign = { campaignRootMissionId: rootMissionId };
  const plan = { intentId: randomUUID(), payloadSha256: digest("plan-publication"), payload: { campaignPlan: {
    schema: "council-linear-delivery-plan-v1", campaignRootMissionId: rootMissionId,
    leaves: [{ sourceId: leafSourceId, nativeId: leafIssueId }],
  } }, acknowledgement: { reference: {}, confirmedAt: now } };
  const delivery = { intentId: randomUUID(), payloadSha256: digest("delivery-publication"), payload: { campaignDelivery: {
    schema: "council-linear-delivery-result-v1", sourceMissionId: memberMissionId } }, acknowledgement: { reference: {}, confirmedAt: now } };
  root = { companyId, projectId, missionId: rootMissionId, rootIssueId, ownerUserId: "owner", version: 1,
    aggregate: { mandate: { objective: "Milestone", acceptanceCriteria: ["All exact work ships"], commitments: ["Keep source immutable"] },
      projectMandate: { linearIntake: { subject } }, compositions: { team: { members: [] } },
      responsibilities: { finalReviewerAgentId: randomUUID() }, hierarchy: { nodes },
      linearContinuity: { mode: "milestone-fixed-v1", sourceSha256: campaign.materialSourceSha256,
        binding: { subject, sourceRootId: rootSourceId }, publications: [plan, delivery] } } } as unknown as MissionRecord;
});

function context() {
  return { issues: { documents: { get: async (issueId: string, key: string) => structuredClone(documents.get(`${issueId}:${key}`) ?? null) },
    get: async (issueId: string) => structuredClone(issues.get(issueId)),
    relations: { get: async () => ({ blockedBy: [] }) } } } as any;
}

it("binds global coverage to leaves, parents, milestone, PRD/TAD and current delivery proofs", async () => {
  const result = await currentCampaignClosureSubject(context(), root);
  expect(result.coverage.map(item => item.kind)).toEqual(["criterion", "commitment", "campaign-root", "milestone-root", "milestone-node", "milestone", "prd", "tad"]);
  expect(result.results).toHaveLength(1);
  expect(result.allowedProofIds).toContain(result.results[0]!.proofId);
  const statuses = await campaignTerminalStatusUpdates(context(), root);
  expect(statuses).toHaveLength(3);
  expect(statuses.at(-1)?.sourceId).toBe(root.aggregate.linearContinuity!.binding.sourceRootId);
});

it("refuses a manual parent Done instead of treating it as global proof", async () => {
  const parent = root.aggregate.hierarchy!.nodes![1]!;
  issues.get(parent.issueId).status = "done";
  await expect(currentCampaignClosureSubject(context(), root)).rejects.toMatchObject({ code: "campaign_review_manual_done" });
});

it("refuses global review while an acknowledged plan leaf has no campaign mission", async () => {
  const plan = root.aggregate.linearContinuity!.publications[0]!.payload.campaignPlan as { leaves: unknown[] };
  plan.leaves.push({ sourceId: randomUUID(), nativeId: randomUUID() });
  await expect(currentCampaignClosureSubject(context(), root)).rejects.toMatchObject({ code: "campaign_review_publication" });
});

it("accepts only the exact persisted Council execution suffix on a delivery leaf", async () => {
  const member = f.members[0]!, leaf = root.aggregate.hierarchy!.nodes!.at(-1)!;
  member.aggregate.hierarchy = { protocol: "council-hierarchy-v1", maxContributions: 1, execution: "sequential",
    adoptExistingChildren: true, leaves: [{ issueId: leaf.issueId, blockedByIssueIds: [], ownedPaths: ["src"] }] } as any;
  issues.get(leaf.issueId).description += `\n\n${hierarchyLaunchGuidance(member, leaf.issueId)}`;
  await expect(currentCampaignClosureSubject(context(), root)).resolves.toMatchObject({ campaignRootMissionId: root.missionId });
  issues.get(leaf.issueId).description += "\n\nUnattributed manual change";
  await expect(currentCampaignClosureSubject(context(), root)).rejects.toMatchObject({ code: "campaign_review_native_drift" });
});
