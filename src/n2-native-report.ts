import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas, storedN2, type N2Submission } from "./n2-missions.js";
import { n3Round } from "./n3-state.js";
import { synthesizeN3Review, type N3ReviewRound } from "./n3-opinions.js";
import { readNativeRun } from "./g4-native.js";

export type NativeReviewPacket = {
  schema: "council-native-review-v1";
  missionId: string; companyId: string; issueId: string; reviewerAgentId: string; sourceRunId: string;
  submission: N2Submission; mandate: MissionRecord["aggregate"]["mandate"];
  opinions: N3ReviewRound | null;
};
export type NativeReviewPacketRecord = {
  packet: NativeReviewPacket; hash: string; operationId: string; correctionReservationId: string;
  settlementCommandId: string; publishedAt?: string;
  observation?: { runId: string; interactionId: string; decisionId: string; report: NativeReviewerReport; observedAt: string };
};
export type NativeReviewerReport = {
  schema: "council-native-review-v1"; packetHash: string;
  subject: { submissionId: string; candidateCommit: string; bundleSha256: string; evidenceRevision: number; mandateHash: string };
  verdict: "approved" | "changes_requested"; rationale: string;
  dispositions: Parameters<typeof synthesizeN3Review>[1]["dispositions"];
};
const fail = (message: string): never => { throw new MissionError(409, "native_review_readback_unqualified", message); };
export function nativeReviewPacketText(record: NativeReviewPacketRecord) {
  const s = record.packet.submission;
  const example: NativeReviewerReport = { schema: "council-native-review-v1", packetHash: record.hash,
    subject: { submissionId: s.submissionId, candidateCommit: s.candidateCommit, bundleSha256: s.sha256, evidenceRevision: s.evidenceRevision, mandateHash: s.mandateHash },
    verdict: "approved", rationale: "REPLACE with your independent reason", dispositions: [] };
  return `\n\n<council-active-native-review>\nCouncil native review packet ${record.hash}\n\`\`\`json\n${JSON.stringify({ packetHash: record.hash, ...record.packet })}\n\`\`\`\nRead this immutable packet with get_task_context. Resolve the assigned native review, then finish with summary containing only JSON. Copy these identifiers unchanged; replace verdict, rationale and dispositions according to your independent review:\n${JSON.stringify(example)}\nUse the packet submission and opinions; dispositions must address every material finding using the existing N3 disposition format. Native acceptance alone does not authorize Council publication or dependent work. Do not call Council APIs or invent identifiers.\n</council-active-native-review>\n`;
}

/** Keep exactly one executable packet; immutable earlier packets remain in the aggregate. */
export function replaceNativeReviewPacket(description: string, text: string) {
  const blocks = description.match(/\s*<council-active-native-review>[\s\S]*?<\/council-active-native-review>\n?/g) ?? [];
  if (blocks.length > 1) fail("Multiple active native review packets require owner inspection");
  return blocks.length ? description.replace(blocks[0]!, text) : description + text;
}

/** The owner controls the dedicated lead. The plugin only reads this public policy. */
export async function assertNativeLeadWakePolicy(ctx: PluginContext, m: MissionRecord, held: boolean) {
  const agent = await ctx.agents.get(m.aggregate.responsibilities.integrationLeadAgentId, m.companyId);
  const heartbeat = (agent?.runtimeConfig as { heartbeat?: { enabled?: boolean; wakeOnDemand?: boolean } } | undefined)?.heartbeat;
  if (heartbeat?.enabled !== false || heartbeat.wakeOnDemand !== !held) {
    throw new MissionError(409, "native_lead_wake_policy", held
      ? "Owner must disable timer and demand wakes on the dedicated lead before native review handoff"
      : "Owner must restore demand wakes, keeping the dedicated lead timer disabled, after Council correction reservation");
  }
}

export async function freezeNativeReviewPacket(ctx: PluginContext, initial: MissionRecord, sourceRunId: string) {
  let m = initial; let state = storedN2(m);
  if (state.native?.reviewProtocol !== "native-verdict-readback-v1") return m;
  await assertNativeLeadWakePolicy(ctx, m, true);
  const submission = state.submissions.find(s => s.submissionId === state.activeSubmissionId)!;
  const n3 = n3Round(m);
  const packet: NativeReviewPacket = { schema: "council-native-review-v1", missionId: m.missionId, companyId: m.companyId,
    issueId: m.rootIssueId, reviewerAgentId: m.aggregate.responsibilities.finalReviewerAgentId, sourceRunId,
    submission, mandate: m.aggregate.mandate, opinions: n3?.review ?? null };
  if (n3 && (!n3.attestedAt || n3.transmission.runId !== sourceRunId || !n3.specialists.every(s => s.settledAt))) fail("Settled opinions and attested final transmission required");
  const hash = canonicalPayloadHash(packet);
  let record = state.native.reviewPackets?.find(r => r.packet.submission.submissionId === submission.submissionId);
  if (record && record.hash !== hash) fail("Review packet is already frozen for different content");
  if (!record) {
    record = { packet, hash, operationId: randomUUID(), correctionReservationId: randomUUID(), settlementCommandId: randomUUID() };
    m = await n2Cas(ctx, m, { ...m.aggregate, n2: { ...state, native: { ...state.native,
      reviewPackets: [...state.native.reviewPackets ?? [], record] } } });
    state = storedN2(m);
  }
  const issue = await ctx.issues.get(m.rootIssueId, m.companyId);
  const text = nativeReviewPacketText(record);
  if (!issue?.description?.includes(text)) {
    await ctx.issues.update(m.rootIssueId, { description: replaceNativeReviewPacket(issue?.description ?? "", text) }, m.companyId);
  }
  const readback = await ctx.issues.get(m.rootIssueId, m.companyId);
  if (!readback?.description?.includes(text)) fail("Native task context does not contain the exact frozen review packet");
  if (record.publishedAt) return m;
  return n2Cas(ctx, m, { ...m.aggregate, n2: { ...state, native: { ...state.native!,
    reviewPackets: state.native!.reviewPackets!.map(r => r.hash === hash ? { ...r, publishedAt: new Date().toISOString() } : r) } } });
}

export function parseNativeReviewerReport(summary: unknown, record: NativeReviewPacketRecord): NativeReviewerReport {
  if (typeof summary !== "string" || summary.length > 32_000) fail("Bounded terminal reviewer JSON summary required");
  let report: NativeReviewerReport;
  try { report = JSON.parse(summary as string); } catch { return fail("Reviewer terminal summary is not JSON"); }
  const s = record.packet.submission;
  const subject = { submissionId: s.submissionId, candidateCommit: s.candidateCommit, bundleSha256: s.sha256, evidenceRevision: s.evidenceRevision, mandateHash: s.mandateHash };
  if (!report || Object.keys(report).sort().join() !== ["schema", "packetHash", "subject", "verdict", "rationale", "dispositions"].sort().join()
      || report.schema !== "council-native-review-v1" || report.packetHash !== record.hash
      || canonicalPayloadHash(report.subject) !== canonicalPayloadHash(subject)
      || !["approved", "changes_requested"].includes(report.verdict)
      || typeof report.rationale !== "string" || !report.rationale.trim() || report.rationale.length > 4000
      || !Array.isArray(report.dispositions) || report.dispositions.length > 100) fail("Reviewer report differs from the frozen submission or report contract");
  return report;
}

export async function readNativeReviewIdentity(ctx: PluginContext, m: MissionRecord) {
  const state = storedN2(m); const round = state.rounds.at(-1)!;
  if (round.verdict || m.aggregate.control?.status === "blocked" && m.aggregate.control.reason === "correction_limit_exceeded") return null;
  const record = state.native?.reviewPackets?.find(r => r.packet.submission.submissionId === state.activeSubmissionId);
  if (!record?.publishedAt) return null;
  const p = record.packet;
  const cards = (await ctx.issues.listInteractions(m.rootIssueId, m.companyId)).filter(c => c.sourceRunId === p.sourceRunId
    && c.addresseeAgentId === p.reviewerAgentId && (c.payload as any)?.target?.key === "native_completion_review");
  if (!cards.length || cards.length === 1 && cards[0]!.status === "pending") return null;
  if (cards.length !== 1) fail("Exactly one native review card must match the frozen source");
  const card = cards[0]!;
  const target = (card.payload as any)?.target;
  assertResolvedReviewCard(card, p);
  const run = await readNativeRun(ctx, { companyId: p.companyId, issueId: p.issueId, agentId: p.reviewerAgentId, runId: card.resolvedByRunId! });
  if (run.contextSnapshot.nativeReviewInteractionId !== card.id || run.contextSnapshot.nativeReviewDecisionId !== target.revisionId
      ) fail("Native run is not attributed to the exact review card");
  return { record, card, run, binding: { interactionId: card.id, decisionId: target.revisionId as string, sourceRunId: p.sourceRunId } };
}

export type NativeReviewIdentity = NonNullable<Awaited<ReturnType<typeof readNativeReviewIdentity>>>;

/** Called only after exact terminal accounting; invalid business evidence never hides known usage. */
export function validateNativeReviewOutcome(m: MissionRecord, identity: NativeReviewIdentity) {
  const { record, card, run } = identity;
  assertFrozenReviewPacket(m, record);
  if (run.status !== "succeeded" || !run.startedAt || !run.finishedAt) fail("Exact native reviewer must finish successfully before Council validation");
  const report = parseNativeReviewerReport(run.resultJson?.nativeResult?.summary, record);
  if ((report.verdict === "approved") !== (card.status === "accepted")) fail("Terminal reviewer report conflicts with its native verdict");
  const synthesis = synthesizeFrozenOpinions(m, record.packet, report, run.id);
  return { ...identity, report, synthesis };
}

function assertFrozenReviewPacket(m: MissionRecord, record: NativeReviewPacketRecord) {
  const p = record.packet; const state = storedN2(m);
  if (canonicalPayloadHash(p) !== record.hash || canonicalPayloadHash(m.aggregate.mandate) !== canonicalPayloadHash(p.mandate)
      || createHash("sha256").update(JSON.stringify(m.aggregate.mandate)).digest("hex") !== p.submission.mandateHash
      || canonicalPayloadHash(state.submissions.find(s => s.submissionId === state.activeSubmissionId)) !== canonicalPayloadHash(p.submission)) fail("Frozen candidate or mandate changed");
 }

function assertResolvedReviewCard(card: Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number], p: NativeReviewPacket) {
  const target = (card.payload as { target?: { revisionId?: string } }).target;
  if (card.companyId !== p.companyId || card.issueId !== p.issueId || !["accepted", "rejected"].includes(card.status)
      || card.resolvedByAgentId !== p.reviewerAgentId || !card.resolvedByRunId || !card.resolvedAt || typeof target?.revisionId !== "string") fail("Attributed native review verdict required");
 }

function synthesizeFrozenOpinions(m: MissionRecord, p: NativeReviewPacket, report: NativeReviewerReport, runId: string) {
  const current = n3Round(m);
  if (!p.opinions) {
    if (report.dispositions.length || current) fail("Unexpected specialist synthesis");
    return null;
  }
  if (!current) return fail("Frozen N3 round missing");
  const sameInput = canonicalPayloadHash({ ...current.review, synthesis: null, status: p.opinions.status }) === canonicalPayloadHash(p.opinions);
  if (!sameInput || !current.specialists.every(s => s.settledAt) || !current.transmission.settledAt) fail("Frozen N3 opinions or terminal settlements differ");
  return synthesizeN3Review(p.opinions, { ...report, authenticatedAgentId: p.reviewerAgentId, authenticatedRunId: runId });
}
