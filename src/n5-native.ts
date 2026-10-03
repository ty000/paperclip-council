import type { PluginContext } from "@paperclipai/plugin-sdk";
import { councilNativeRequest } from "./decision-adapter.js";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import type { N5Plan, N5State } from "./n5-state.js";

type ObjectRecord = Record<string, any>;
async function readDeliveryNative(ctx: PluginContext, mission: MissionRecord, issueId: string, resource: string): Promise<any> {
  const result = await councilNativeRequest(ctx, mission.companyId, `/api/issues/${issueId}/${resource}`);
  if (result.status !== 200) throw new MissionError(409, "n5_native_read_unavailable", `Native ${resource} read unavailable (${result.status})`);
  return result.body;
}
export async function readN5Plan(ctx: PluginContext, mission: MissionRecord, revisionId: string): Promise<N5Plan> {
  const document = await readDeliveryNative(ctx, mission, mission.rootIssueId, "documents/plan");
  if (document.latestRevisionId !== revisionId || document.issueId !== mission.rootIssueId) throw new MissionError(409, "n5_plan_revision", "Exact current native plan revision required");
  let plan: ObjectRecord;
  try { plan = JSON.parse(document.body); } catch { throw new MissionError(422, "n5_plan_format", "Plan document must contain the JSON operational plan"); }
  const mandateHash = canonicalPayloadHash(mission.aggregate.mandate);
  const roles = ["plannerAgentId", "orchestratorAgentId", "integrationLeadAgentId", "qaAgentId"] as const;
  if (!plan || Array.isArray(plan) || plan.missionId !== mission.missionId || plan.mandateHash !== mandateHash
      || roles.some(role => typeof plan[role] !== "string")
      || plan.integrationLeadAgentId !== mission.aggregate.responsibilities.integrationLeadAgentId
      || !Array.isArray(plan.work) || plan.work.length < 2 || !plan.work.every((work: ObjectRecord) =>
        typeof work.assigneeAgentId === "string" && Array.isArray(work.sourceRefs) && work.sourceRefs.length
        && Array.isArray(work.ownedPaths) && work.ownedPaths.length && Array.isArray(work.dependencies)
        && Array.isArray(work.evidenceRefs) && Array.isArray(work.skills) && typeof work.interface === "string")) {
    throw new MissionError(422, "n5_plan_binding", "Plan must bind mission, mandate, roles and complementary prepared work/interfaces/dependencies/evidence");
  }
  for (const id of new Set([...roles.map(role => plan[role]), ...plan.work.map((work: ObjectRecord) => work.assigneeAgentId)])) {
    if (!(await ctx.agents.get(id, mission.companyId))) throw new MissionError(422, "n5_plan_actor", "Plan actor is not in this company");
  }
  return { documentId: document.id, revisionId, bodyHash: canonicalPayloadHash(document.body), mandateHash,
    plannerAgentId: plan.plannerAgentId, orchestratorAgentId: plan.orchestratorAgentId, integrationLeadAgentId: plan.integrationLeadAgentId, qaAgentId: plan.qaAgentId };
}
export async function assertCurrentN5Plan(ctx: PluginContext, mission: MissionRecord) {
  const expected = mission.aggregate.n5!.plan;
  const current = await readN5Plan(ctx, mission, expected.revisionId);
  if (canonicalPayloadHash(current) !== canonicalPayloadHash(expected)) throw new MissionError(409, "n5_plan_changed", "Plan binding changed; replan before publication admission");
}

export function correlateN5Readback(mission: MissionRecord, document: ObjectRecord, products: ObjectRecord[], objects: ObjectRecord[]): NonNullable<NonNullable<N5State["publication"]>["observation"]> {
  const n5 = mission.aggregate.n5!; const p = n5.publication!; const authority = n5.authority;
  let report: ObjectRecord;
  try { report = JSON.parse(document.body); } catch { throw new MissionError(409, "n5_delivery_document", "Native delivery document must contain its intent and canonical PR URL"); }
  const url = typeof report?.url === "string" ? report.url : "";
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  if (!match || match[1] !== authority.repository || report.intentId !== p.intentId || document.issueId !== p.issueId
      || !document.latestRevisionId || !p.claimedAt) throw new MissionError(409, "n5_delivery_binding", "Delivery document, intent and canonical repository PR must match");
  const product = products.find(w => w.type === "pull_request" && w.provider === "github" && w.url === url
    && w.issueId === p.issueId && w.companyId === mission.companyId && w.createdByRunId === p.runId);
  const entry = objects.find(entry => entry.object?.providerKey === "github" && entry.object?.data?.number === Number(match[2])
    && `${entry.object.data.owner}/${entry.object.data.repo}` === authority.repository
    && entry.mentions?.some((m: ObjectRecord) => m.sourceIssueId === p.issueId && m.documentKey === "delivery" && m.sourceRecordId === document.id));
  const object = entry?.object; const data = object?.data;
  if (!product || !object || object.companyId !== mission.companyId || object.liveness !== "fresh"
      || !Number.isFinite(Date.parse(object.lastResolvedAt)) || Date.parse(object.lastResolvedAt) < Date.parse(p.claimedAt)
      || Date.parse(object.lastResolvedAt) > Date.now() + 5_000 || Date.now() - Date.parse(object.lastResolvedAt) > 300_000 || !/^[a-f0-9]{40}$/.test(data?.headSha ?? "")
      || typeof data.baseRef !== "string" || typeof data.headRef !== "string" || typeof data.draft !== "boolean") {
    throw new MissionError(409, "n5_readback_unqualified", "Attributed work product and fresh native GitHub head readback after intent are required");
  }
  return { observedAt: new Date().toISOString(), objectId: object.id, workProductId: product.id, documentRevisionId: document.latestRevisionId,
    url, headSha: data.headSha, baseRef: data.baseRef, headRef: data.headRef, state: data.state, draft: data.draft, lastResolvedAt: object.lastResolvedAt,
    matchesCandidate: data.headSha === p.submission.candidateCommit && data.baseRef === authority.baseRef && data.headRef === authority.headRef };
}
export async function observeN5Native(ctx: PluginContext, mission: MissionRecord) {
  const issueId = mission.aggregate.n5!.publication!.issueId!;
  const [document, products, objects] = await Promise.all(["documents/delivery", "work-products", "external-objects"].map(resource => readDeliveryNative(ctx, mission, issueId, resource)));
  return correlateN5Readback(mission, document, products, objects);
}
