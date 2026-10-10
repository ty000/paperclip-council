// Repository arbitration is exercised with real SQL in repository-occupation tests.
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: vi.fn(async () => {}), releaseReconciledRepository: vi.fn(async () => {}) }));
import { prepareLinearContinuity, parseLinearContinuityPolicy } from "../src/linear-continuity-intake.js";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { LINEAR_CONTINUITY_EVENT, LINEAR_CONTINUITY_PROTOCOL, linearAuthorityHash, type LinearContinuityResponse } from "../src/linear-continuity-contract.js";
import { reconcileLinearTransport, handleLinearContinuityNotice, queueLinearPublication } from "../src/linear-continuity-transport.js";
import { applyLinearChanges, assertLinearContinuityDeparture, settleLinearSafePoint } from "../src/linear-continuity-control.js";
import { reconcileLinearCancellation, handleCancellationRequest } from "../src/linear-continuity-cancellation.js";
import { ensureLinearContextGuidance } from "../src/linear-context-guidance.js";
import { FIXED_CAMPAIGN_MODE, TERMINAL_PUBLICATION_PROTOCOL } from "../src/linear-continuity-contract.js";
import { handleLinearContinuityBoard, reconcileLinearContinuity } from "../src/linear-continuity-runtime.js";
import { repositoryResumptionPublication } from "../src/repository-resumption-publication.js";

const f = vi.hoisted(() => ({ m: null as any, bindings: [] as any[], reservations: [] as any[], runStatus: "running", emitted: [] as any[], launch: vi.fn(), settlement: vi.fn(), terminalClaim: vi.fn(), docs: new Map<string, any>(), issues: new Map<string, any>() }));
vi.mock("../src/missions.js", async original => ({ ...await original(), getMission: async (_c: any, companyId: string, id: string) => f.m?.companyId === companyId && f.m?.missionId === id ? structuredClone(f.m) : null }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original(), n2Cas: async (_c: any, m: any, aggregate: any) => {
  if (m.version !== f.m.version) throw new Error("CAS conflict");
  f.m = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.m);
}, n2CommandCas: async (_c: any, m: any, body: any, _type: string, actorId: string, aggregate: any) => {
  if (body.expectedVersion !== m.version) throw new Error("CAS conflict");
  const receipt = { commandId: body.commandId, actorId, payloadHash: canonicalPayloadHash(body) };
  f.m = { ...m, version: m.version + 1, aggregate: { ...aggregate, commandReceipts: [...aggregate.commandReceipts, receipt] } };
  return { outcome: "applied", mission: structuredClone(f.m), receipt };
}, nativeN2Profile: async () => ({ profile: { periodKey: "original" }, envelope: { version: 1, reservations: f.reservations } }) }));
vi.mock("../src/native-run-bindings.js", () => ({ nativeRunBindings: () => f.bindings }));
vi.mock("../src/native-runs.js", () => ({ assertNativeRunInventory: async () => {} }));
vi.mock("../src/g4-native.js", () => ({ readOrdinaryRun: async () => ({ status: f.runStatus }), settleOrdinaryRunUsage: (...a: any[]) => f.settlement(...a) }));
vi.mock("../src/n5-runtime.js", () => ({ bindPublisher: async (_ctx: any, m: any, input: any) => {
  if (input.actor.agentId !== "publisher" || input.actor.runId !== m.aggregate.n5.publication.runId) throw new Error("foreign publisher"); return m;
}, resumeN5Creation: (...args: any[]) => f.launch(...args) }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: async () => {} }));

vi.mock("../src/linear-terminal-publication.js", () => ({ claimTerminalPublication: (...args: any[]) => f.terminalClaim(...args) }));

const ctx = { issues: { documents: {
  get: async (_id: any, key: string) => structuredClone(f.docs.get(key) ?? null),
  upsert: async (input: any) => { const doc = { id: randomUUID(), latestRevisionId: randomUUID(), ...input }; f.docs.set(input.key, doc); return doc; },
}, get: async (id: string) => structuredClone(f.issues.get(id)), update: async (id: string, body: any) => { f.issues.set(id, { ...f.issues.get(id), ...body }); },
  summaries: { getOrchestration: async () => ({ runs: [] }) } },
  events: { emit: async (...args: any[]) => { f.emitted.push(args); } },
  db: { namespace: "test", query: async () => [] },
  companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) } } as any;
const digest = (char: string) => char.repeat(64);
function proof(key: string, body: any) {
  const doc = { id: randomUUID(), latestRevisionId: randomUUID(), body: JSON.stringify(body), key };
  f.docs.set(key, doc); return { key, documentId: doc.id, revisionId: doc.latestRevisionId, bodySha256: canonicalPayloadHash(doc.body) };
}
beforeEach(() => {
  vi.resetAllMocks(); f.docs.clear(); f.issues.clear(); f.emitted = []; f.bindings = []; f.reservations = []; f.runStatus = "running";
  const companyId = randomUUID(), projectId = randomUUID(), missionId = randomUUID(), rootIssueId = randomUUID();
  const subject = { companyId, targetProjectId: projectId, nativeRootId: rootIssueId, intakeId: `linear-intake-${digest("a")}`,
    activationId: randomUUID(), configurationFingerprint: digest("b"), requestVersion: 1, readinessDocumentId: randomUUID(), readinessRevisionId: randomUUID(), readinessSha256: digest("c"), sourceSha256: digest("d"), planSha256: digest("e") };
  f.m = { companyId, projectId, missionId, rootIssueId, ownerUserId: "owner", version: 1,
    aggregate: { phase: "executing", mandate: { limits: { tokens: 5000 }, objective: "original", acceptanceCriteria: ["original"] },
      responsibilities: {}, compositions: {}, commandReceipts: [], projectMandate: { linearIntake: { subject } } } };
  const binding = { companyId, projectId, missionId, nativeRootId: rootIssueId, campaignId: randomUUID(), sourceRootId: randomUUID(), subject, authoritySha256: linearAuthorityHash(f.m) };
  f.m.aggregate.linearContinuity = { protocol: LINEAR_CONTINUITY_PROTOCOL, binding, authorizedBy: "owner", sourceSha256: subject.sourceSha256,
    sequence: 0, control: "running", consumed: [], publications: [], safeSettlementIds: {} };
  f.launch.mockImplementation(async (_ctx, m) => m);
});
async function answer(overrides: Partial<LinearContinuityResponse> = {}, eventOverrides: any = {}) {
  if (!f.m.aggregate.linearContinuity.challenge) await reconcileLinearTransport(ctx, f.m);
  const state = f.m.aggregate.linearContinuity, c = state.challenge;
  const response: LinearContinuityResponse = { protocol: LINEAR_CONTINUITY_PROTOCOL, binding: state.binding, challengeId: c.challengeId,
    nonce: c.nonce, requestSha256: c.requestSha256, observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 100000).toISOString(),
    capabilities: ["continuous-context", "cooperative-control", "publication-readback"], sourceSha256: state.sourceSha256, availability: "available", changes: [], acknowledgements: [], ...overrides };
  const reference = proof(`peer-response-${randomUUID()}`, response);
  const event = { eventType: LINEAR_CONTINUITY_EVENT, actorType: "plugin", actorId: "ty000.linear-intake", companyId: f.m.companyId,
    occurredAt: new Date().toISOString(), payload: { protocol: LINEAR_CONTINUITY_PROTOCOL, companyId: f.m.companyId, missionId: f.m.missionId, challengeId: c.challengeId, response: reference }, ...eventOverrides };
  await handleLinearContinuityNotice(ctx, event as any); return { response, event, reference };
}
function change(kind = "context", extra: any = {}) {
  const state = f.m.aggregate.linearContinuity;
  const content = { commandId: randomUUID(), sequence: state.sequence + 1, kind, affectedNativeIds: [f.m.rootIssueId],
    previousSourceSha256: state.sourceSha256, sourceSha256: state.sourceSha256, authoritySha256: state.binding.authoritySha256, impact: "context-only",
    ...(kind === "context" ? { context: "Clarify the existing native interface; keep acceptance criteria" } : {}), ...extra };
  return { ...content, evidence: proof(`decision-${content.commandId}`, { command: content }) };
}

it("requires compatibility and preserves legacy missions without opt-in", async () => {
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  const legacy = structuredClone(f.m); delete legacy.aggregate.linearContinuity;
  await expect(assertLinearContinuityDeparture(ctx, legacy)).resolves.toBeUndefined();
  await answer(); await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
});
it("persists request/outbox before hints; lost notification and restart preserve identities", async () => {
  await queueLinearPublication(ctx, f.m, "progress", { phase: "executing" });
  await reconcileLinearTransport(ctx, f.m);
  const before = structuredClone(f.m.aggregate.linearContinuity), count = f.docs.size;
  await queueLinearPublication(ctx, f.m, "progress", { phase: "executing" });
  await reconcileLinearTransport(ctx, structuredClone(f.m));
  expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(before.publications[0].intentId);
  expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(before.challenge.challengeId);
  expect(f.docs.size).toBe(count); expect(f.emitted).toHaveLength(1);
  f.m.aggregate.linearContinuity.challenge.lastEmittedAt = new Date(Date.now() - 31000).toISOString();
  await reconcileLinearTransport(ctx, f.m); expect(f.emitted).toHaveLength(2);
  expect(f.emitted[1][2]).toEqual(f.emitted[0][2]);
});
it("keeps the request window at exactly five minutes even when the clock advances between reads", async () => {
  const now = Date.now(); let reads = 0;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now + ++reads);
  try {
    await reconcileLinearTransport(ctx, f.m);
    const challenge = f.m.aggregate.linearContinuity.challenge;
    expect(Date.parse(challenge.expiresAt) - Date.parse(challenge.requestedAt)).toBe(300_000);
    expect(challenge.payload).toMatchObject({ requestedAt: challenge.requestedAt, expiresAt: challenge.expiresAt });
  } finally { clock.mockRestore(); vi.useRealTimers(); }
});
it("leaves an acknowledged paused fixed campaign quiet across restart and challenge expiry", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const started = Date.now(); fixedCampaign();
    await queueLinearPublication(ctx, f.m, "progress", { phase: "executing" });
    await reconcileLinearTransport(ctx, f.m);
    const runningChallenge = f.m.aggregate.linearContinuity.challenge.challengeId;
    const intent = f.m.aggregate.linearContinuity.publications[0];
    intent.acknowledgement = { reference: proof("paused-quiet-ack", {}), responseSha256: digest("a"), confirmedAt: new Date().toISOString() };
    f.m.aggregate.linearContinuity.control = "paused";
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    const challengeId = f.m.aggregate.linearContinuity.challenge.challengeId, emitted = f.emitted.length;
    expect(challengeId).not.toBe(runningChallenge);
    vi.setSystemTime(started + 600_000);
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(emitted);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
    expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(intent.intentId);
  } finally { vi.useRealTimers(); }
});
it("backs off paused fixed publication reconciliation before rotating an expired challenge", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const started = Date.now(); fixedCampaign(); f.m.aggregate.linearContinuity.control = "paused";
    await queueLinearPublication(ctx, f.m, "progress", { phase: "executing" });
    await reconcileLinearTransport(ctx, f.m);
    const intentId = f.m.aggregate.linearContinuity.publications[0].intentId;
    const challengeId = f.m.aggregate.linearContinuity.challenge.challengeId;
    // Simulate a persisted late hint from the same durable challenge. Its expiry
    // must not bypass the five-minute publication reconciliation cooldown.
    f.m.aggregate.linearContinuity.challenge.lastEmittedAt = new Date(started + 60_000).toISOString();
    vi.setSystemTime(started + 300_000);
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(1);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
    vi.setSystemTime(started + 360_000);
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(2);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).not.toBe(challengeId);
    expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(intentId);
    const rotated = f.m.aggregate.linearContinuity.challenge.challengeId;
    f.m.aggregate.linearContinuity.publications[0].acknowledgement = {
      reference: proof("paused-final-ack", {}), responseSha256: digest("a"), confirmedAt: new Date().toISOString(),
    };
    vi.setSystemTime(started + 900_000);
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(3);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).not.toBe(rotated);
    const acknowledgedChallenge = f.m.aggregate.linearContinuity.challenge.challengeId;
    vi.setSystemTime(started + 1_300_000);
    await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(3);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(acknowledgedChallenge);
  } finally { vi.useRealTimers(); }
});
it("suppresses a duplicate fixed running request while its current response is fresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const started = Date.now(); fixedCampaign();
    await reconcileLinearTransport(ctx, f.m); const challengeId = f.m.aggregate.linearContinuity.challenge.challengeId;
    await fixedAnswer({ observedAt: new Date(started).toISOString(), validUntil: new Date(started + 100_000).toISOString() });
    vi.setSystemTime(started + 31_000); await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(1);
    vi.setSystemTime(started + 101_000); await reconcileLinearTransport(ctx, structuredClone(f.m));
    expect(f.emitted).toHaveLength(2);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
    await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  } finally { vi.useRealTimers(); }
});
it("requests changed fixed outbox, control, consumed input, resume and terminal claim immediately", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    fixedCampaign(); await reconcileLinearTransport(ctx, f.m); await fixedAnswer();
    const challenges = [f.m.aggregate.linearContinuity.challenge.challengeId];
    await queueLinearPublication(ctx, f.m, "progress", { phase: "executing" });
    await reconcileLinearTransport(ctx, f.m); challenges.push(f.m.aggregate.linearContinuity.challenge.challengeId);
    f.m.aggregate.linearContinuity.control = "paused";
    await reconcileLinearTransport(ctx, f.m); challenges.push(f.m.aggregate.linearContinuity.challenge.challengeId);
    f.m.aggregate.linearContinuity.sequence += 1;
    await reconcileLinearTransport(ctx, f.m); challenges.push(f.m.aggregate.linearContinuity.challenge.challengeId);
    f.m.aggregate.linearContinuity.control = "running"; f.m.aggregate.linearContinuity.resumeVersion = f.m.version;
    await reconcileLinearTransport(ctx, f.m); challenges.push(f.m.aggregate.linearContinuity.challenge.challengeId);
    const publication = f.m.aggregate.linearContinuity.publications[0];
    f.m.aggregate.campaignClosure = { terminalClaim: { intentId: publication.intentId, payloadSha256: publication.payloadSha256,
      claimedVersion: f.m.version, claimedAt: new Date().toISOString() } };
    await reconcileLinearTransport(ctx, f.m); challenges.push(f.m.aggregate.linearContinuity.challenge.challengeId);
    expect(new Set(challenges).size).toBe(challenges.length);
    expect(f.emitted).toHaveLength(challenges.length);
  } finally { vi.useRealTimers(); }
});
it("keeps the legacy cadence and refuses departure after an expired source reply", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const started = Date.now(); await reconcileLinearTransport(ctx, f.m); await answer();
    vi.setSystemTime(started + 31_000); await reconcileLinearTransport(ctx, f.m);
    expect(f.emitted).toHaveLength(2);
    vi.setSystemTime(started + 101_000);
    await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  } finally { vi.useRealTimers(); }
});
it.each(["foreign-actor", "foreign-company", "bad-nonce", "old-protocol", "expired"])("rejects %s without advancing authority", async kind => {
  const override: any = {}, event: any = {};
  if (kind === "foreign-actor") event.actorId = "other";
  if (kind === "foreign-company") event.companyId = randomUUID();
  if (kind === "bad-nonce") override.nonce = digest("f");
  if (kind === "expired") override.validUntil = new Date(Date.now() - 1000).toISOString();
  if (kind === "old-protocol") override.protocol = "linear-intake-revalidation-result.v1";
  await answer(override, event).catch(() => {});
  expect(f.m.aggregate.linearContinuity.observation).toBeUndefined();
});
it("duplicate authenticated results do not consume another version; changed revision blocks departure", async () => {
  const { event, reference } = await answer(), version = f.m.version;
  await handleLinearContinuityNotice(ctx, event as any); expect(f.m.version).toBe(version);
  f.docs.get(reference.key).latestRevisionId = randomUUID();
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_document_changed" });
});
it("distinguishes proof-closed work from confirmed external publication and pins original per-effect receipt", async () => {
  await queueLinearPublication(ctx, f.m, "closure", { workResultAcquired: true, proofId: digest("a") });
  await reconcileLinearTransport(ctx, f.m);
  const publication = f.m.aggregate.linearContinuity.publications[0];
  const receipt = proof("peer-readback", { protocol: "linear-publication-readback-v1", bindingSha256: canonicalPayloadHash(f.m.aggregate.linearContinuity.binding),
    intentId: publication.intentId, payloadSha256: publication.payloadSha256, sourceSha256: publication.payload.sourceSha256,
    status: "confirmed", effects: [{ sourceId: f.m.aggregate.linearContinuity.binding.sourceRootId, readbackSha256: digest("b") }] });
  expect(publication.payload.workResultAcquired).toBe(true); expect(publication.acknowledgement).toBeUndefined();
  await answer(); await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toThrow();
  await answer({ acknowledgements: [{ intentId: publication.intentId, payloadSha256: publication.payloadSha256, status: "confirmed", publicationReceipt: receipt }] });
  expect(f.m.aggregate.linearContinuity.publications[0].acknowledgement.reference).toEqual(receipt);
  await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
});
it("applies targeted context without changing mandate, history or budget; replay is idempotent", async () => {
  const original = structuredClone(f.m.aggregate.mandate), update = change("context", { sourceSha256: digest("f") });
  await answer({ changes: [update], sourceSha256: digest("f") }); await applyLinearChanges(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.sourceSha256).toBe(digest("f")); expect(f.m.aggregate.mandate).toEqual(original);
  const version = f.m.version; await applyLinearChanges(ctx, f.m); expect(f.m.version).toBe(version);
  expect(f.m.aggregate.linearContinuity.publications[0].kind).toBe("decision");
  expect(f.m.aggregate.linearContinuity.contextAnnotations[0].context).toBe(update.context);
});
it("delivers an annotation only to its original idle product assignment, without altering other work", async () => {
  const other = randomUUID(), target = f.m.rootIssueId;
  f.m.aggregate.hierarchy = { nodes: [{ issueId: target }, { issueId: other }] };
  for (const id of [target, other]) f.issues.set(id, { id, companyId: f.m.companyId, projectId: f.m.projectId, description: "Original product" });
  const update = change(); await answer({ changes: [update] }); await applyLinearChanges(ctx, f.m);
  await ensureLinearContextGuidance(ctx, f.m, target); await ensureLinearContextGuidance(ctx, f.m, other);
  expect(f.issues.get(target).description).toContain(update.context);
  expect(f.issues.get(other).description).toBe("Original product");
  const retained = f.issues.get(target).description; await ensureLinearContextGuidance(ctx, f.m, target);
  expect(f.issues.get(target).description).toBe(retained);
  f.issues.get(target).executionRunId = randomUUID();
  await expect(ensureLinearContextGuidance(ctx, f.m, target)).rejects.toMatchObject({ code: "linear_context_assignment" });
});
it.each(["scope", "unknown", "foreign-node", "foreign-authority"])("holds %s changes with a native arbitration publication", async kind => {
  const extra = kind === "foreign-node" ? { affectedNativeIds: [randomUUID()] } : kind === "foreign-authority" ? { authoritySha256: digest("f") } : { impact: kind };
  await answer({ changes: [change("context", extra)] }); await applyLinearChanges(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.controlReason).toBe("arbitration_required");
  expect(f.m.aggregate.mandate.objective).toBe("original");
  expect(f.m.aggregate.linearContinuity.publications[0].kind).toBe("question");
});
it("rejects gaps and same-command changed payload without another effect", async () => {
  await answer({ changes: [change("pause", { sequence: 2 })] }); await expect(applyLinearChanges(ctx, f.m)).rejects.toMatchObject({ code: "linear_command_order" });
  const c = change("pause"); await answer({ changes: [c] }); await applyLinearChanges(ctx, f.m);
  f.m.aggregate.linearContinuity.observation.response.changes = [{ ...c, kind: "cancel" }];
  await expect(applyLinearChanges(ctx, f.m)).rejects.toMatchObject({ code: "linear_command_identity" });
});
it("outage blocks new effects while already admitted terminal usage can settle at the safe point", async () => {
  await answer({ availability: "unavailable" }); await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toThrow();
  const reservationId = randomUUID(), runId = randomUUID();
  f.bindings = [{ issueId: f.m.rootIssueId, agentId: "lead", reservationId, runId, pending: false }];
  f.reservations = [{ missionId: f.m.missionId, reservationId, status: "unsettled" }];
  expect((await settleLinearSafePoint(ctx, f.m)).safe).toBe(false); expect(f.settlement).not.toHaveBeenCalled();
  f.runStatus = "succeeded"; f.settlement.mockImplementation(async () => { f.reservations[0] = { ...f.reservations[0], status: "settled", usage: { status: "known" }, remainingExposure: { status: "known", units: 0 } }; });
  expect((await settleLinearSafePoint(ctx, f.m)).safe).toBe(true); expect(f.settlement.mock.calls[0][1].periodKey).toBe("original");
});
it("resume requires a paused safe point and acknowledged arbitration", async () => {
  f.m.aggregate.linearContinuity.control = "paused";
  const c = change("resume"); await answer({ changes: [c] });
  await queueLinearPublication(ctx, f.m, "question", { reason: "pending" });
  await expect(applyLinearChanges(ctx, f.m)).rejects.toMatchObject({ code: "linear_resume_pending" });
  f.m.aggregate.linearContinuity.publications = [];
  await applyLinearChanges(ctx, f.m); expect(f.m.aggregate.linearContinuity.control).toBe("running");
});
it("cancellation closes only idle original product work, retains integrated commits and never reports campaign success", async () => {
  f.m.aggregate.linearContinuity.control = "cancel_requested";
  const node = { issueId: f.m.rootIssueId, parentId: null, assigneeAgentId: null };
  f.m.aggregate.hierarchy = { nodes: [node] };
  f.m.aggregate.n5 = { integration: { state: "verified", report: { integratedCommit: "a".repeat(40) } } };
  f.issues.set(node.issueId, { id: node.issueId, companyId: f.m.companyId, projectId: f.m.projectId, parentId: null, assigneeAgentId: null, status: "blocked" });
  await reconcileLinearCancellation(ctx, f.m);
  expect(f.issues.get(node.issueId).status).toBe("cancelled"); expect(f.launch).not.toHaveBeenCalled();
  expect(f.m.aggregate.linearContinuity.publications[0].payload).toMatchObject({ campaignSuccess: false, integratedCommitRetained: "a".repeat(40) });
});
it("a lost merge outcome cannot become successful cancellation", async () => {
  f.m.aggregate.linearContinuity.control = "cancel_requested"; f.m.aggregate.n5 = { integration: { mergeClaimedAt: new Date().toISOString() } };
  await expect(reconcileLinearCancellation(ctx, f.m)).rejects.toMatchObject({ code: "linear_cancel_merge_unknown" });
  expect(f.m.aggregate.linearContinuity.control).toBe("cancel_requested");
});
it("an admitted cancellation publisher claims close once and observes the same PR", async () => {
  const p = { operation: "cancel-pr", intentId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), reservationId: randomUUID(),
    createdAt: new Date(Date.now() - 1000).toISOString(), targetUrl: "https://github.com/ty000/repo/pull/1", submission: { candidateCommit: "a".repeat(40) } };
  f.m.aggregate.n5 = { publication: p, authority: { repository: "ty000/repo" } };
  f.m.aggregate.linearContinuity.control = "cancel_requested"; f.m.aggregate.linearContinuity.cancellation = { state: "pending" };
  const body = { missionId: f.m.missionId, command: "n5-claim-cancellation", commandId: randomUUID(), expectedVersion: f.m.version,
    report: { protocol: "publisher-cancellation-report-v1", companyId: f.m.companyId, missionId: f.m.missionId, intentId: p.intentId,
      issueId: p.issueId, runId: p.runId, repository: "ty000/repo", url: p.targetUrl, candidateCommit: p.submission.candidateCommit, state: "open", observedAt: new Date().toISOString() } };
  const input = { companyId: f.m.companyId, actor: { actorType: "agent", agentId: "publisher", runId: p.runId }, body } as any;
  expect((await handleCancellationRequest(ctx, input)).body.effectPermission).toBe("execute");
  expect((await handleCancellationRequest(ctx, input)).body.effectPermission).toBe("none");
  input.body = { ...body, commandId: randomUUID(), expectedVersion: f.m.version };
  await expect(handleCancellationRequest(ctx, input)).rejects.toMatchObject({ code: "linear_cancel_effect_claimed" });
  input.body = { ...input.body, command: "n5-observe-cancellation", report: { ...body.report, state: "closed", observedAt: new Date().toISOString() } };
  await handleCancellationRequest(ctx, input); expect(f.m.aggregate.linearContinuity.cancellation.state).toBe("closed");
});

it("persists consumed change and publication intent atomically and requires a linked owner arbitration decision", async () => {
  const held = change("context", { impact: "unknown" });
  await answer({ changes: [held] }); const before = f.m.version;
  await applyLinearChanges(ctx, f.m); expect(f.m.version).toBe(before + 1);
  const intent = f.m.aggregate.linearContinuity.publications[0].intentId;
  expect(f.m.aggregate.linearContinuity.consumed[0].commandId).toBe(held.commandId);
  await applyLinearChanges(ctx, structuredClone(f.m)); expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(intent);
  const dependent = change("context"); await answer({ changes: [dependent] });
  await expect(applyLinearChanges(ctx, f.m)).rejects.toMatchObject({ code: "linear_arbitration_pending" });
  await queueLinearPublication(ctx, f.m, "decision", { resolvesCommandId: held.commandId, authorizedBy: "owner", text: "Keep the original authorized work" });
  const decision = f.m.aggregate.linearContinuity.publications.at(-1);
  decision.acknowledgement = { reference: proof("owner-decision-readback", {}), responseSha256: digest("e"), confirmedAt: new Date().toISOString() };
  await applyLinearChanges(ctx, f.m); expect(f.m.aggregate.linearContinuity.controlReason).toBeUndefined();
  expect(f.m.aggregate.mandate.objective).toBe("original");
});


it("retains every unresolved arbitration when a later held command receives a decision", async () => {
  const first = change("context", { impact: "unknown" }); await answer({ changes: [first] }); await applyLinearChanges(ctx, f.m);
  const last = change("context", { impact: "scope" }); await answer({ changes: [last] }); await applyLinearChanges(ctx, f.m);
  await queueLinearPublication(ctx, f.m, "decision", { resolvesCommandId: last.commandId, authorizedBy: "owner", text: "Keep original work" });
  const decision = f.m.aggregate.linearContinuity.publications.at(-1);
  decision.acknowledgement = { reference: proof("last-decision-readback", {}), responseSha256: digest("e"), confirmedAt: new Date().toISOString() };
  await answer({ changes: [change("context")] });
  await expect(applyLinearChanges(ctx, f.m)).rejects.toMatchObject({ code: "linear_arbitration_pending" });
  expect(f.m.aggregate.linearContinuity.contextAnnotations).toBeUndefined();
});

it.each([undefined, FIXED_CAMPAIGN_MODE])("pins project opt-in (%s) before admission and holds incompatible peers without another intake or budget", async mode => {
  f.m.aggregate.phase = "draft"; delete f.m.aggregate.linearContinuity;
  const subject = f.m.aggregate.projectMandate.linearIntake.subject;
  const sourceRootId = randomUUID();
  const readiness = { ...Object.fromEntries(Object.entries(subject).filter(([key]) => !["readinessDocumentId", "readinessRevisionId", "readinessSha256"].includes(key))),
    schema: "linear-native-readiness.v1", originKind: "plugin:ty000.linear-intake", sourceRootId,
    correspondence: [{ sourceId: sourceRootId, nativeId: f.m.rootIssueId, originId: "source", sourceRevision: new Date().toISOString(), status: "blocked" }],
    effects: Array.from({ length: 3 }, (_, index) => ({ effectKey: `original-${index}`, intentSha256: digest("a"),
      result: { nativeId: f.m.rootIssueId, contentSha256: digest("b") }, resultSha256: digest("c") })),
    externalBlockers: [], importStatus: "prepared", admissionAllowed: false, implementationStarted: false, receivingContract: "unqualified", requiresCurrentSourceAndMandateRevalidation: true };
  f.docs.set("linear-intake-readiness-v1", { id: subject.readinessDocumentId, latestRevisionId: subject.readinessRevisionId, body: JSON.stringify(readiness) });
  const policy = { authorizedBy: "owner", content: { linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, ...(mode ? { mode } : {}) } } } as any;
  await expect(prepareLinearContinuity(ctx, f.m, policy)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.m.aggregate.phase).toBe("draft"); expect(f.m.aggregate.n1).toBeUndefined(); expect(f.reservations).toEqual([]);
  const challenge = f.m.aggregate.linearContinuity.challenge.challengeId, intent = f.m.aggregate.linearContinuity.publications[0].intentId;
  expect(f.m.aggregate.linearContinuity.binding).toMatchObject({ campaignId: mode ? f.m.missionId : subject.activationId, sourceRootId });
  await expect(prepareLinearContinuity(ctx, structuredClone(f.m), policy)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challenge);
  expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(intent);
  expect(parseLinearContinuityPolicy(undefined, null)).toBeUndefined();
  expect(() => parseLinearContinuityPolicy({ protocol: LINEAR_CONTINUITY_PROTOCOL }, null)).toThrow();
  expect(parseLinearContinuityPolicy(policy.content.linearContinuity, {})).toEqual(policy.content.linearContinuity);
});

function fixedCampaign() {
  f.m.aggregate.linearContinuity.mode = FIXED_CAMPAIGN_MODE;
  f.m.aggregate.linearContinuity.terminalPublicationProtocol = TERMINAL_PUBLICATION_PROTOCOL;
  return { mode: FIXED_CAMPAIGN_MODE, capabilities: ["fixed-source", "publication-readback", "terminal-publication-claim"] } as const;
}
function nativeControl(command: string, extra: any = {}) {
  return { companyId: f.m.companyId, actor: { actorType: "user", userId: "owner" }, body: {
    missionId: f.m.missionId, command, commandId: randomUUID(), expectedVersion: f.m.version, reason: "Operator decision", ...extra,
  } } as any;
}
async function fixedAnswer(extra: Partial<LinearContinuityResponse> = {}) {
  return answer({ mode: FIXED_CAMPAIGN_MODE, capabilities: ["fixed-source", "publication-readback", "terminal-publication-claim"], ...extra });
}
function confirmPublications() {
  for (const p of f.m.aggregate.linearContinuity.publications) p.acknowledgement = {
    reference: proof(`ack-${p.intentId}`, { intentId: p.intentId }), responseSha256: digest("a"), confirmedAt: new Date().toISOString(),
  };
}
it("lets only the native owner Board refresh the durable fixed challenge without retry churn", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const started = Date.now(); fixedCampaign(); f.m.aggregate.linearContinuity.control = "paused";
    const request = nativeControl("reconcile-linear-continuity");
    const response = await handleLinearContinuityBoard(ctx, request);
    expect(response.body.outcome).toBe("reconciled");
    const challengeId = f.m.aggregate.linearContinuity.challenge.challengeId;
    await fixedAnswer();
    const observation = structuredClone(f.m.aggregate.linearContinuity.observation);
    await handleLinearContinuityBoard(ctx, request);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
    expect(f.m.aggregate.linearContinuity.observation).toEqual(observation);
    expect(f.emitted).toHaveLength(1);
    vi.setSystemTime(started + 31_000); await handleLinearContinuityBoard(ctx, request);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
    expect(f.emitted).toHaveLength(2);
    vi.setSystemTime(started + 301_000); await handleLinearContinuityBoard(ctx, request);
    expect(f.m.aggregate.linearContinuity.challenge.challengeId).not.toBe(challengeId);
    expect(f.emitted).toHaveLength(3);
    await expect(handleLinearContinuityBoard(ctx, {
      ...nativeControl("reconcile-linear-continuity"), actor: { actorType: "agent", agentId: "owner" },
    })).rejects.toMatchObject({ code: "linear_continuity_owner" });
    await expect(handleLinearContinuityBoard(ctx, {
      ...nativeControl("reconcile-linear-continuity"), actor: { actorType: "user", userId: "other-owner" },
    })).rejects.toMatchObject({ code: "linear_continuity_owner" });
  } finally { vi.useRealTimers(); }
});
it("keeps legacy owner reconciliation on its cooperative remote-resume cadence", async () => {
  await queueLinearPublication(ctx, f.m, "progress", { phase: f.m.aggregate.phase, control: "running",
    sourceRevision: f.m.aggregate.linearContinuity.sourceSha256, workResultAcquired: false, n5State: null });
  await reconcileLinearTransport(ctx, f.m); await answer();
  const challengeId = f.m.aggregate.linearContinuity.challenge.challengeId;
  const observation = structuredClone(f.m.aggregate.linearContinuity.observation);
  const emitted = f.emitted.length;
  await handleLinearContinuityBoard(ctx, nativeControl("reconcile-linear-continuity"));
  expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challengeId);
  expect(f.m.aggregate.linearContinuity.observation).toEqual(observation);
  expect(f.emitted).toHaveLength(emitted);
});
it("continues local safe settlement while fixed source polling is paused", async () => {
  fixedCampaign(); f.m.aggregate.linearContinuity.control = "paused";
  const reservationId = randomUUID(), runId = randomUUID();
  f.bindings = [{ issueId: f.m.rootIssueId, agentId: "lead", reservationId, runId, pending: false }];
  f.reservations = [{ missionId: f.m.missionId, reservationId, status: "unsettled" }];
  f.runStatus = "succeeded";
  f.settlement.mockImplementation(async () => {
    f.reservations[0] = { ...f.reservations[0], status: "settled", usage: { status: "known" }, remainingExposure: { status: "known", units: 0 } };
  });
  await reconcileLinearContinuity(ctx, f.m);
  expect(f.settlement).toHaveBeenCalledOnce();
});
it("retains the resumed campaign plan until its exact publication receipt is read back, then rejects receipt drift", async () => {
  fixedCampaign();
  const content = { campaignPlan: { schema: "council-linear-delivery-plan-v1" }, ...repositoryResumptionPublication({ repositoryResumptions: [{
    commandId: randomUUID(), payloadHash: digest("f"), ownerUserId: "owner", policyRevisionId: randomUUID(), heldIntakeVersion: 4,
    resumedAt: new Date().toISOString(), decision: { question: "Dépôt occupé", questionAuthor: "Council", response: "Reprendre la vérification",
      consequences: "Attendre le plan confirmé" } }] }) };
  await queueLinearPublication(ctx, f.m, "progress", content);
  await reconcileLinearTransport(ctx, f.m); await fixedAnswer();
  const publication = structuredClone(f.m.aggregate.linearContinuity.publications[0]);
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await queueLinearPublication(ctx, f.m, "progress", content); await reconcileLinearTransport(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.publications).toEqual([publication]);
  const receipt = proof("recovery-plan-readback", { protocol: "linear-publication-readback-v1", bindingSha256: canonicalPayloadHash(f.m.aggregate.linearContinuity.binding),
    intentId: publication.intentId, payloadSha256: publication.payloadSha256, sourceSha256: publication.payload.sourceSha256,
    status: "confirmed", effects: [{ sourceId: f.m.aggregate.linearContinuity.binding.sourceRootId, readbackSha256: digest("b") }] });
  await fixedAnswer({ acknowledgements: [{ intentId: publication.intentId, payloadSha256: publication.payloadSha256, status: "confirmed", publicationReceipt: receipt }] });
  await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
  f.docs.get(receipt.key).latestRevisionId = randomUUID();
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_document_changed" });
});
it("fixed campaigns negotiate their terminal claim capability and reject remote commands and legacy replies", async () => {
  fixedCampaign();
  await answer(); expect(f.m.aggregate.linearContinuity.observation).toBeUndefined();
  await expect(fixedAnswer({ changes: [change("pause")] })).rejects.toThrow();
  expect(f.m.aggregate.linearContinuity.observation).toBeUndefined();
  await fixedAnswer(); await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
  expect(f.m.aggregate.linearContinuity.challenge.payload.mode).toBe(FIXED_CAMPAIGN_MODE);
});
it("a fixed source change persists a pause and one blocker without adopting the new content", async () => {
  fixedCampaign(); const original = f.m.aggregate.linearContinuity.sourceSha256;
  await fixedAnswer({ sourceSha256: digest("f") });
  await applyLinearChanges(ctx, f.m);
  expect(f.m.aggregate.linearContinuity).toMatchObject({ sourceSha256: original, control: "pause_requested", controlReason: "source_changed" });
  const retained = structuredClone(f.m.aggregate.linearContinuity.publications);
  await applyLinearChanges(ctx, structuredClone(f.m));
  expect(f.m.aggregate.linearContinuity.publications).toEqual(retained);
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await fixedAnswer(); await applyLinearChanges(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.control).toBe("pause_requested");
});
it.each(["draft", "executing", "reviewing", "accepted"])("native pause/resume preserves %s, identities and consumed budget", async phase => {
  fixedCampaign(); f.m.aggregate.phase = phase; await fixedAnswer();
  const originalId = f.m.missionId, originalMandate = structuredClone(f.m.aggregate.mandate);
  const request = nativeControl("pause-linear-campaign");
  await handleLinearContinuityBoard(ctx, request);
  const version = f.m.version;
  expect((await handleLinearContinuityBoard(ctx, request)).body).toMatchObject({ outcome: "replayed", effectPermission: "none" });
  expect(f.m.version).toBe(version);
  await reconcileLinearContinuity(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.control).toBe("paused");
  f.m.aggregate.linearContinuity.observation = undefined;
  await expect(handleLinearContinuityBoard(ctx, nativeControl("resume-linear-campaign"))).rejects.toMatchObject({ code: "linear_campaign_resume_pending" });
  const retainedIntents = f.m.aggregate.linearContinuity.publications.map((p: any) => p.intentId);
  await fixedAnswer();
  await handleLinearContinuityBoard(ctx, nativeControl("resume-linear-campaign"));
  expect(f.m.aggregate.linearContinuity.publications.slice(0, retainedIntents.length).map((p: any) => p.intentId)).toEqual(retainedIntents);
  expect(f.m.aggregate.phase).toBe(phase); expect(f.m.missionId).toBe(originalId);
  expect(f.m.aggregate.mandate).toEqual(originalMandate); expect(f.reservations).toEqual([]);
  expect(f.m.aggregate.linearContinuity.control).toBe("running");
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await fixedAnswer(); confirmPublications(); await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
});
it("native commands require the current owner, original command payload and nonterminal campaign", async () => {
  fixedCampaign(); const input = nativeControl("pause-linear-campaign");
  await expect(handleLinearContinuityBoard(ctx, { ...input, actor: { actorType: "agent", agentId: "owner" } })).rejects.toMatchObject({ code: "linear_continuity_owner" });
  await handleLinearContinuityBoard(ctx, input);
  await expect(handleLinearContinuityBoard(ctx, { ...input, body: { ...input.body, reason: "changed" } })).rejects.toThrow();
  f.m.aggregate.completion = { state: "closed" };
  await expect(handleLinearContinuityBoard(ctx, nativeControl("cancel-linear-campaign"))).rejects.toMatchObject({ code: "linear_campaign_terminal" });
});
it("fixed cancellation retains an open PR for manual cleanup without waking a publisher", async () => {
  fixedCampaign(); await handleLinearContinuityBoard(ctx, nativeControl("cancel-linear-campaign"));
  const node = { issueId: f.m.rootIssueId, parentId: null, assigneeAgentId: null };
  f.m.aggregate.hierarchy = { nodes: [node] };
  f.issues.set(node.issueId, { companyId: f.m.companyId, projectId: f.m.projectId, ...node, id: node.issueId, status: "blocked" });
  const url = "https://github.com/ty000/repo/pull/1";
  f.m.aggregate.n5 = { publication: { claimedAt: new Date().toISOString(), observation: { state: "open", url, matchesCandidate: true }, settledAt: new Date().toISOString() } };
  await reconcileLinearCancellation(ctx, f.m);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.m.aggregate.n5.publication.operation).toBeUndefined();
  expect(f.m.aggregate.linearContinuity.control).toBe("cancelled");
  expect(f.m.aggregate.linearContinuity.publications.at(-1).payload).toMatchObject({ campaignSuccess: false, pullRequestCleanup: "manual", openPullRequest: url });
});
it("fixed cancellation retains an unknown original PR outcome and blocks cleanup bypass", async () => {
  fixedCampaign(); f.m.aggregate.linearContinuity.control = "cancel_requested";
  f.m.aggregate.n5 = { publication: { claimedAt: new Date().toISOString(), operation: "cancel-pr", reservationId: randomUUID() } };
  await expect(reconcileLinearCancellation(ctx, f.m)).rejects.toMatchObject({ code: "linear_cancel_effect_unknown" });
  await expect(assertLinearContinuityDeparture(ctx, f.m, f.m.aggregate.n5.publication.reservationId)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.launch).not.toHaveBeenCalled(); expect(f.m.aggregate.linearContinuity.control).toBe("cancel_requested");
});
it("fixed policy is opt-in and rejects unknown modes or fields", () => {
  expect(parseLinearContinuityPolicy({ protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE }, {})).toEqual({ protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE });
  for (const extra of [{ mode: "auto" }, { autoCleanup: true }]) expect(() => parseLinearContinuityPolicy({ protocol: LINEAR_CONTINUITY_PROTOCOL, ...extra }, {})).toThrow();
});
it("project preparation rejects a pre-existing legacy continuity state instead of downgrading fixed policy", async () => {
  f.m.aggregate.phase = "draft";
  const before = structuredClone(f.m);
  const policy = { content: { linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE } } } as any;
  await expect(prepareLinearContinuity(ctx, f.m, policy)).rejects.toMatchObject({ code: "linear_continuity_policy_changed" });
  expect(f.m).toEqual(before); expect(f.emitted).toHaveLength(0);
  fixedCampaign();
  await expect(prepareLinearContinuity(ctx, f.m, policy)).rejects.toMatchObject({ code: "linear_continuity_policy_changed" });
});
it("manual owner configuration cannot opt a fixed-policy project into legacy remote controls", async () => {
  f.m.aggregate.phase = "draft"; f.m.aggregate.projectMandate.revisionId = "pinned-policy";
  const binding = f.m.aggregate.linearContinuity.binding; delete f.m.aggregate.linearContinuity;
  const fixedCtx = { ...ctx, db: { namespace: "council", query: async () => [{ revision_id: "pinned-policy", version: 1,
    content: { linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL, mode: FIXED_CAMPAIGN_MODE } } }] } };
  await expect(handleLinearContinuityBoard(fixedCtx, nativeControl("configure-linear-continuity", { binding }))).rejects.toMatchObject({ code: "linear_continuity_project_policy" });
  expect(f.m.aggregate.linearContinuity).toBeUndefined(); expect(f.emitted).toHaveLength(0);
});


it.each(["source_changed", "source_state_changed", "source_unavailable", "publication_unavailable"] as const)("persists %s before another healthy response and requires explicit resume", async code => {
  fixedCampaign();
  const source = f.m.aggregate.linearContinuity.sourceSha256;
  await fixedAnswer({ availability: "unavailable", diagnostic: { code, expectedSourceSha256: source,
    changedFields: code === "source_changed" ? ["description"] : [], changedSourceIds: [] } });
  // No job processed the first response: a subsequent healthy read still cannot erase the hold.
  await fixedAnswer();
  expect(f.m.aggregate.linearContinuity).toMatchObject({ control: "pause_requested", controlReason: code, controlDiagnostic: { code } });
  await applyLinearChanges(ctx, f.m); await applyLinearChanges(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.publications.filter((p: any) => p.kind === "blocker")).toHaveLength(1);
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await reconcileLinearContinuity(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.control).toBe("paused");
  await handleLinearContinuityBoard(ctx, nativeControl("resume-linear-campaign"));
  expect(f.m.aggregate.linearContinuity.resumeVersion).toBe(f.m.version);
  expect(f.m.aggregate.linearContinuity.controlDiagnostic).toBeUndefined();
  await fixedAnswer(); confirmPublications(); await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
});

it("retains an intake source hold even if its first unavailable reply was lost and rejects that old challenge after resume", async () => {
  fixedCampaign();
  // Intake observed an outage but its first reply never arrived; the source is now restored.
  const { event } = await fixedAnswer({ availability: "available", diagnostic: { code: "source_unavailable",
    expectedSourceSha256: f.m.aggregate.linearContinuity.sourceSha256, changedFields: [], changedSourceIds: [] } });
  expect(f.m.aggregate.linearContinuity).toMatchObject({ control: "pause_requested", controlReason: "source_unavailable" });
  await reconcileLinearContinuity(ctx, f.m);
  expect(f.m.aggregate.linearContinuity.control).toBe("paused");
  await handleLinearContinuityBoard(ctx, nativeControl("resume-linear-campaign"));
  const resumedVersion = f.m.version;
  expect(f.m.aggregate.linearContinuity).toMatchObject({ control: "running", resumeVersion: resumedVersion });
  expect(f.m.aggregate.linearContinuity.observation).toBeUndefined();
  expect(f.m.aggregate.linearContinuity.challenge).toBeUndefined();
  await handleLinearContinuityNotice(ctx, event as any);
  expect(f.m.version).toBe(resumedVersion);
  expect(f.m.aggregate.linearContinuity.controlDiagnostic).toBeUndefined();
  await expect(assertLinearContinuityDeparture(ctx, f.m)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await fixedAnswer(); confirmPublications();
  await handleLinearContinuityNotice(ctx, event as any);
  expect(f.m.aggregate.linearContinuity.control).toBe("running");
  await expect(assertLinearContinuityDeparture(ctx, f.m)).resolves.toBeUndefined();
});

it("does not upgrade an old fixed campaign or accept a peer without the terminal claim capability", async () => {
  fixedCampaign();
  await expect(fixedAnswer({ capabilities: ["fixed-source", "publication-readback"] })).rejects.toThrow();
  expect(f.m.aggregate.linearContinuity.observation).toBeUndefined();
  delete f.m.aggregate.linearContinuity.terminalPublicationProtocol;
  await expect(reconcileLinearTransport(ctx, f.m)).rejects.toMatchObject({ code: "linear_terminal_protocol_missing" });
  await expect(handleLinearContinuityBoard(ctx, nativeControl("pause-linear-campaign"))).rejects.toMatchObject({ code: "linear_terminal_protocol_missing" });
});


it("retries the same terminal claim after observation persistence without accepting a new result identity", async () => {
  fixedCampaign();
  const terminalClaimRequest = { intentId: randomUUID(), payloadSha256: digest("b") };
  f.terminalClaim.mockRejectedValueOnce(new Error("response lost after observation persistence"));
  await expect(fixedAnswer({ terminalClaimRequest })).rejects.toThrow(/response lost/);
  const state = f.m.aggregate.linearContinuity, version = f.m.version;
  const event = { eventType: LINEAR_CONTINUITY_EVENT, actorType: "plugin", actorId: "ty000.linear-intake", companyId: f.m.companyId,
    occurredAt: new Date().toISOString(), payload: { protocol: LINEAR_CONTINUITY_PROTOCOL, companyId: f.m.companyId,
      missionId: f.m.missionId, challengeId: state.challenge.challengeId, response: state.observation.reference } };
  await handleLinearContinuityNotice(ctx, event as any);
  expect(f.terminalClaim).toHaveBeenCalledTimes(2);
  expect(f.terminalClaim.mock.calls[1]!.slice(2)).toEqual(f.terminalClaim.mock.calls[0]!.slice(2));
  expect(f.m.version).toBe(version);
});
