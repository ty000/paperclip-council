import { contributionSegmentRoot, assertContributionClosure } from "./contribution-closure.js";
import { finishContributionWait } from "./contribution-wait.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError } from "./mission-primitives.js";
import type { MissionAggregate, MissionRecord } from "./missions.js";
import type { N1State } from "./n1-missions.js";
import { readAdmission } from "./admission.js";
import { readOrdinaryRun } from "./g4-native.js";
import { physicalAgent } from "./model-state.js";
import { integratedResult } from "./integration-contract.js";
import { completionPolicy } from "./completion-contract.js";
import { verifyContributionBundle, type ContributionBundleProof } from "./integration.js";

export function sourceBase(m: MissionRecord, value: unknown) {
  if (!completionPolicy(m)) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new MissionError(422, "contribution_source_base", "Pin the full source base commit before any contribution");
  if (m.aggregate.deliveryPredecessor && value !== m.aggregate.deliveryPredecessor.result.integratedCommit) throw new MissionError(409, "delivery_source_base", "The next delivery must pin the exact verified integrated predecessor as its Git base");
  return value;
}
export async function recordContributionProof(ctx: PluginContext, m: MissionRecord, contributionId: string, commit: string, value: unknown): Promise<ContributionBundleProof | undefined> {
  if (!completionPolicy(m)) return undefined;
  const proof = value as { attachmentId: string; expectedSha256: string; segmentRootCommit: string };
  const segmentRootCommit = contributionSegmentRoot(m, contributionId);
  const slot = (m.aggregate.n1 as N1State).contributions.find(s => s.contributionId === contributionId)!;
  if (!proof || proof.segmentRootCommit !== segmentRootCommit || !slot.childIssueId) throw new MissionError(409, "contribution_proof_required", "A self-contained child-bound bundle must bind the pinned predecessor and admitted contribution");
  try { return await verifyContributionBundle(ctx, { companyId: m.companyId, issueId: slot.childIssueId, attachmentId: proof.attachmentId,
    expectedSha256: proof.expectedSha256, baseCommit: segmentRootCommit, candidateCommit: commit, contributionId, ownedPaths: slot.ownedPaths }); }
  catch { throw new MissionError(422, "contribution_proof_invalid", "Contribution bundle, digest, linear history or owned changes did not verify; the child cannot close"); }
}

export async function closeQualifiedContribution(ctx: PluginContext, m: MissionRecord, contributionId: string,
  persist: (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>) {
  if (!completionPolicy(m)) return m;
  let slot = (m.aggregate.n1 as N1State).contributions.find(s => s.contributionId === contributionId)!;
  const agentId = physicalAgent(m, slot.assigneeAgentId, { issueId: slot.childIssueId, runId: slot.dispatchRunId });
  const [envelope, run] = await Promise.all([readAdmission(ctx, { companyId: m.companyId, periodKey: (m.aggregate.n1 as N1State).periodKey }),
    readOrdinaryRun(ctx, { companyId: m.companyId, issueId: slot.childIssueId!, agentId, runId: slot.dispatchRunId! })]);
  slot = assertContributionClosure(m, contributionId, envelope, run.status);
  const held = await holdPendingDelivery(ctx, m, slot, agentId, contributionId, persist);
  if (held) return held;
  return finishQualifiedClosure(ctx, m, slot, agentId, contributionId, persist);
}

async function finishQualifiedClosure(ctx: PluginContext, m: MissionRecord, slot: N1State["contributions"][number], agentId: string, contributionId: string,
  persist: (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>) {
  if (!slot.proof!.closureClaimedAt) {
    const n1 = m.aggregate.n1 as N1State;
    m = await persist(m, { ...m.aggregate, n1: { ...n1, contributions: n1.contributions.map(s => s.contributionId === contributionId
      ? { ...s, proof: { ...s.proof!, closureClaimedAt: new Date().toISOString() } } : s) } });
  }
  const issue = await ctx.issues.get(slot.childIssueId!, m.companyId);
  if (!contributionIssueMatches(issue, m, slot, agentId) || !["blocked", "done"].includes(issue!.status)) throw new MissionError(409, "contribution_closure_identity", "Retain the original child and claimed closure; no replacement issue or native wake");
  if (issue!.status !== "done") await ctx.issues.update(issue!.id, { status: "done" }, m.companyId);
  const after = await ctx.issues.get(issue!.id, m.companyId);
  if (after?.id !== issue!.id || !contributionIssueMatches(after, m, slot, agentId) || after!.status !== "done") throw new MissionError(409, "contribution_closure_unknown", "The original closure must be observed");
  await finishContributionWait(ctx, m, contributionId);
  const n1 = m.aggregate.n1 as N1State;
  if (!n1.contributions.find(s => s.contributionId === contributionId)!.proof!.closedAt) m = await persist(m, { ...m.aggregate,
    n1: { ...n1, contributions: n1.contributions.map(s => s.contributionId === contributionId ? { ...s, proof: { ...s.proof!, closedAt: new Date().toISOString() } } : s) } });
  return m;
}

async function holdPendingDelivery(ctx: PluginContext, m: MissionRecord, slot: N1State["contributions"][number], agentId: string, contributionId: string,
  persist: (m: MissionRecord, aggregate: MissionAggregate) => Promise<MissionRecord>) {
  if (completionPolicy(m)?.result !== "integrated-verified") return null;
  try { integratedResult(m); return null; } catch { /* Contribution proof is not delivery proof. */ }
  const issue = await ctx.issues.get(slot.childIssueId!, m.companyId);
  if (!contributionIssueMatches(issue, m, slot, agentId) || issue!.status !== "blocked") throw new MissionError(409, "contribution_delivery_pending", "The original proved code leaf must remain blocked until integrated delivery");
  if (slot.proof!.readyAt) return m;
  const n1 = m.aggregate.n1 as N1State;
  return persist(m, { ...m.aggregate, n1: { ...n1, contributions: n1.contributions.map(s => s.contributionId === contributionId
    ? { ...s, proof: { ...s.proof!, readyAt: new Date().toISOString() } } : s) } });
}

function contributionIssueMatches(issue: Awaited<ReturnType<PluginContext["issues"]["get"]>>, m: MissionRecord, slot: N1State["contributions"][number], agentId: string) {
  const expected = { companyId: m.companyId, projectId: m.projectId, parentId: slot.parentIssueId !== undefined ? slot.parentIssueId : m.rootIssueId, assigneeAgentId: agentId };
  return Boolean(issue && Object.entries(expected).every(([key, value]) => (issue[key as keyof typeof issue] ?? null) === value));
}
