import { createHash, randomUUID } from "node:crypto";
import { linearFixture } from "./linear-intake-fixture.js";
import { canonicalPayloadHash as hash } from "../src/mission-primitives.js";
import type { LinearReadiness } from "../src/linear-intake-contract.js";
import { LINEAR_CONTINUITY_PROTOCOL } from "../src/linear-continuity-contract.js";

export function campaignFixture() {
  const f = linearFixture(), milestoneId = randomUUID();
  const documents = f.plan.nodes.map(node => {
    const source = { ...node.source, projectMilestone: node.sourceId === f.ids["source-root"] ? null : { id: milestoneId } };
    // Original source roots have an unselected parent. Native grouping attaches them to the campaign ticket.
    if (node.sourceId !== f.ids["source-root"]) source.parentId = "External Linear parent";
    node.source = source;
    return { ...JSON.parse(node.sourceDocumentBody), source };
  });
  const root = documents[0]!, selected = documents.slice(1).map(doc => doc.source).sort((a, b) => a.uuid.localeCompare(b.uuid));
  const reference = (name: string) => ({ url: `https://example.com/${name}`, version: "1", content: `${name} accepted criteria`,
    sha256: createHash("sha256").update(`${name} accepted criteria`).digest("hex") });
  const referenceContents = { prd: reference("prd"), tad: reference("tad") };
  const references = Object.fromEntries(Object.entries(referenceContents).map(([key, { content: _content, ...value }]) => [key, value])) as NonNullable<LinearReadiness["campaign"]>["references"];
  const milestone = { id: milestoneId, name: "Milestone result", description: "Cross-cutting criterion" };
  const nativeMapping = f.plan.nodes.map((node, index) => ({ sourceId: node.sourceId,
    sourceParentId: documents[index]!.source.parentId, nativeParentSourceId: node.parentSourceId ?? null,
    role: index ? "milestone-root" as const : "campaign-root" as const }));
  const material = (source: any) => ({ id: source.id, uuid: source.uuid, title: source.title, description: source.description,
    parentId: source.parentId, teamId: source.teamId, projectId: source.projectId,
    projectMilestoneId: source.projectMilestone?.id ?? null, relations: source.relations });
  const observations = documents.map(({ source }) => ({ sourceId: source.uuid,
    currentStateId: source.currentStateId, statusType: source.statusType, archived: source.archivedAt !== null,
    completed: source.completedAt !== null, canceled: source.canceledAt !== null })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const campaign: NonNullable<LinearReadiness["campaign"]> = { schema: "linear-milestone-campaign-readiness.v1", mode: "milestone-fixed-v1",
    projectId: f.ids.sourceProject!, ticketSourceId: f.ids["source-root"]!, milestoneId, references, nativeMapping,
    materialSourceSha256: hash({ ticket: material(root.source), milestone, references: referenceContents, issues: selected.map(material), nativeMapping }),
    stateCompatibility: { status: "compatible", observationSha256: hash(observations) } };
  root.campaign = { ...campaign, marker: { schema: "linear-milestone-campaign.v1", milestoneId, ...references }, milestone, referenceContents };
  for (const [index, node] of f.plan.nodes.entries()) {
    const doc = f.documents.get(f.docKey(f.readiness.correspondence[index]!.nativeId!, "linear-source-v1"));
    node.sourceDocumentBody = doc.body = JSON.stringify(documents[index]);
    const { id: _id, latestRevisionId: _revision, latestRevisionNumber: _number, ...intent } = doc;
    const receipt = f.readiness.effects.find(item => item.effectKey === node.keys.document)!;
    receipt.intentSha256 = hash(intent); receipt.result.contentSha256 = hash(intent); receipt.resultSha256 = hash(receipt.result);
  }
  Object.assign(f.plan, { campaign }); Object.assign(f.readiness, { campaign });
  f.readiness.planSha256 = hash(f.plan); f.refreshReadiness();
  f.policy.content.linearContinuity = { protocol: LINEAR_CONTINUITY_PROTOCOL, mode: "milestone-fixed-v1" };
  return { ...f, campaign, sourceDocuments: documents };
}
