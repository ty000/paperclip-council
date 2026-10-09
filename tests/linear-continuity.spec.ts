import { prepareLinearContinuity, parseLinearContinuityPolicy } from "../src/linear-continuity-intake.js";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { LINEAR_CONTINUITY_EVENT, LINEAR_CONTINUITY_PROTOCOL, linearAuthorityHash, type LinearContinuityResponse } from "../src/linear-continuity-contract.js";
import { reconcileLinearTransport, handleLinearContinuityNotice, queueLinearPublication } from "../src/linear-continuity-transport.js";
import { applyLinearChanges, assertLinearContinuityDeparture, settleLinearSafePoint } from "../src/linear-continuity-control.js";
import { reconcileLinearCancellation, handleCancellationRequest } from "../src/linear-continuity-cancellation.js";

const f = vi.hoisted(() => ({ m: null as any, bindings: [] as any[], reservations: [] as any[], runStatus: "running", emitted: [] as any[], launch: vi.fn(), settlement: vi.fn(), docs: new Map<string, any>(), issues: new Map<string, any>() }));
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

const ctx = { issues: { documents: {
  get: async (_id: any, key: string) => structuredClone(f.docs.get(key) ?? null),
  upsert: async (input: any) => { const doc = { id: randomUUID(), latestRevisionId: randomUUID(), ...input }; f.docs.set(input.key, doc); return doc; },
}, get: async (id: string) => structuredClone(f.issues.get(id)), update: async (id: string, body: any) => { f.issues.set(id, { ...f.issues.get(id), ...body }); } },
  events: { emit: async (...args: any[]) => { f.emitted.push(args); } } } as any;
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
    previousSourceSha256: state.sourceSha256, sourceSha256: state.sourceSha256, authoritySha256: state.binding.authoritySha256, impact: "context-only", ...extra };
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


it("pins project opt-in before admission and holds incompatible peers without another intake or budget", async () => {
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
  const policy = { authorizedBy: "owner", content: { linearContinuity: { protocol: LINEAR_CONTINUITY_PROTOCOL } } } as any;
  await expect(prepareLinearContinuity(ctx, f.m, policy)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.m.aggregate.phase).toBe("draft"); expect(f.m.aggregate.n1).toBeUndefined(); expect(f.reservations).toEqual([]);
  const challenge = f.m.aggregate.linearContinuity.challenge.challengeId, intent = f.m.aggregate.linearContinuity.publications[0].intentId;
  expect(f.m.aggregate.linearContinuity.binding).toMatchObject({ campaignId: subject.activationId, sourceRootId });
  await expect(prepareLinearContinuity(ctx, structuredClone(f.m), policy)).rejects.toMatchObject({ code: "linear_continuity_hold" });
  expect(f.m.aggregate.linearContinuity.challenge.challengeId).toBe(challenge);
  expect(f.m.aggregate.linearContinuity.publications[0].intentId).toBe(intent);
  expect(parseLinearContinuityPolicy(undefined, null)).toBeUndefined();
  expect(() => parseLinearContinuityPolicy({ protocol: LINEAR_CONTINUITY_PROTOCOL }, null)).toThrow();
  expect(parseLinearContinuityPolicy({ protocol: LINEAR_CONTINUITY_PROTOCOL }, {})).toEqual(policy.content.linearContinuity);
});
