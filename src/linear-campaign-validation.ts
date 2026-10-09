import { createHash } from "node:crypto";
import { canonicalPayloadHash as hash } from "./mission-primitives.js";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";
import { requireLinear, type LinearReadiness, type LinearSourceDocument } from "./linear-intake-contract.js";
import type { ProjectMandate } from "./project-mandate-state.js";

function same(actual: unknown, expected: unknown) {
  requireLinear(hash(actual) === hash(expected), "linear_campaign_binding");
}
function milestoneId(source: LinearSourceDocument["source"]) {
  const value = source.projectMilestone;
  requireLinear(value === null || value && typeof value === "object" && "id" in value
    && typeof value.id === "string", "linear_campaign_milestone");
  return value === null ? null : (value as { id: string }).id;
}
function material(source: LinearSourceDocument["source"]) {
  return { id: source.id, uuid: source.uuid, title: source.title, description: source.description,
    parentId: source.parentId, teamId: source.teamId, projectId: source.projectId,
    projectMilestoneId: milestoneId(source), relations: source.relations };
}

/** Source parents and native grouping are different facts; bind both, without rewriting either. */
export function validateLinearCampaign(policy: ProjectMandate, body: LinearReadiness, documents: LinearSourceDocument[]) {
  const campaign = body.campaign;
  requireLinear(Boolean(campaign) === (policy.content.linearContinuity?.mode === FIXED_CAMPAIGN_MODE), "linear_campaign_policy");
  if (!campaign) {
    requireLinear(documents.every(doc => !doc.campaign), "linear_campaign_binding");
    return;
  }
  same([campaign.projectId, campaign.ticketSourceId], [policy.content.linearIntake!.projectId, body.sourceRootId]);
  const root = documents.find(doc => doc.source.uuid === body.sourceRootId);
  requireLinear(root?.campaign, "linear_campaign_source_missing");
  const { marker, milestone, referenceContents, ...readiness } = root.campaign;
  same(readiness, campaign);
  same([marker.milestoneId, milestone.id], [campaign.milestoneId, campaign.milestoneId]);
  same([marker.prd, marker.tad], [campaign.references.prd, campaign.references.tad]);
  for (const key of ["prd", "tad"] as const) {
    const { content, ...reference } = referenceContents[key];
    same(reference, campaign.references[key]);
    same(createHash("sha256").update(content, "utf8").digest("hex"), reference.sha256);
  }
  requireLinear(documents.filter(doc => doc.campaign).length === 1, "linear_campaign_source_duplicate");
  same(milestoneId(root.source), null);
  const mapping = campaign.nativeMapping;
  same(mapping.map(item => item.sourceId).sort(), documents.map(doc => doc.source.uuid).sort());
  requireLinear(new Set(mapping.map(item => item.sourceId)).size === mapping.length, "linear_campaign_mapping");
  const refs = new Map(documents.flatMap(doc => [[doc.source.id, doc], [doc.source.uuid, doc]]));
  for (const item of mapping) {
    const doc = refs.get(item.sourceId)!;
    same(item.sourceParentId, doc.source.parentId);
    if (item.sourceId === body.sourceRootId) same([item.role, item.nativeParentSourceId], ["campaign-root", null]);
    else {
      const sourceParent = refs.get(doc.source.parentId ?? "");
      const nested = sourceParent && sourceParent !== root;
      same([item.role, item.nativeParentSourceId], nested
        ? ["milestone-node", sourceParent.source.uuid] : ["milestone-root", body.sourceRootId]);
    }
  }
  const selected = documents.filter(doc => doc !== root).map(doc => doc.source).sort((a, b) => a.uuid.localeCompare(b.uuid));
  same(hash({ ticket: material(root.source), milestone, references: referenceContents,
    issues: selected.map(material), nativeMapping: mapping }), campaign.materialSourceSha256);
  const observations = [root.source, ...selected].map(source => ({ sourceId: source.uuid,
    currentStateId: source.currentStateId, statusType: source.statusType, archived: source.archivedAt !== null,
    completed: source.completedAt !== null, canceled: source.canceledAt !== null })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  same(hash(observations), campaign.stateCompatibility.observationSha256);
}
