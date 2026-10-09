import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "../src/missions.js";
import { claimTerminalPublication } from "../src/linear-terminal-publication.js";
import { controlFixedCampaign } from "../src/linear-campaign-control.js";
import { assertLinearContinuityDeparture } from "../src/linear-continuity-control.js";
import { assertProjectDeparture } from "../src/project-mandate-guard.js";
import { currentCampaignClosureSubject } from "../src/campaign-closure-subject.js";
import { linearAuthorityHash, pendingLinearPublication, TERMINAL_PUBLICATION_PROTOCOL } from "../src/linear-continuity-contract.js";
import { reconcileLinearTransport } from "../src/linear-continuity-transport.js";

const f = vi.hoisted(() => ({ mission: null as MissionRecord | null, docs: new Map<string, any>(), emitted: vi.fn(), cas: vi.fn() }));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(), getMission: async () => structuredClone(f.mission) }));
vi.mock("../src/n2-missions.js", async original => ({ ...await original<any>(), n2Cas: (...args: any[]) => f.cas(...args),
  n2CommandCas: async (ctx: any, before: MissionRecord, body: any, _type: any, _owner: any, aggregate: any) => {
    if (body.expectedVersion !== before.version) throw new MissionError(409, "version_conflict", "stale command");
    return { outcome: "applied", mission: await f.cas(ctx, before, aggregate) };
  },
}));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: vi.fn() }));
vi.mock("../src/campaign-closure-subject.js", () => ({ currentCampaignClosureSubject: vi.fn() }));
vi.mock("../src/linear-continuity-control.js", async original => ({ ...await original<any>(),
  settleLinearSafePoint: async (_ctx: any, m: MissionRecord) => ({ mission: m, safe: true }),
}));

const hash = canonicalPayloadHash;
const ctx = { issues: { documents: {
  get: async (_issue: string, key: string) => structuredClone(f.docs.get(key)),
  upsert: async (input: any) => { f.docs.set(input.key, { ...input, id: randomUUID(), latestRevisionId: randomUUID() }); },
} }, events: { emit: (...args: any[]) => f.emitted(...args) } } as any;
function document(key: string, value: any) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const doc = { key, body, id: randomUUID(), latestRevisionId: randomUUID() };
  f.docs.set(key, doc);
  return { key, documentId: doc.id, revisionId: doc.latestRevisionId, bodySha256: hash(body) };
}
function m() { return structuredClone(f.mission!); }
function command(name: string) {
  return controlFixedCampaign(ctx, m(), { command: name, commandId: randomUUID(), expectedVersion: f.mission!.version, reason: "Operator decision" }, "owner");
}
function request() { const closure = f.mission!.aggregate.campaignClosure!; return { intentId: closure.publicationIntentId!, payloadSha256: closure.publicationPayloadSha256! }; }
function claim() { return claimTerminalPublication(ctx, m(), request(), f.mission!.aggregate.linearContinuity!.observation!.bodySha256); }

beforeEach(() => {
  vi.resetAllMocks(); f.docs.clear();
  const companyId = randomUUID(), projectId = randomUUID(), missionId = randomUUID(), rootIssueId = randomUUID();
  const sourceSubject = { companyId, nativeRootId: rootIssueId, targetProjectId: projectId };
  const subject = { sourceSha256: hash("source"), mandateSha256: hash("mandate"), coverageSha256: hash("coverage"), resultsSha256: hash("results") };
  const report = { verdict: "approved", rows: [] };
  const proof = document("global-proof", "exact proof");
  f.mission = { companyId, projectId, missionId, rootIssueId, version: 1, ownerUserId: "owner", aggregate: {
    mandate: {}, compositions: {}, responsibilities: {}, projectMandate: { linearIntake: { subject: sourceSubject } },
    campaignClosure: { phase: "publishing", subject, report, reportSha256: hash(report),
      proofDocument: { key: proof.key, body: "exact proof", revisionId: proof.revisionId }, nativeClosures: [] },
  } } as unknown as MissionRecord;
  const binding = { companyId, projectId, missionId, nativeRootId: rootIssueId, campaignId: missionId,
    sourceRootId: randomUUID(), subject: sourceSubject, authoritySha256: linearAuthorityHash(f.mission) };
  const payload = { kind: "closure", binding, sourceSha256: subject.sourceSha256 }, intentId = randomUUID(), payloadSha256 = hash(payload);
  Object.assign(f.mission.aggregate.campaignClosure!, { publicationIntentId: intentId, publicationPayloadSha256: payloadSha256 });
  const now = Date.now();
  const response = { availability: "available", sourceSha256: subject.sourceSha256, terminalClaimRequest: { intentId, payloadSha256 },
    observedAt: new Date(now).toISOString(), validUntil: new Date(now + 120_000).toISOString() };
  f.mission.aggregate.linearContinuity = { mode: "milestone-fixed-v1", protocol: "council-linear-continuity-v1",
    terminalPublicationProtocol: TERMINAL_PUBLICATION_PROTOCOL, binding, sourceSha256: subject.sourceSha256,
    control: "running", sequence: 0, consumed: [], safeSettlementIds: {}, publications: [{ intentId, kind: "closure", payload,
      payloadSha256, documentKey: `terminal-${intentId}` }],
    observation: { reference: document("observation", response), bodySha256: hash(response), response },
  } as any;
  f.cas.mockImplementation(async (_ctx, before: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
    if (before.version !== f.mission!.version) throw new MissionError(409, "version_conflict", "Mission changed concurrently");
    f.mission = { ...before, version: before.version + 1, aggregate }; return m();
  });
  vi.mocked(assertProjectDeparture).mockImplementation((context, mission, cancellation, intent) => assertLinearContinuityDeparture(context, mission, cancellation, intent));
  vi.mocked(currentCampaignClosureSubject).mockResolvedValue(subject as any);
});

it("retains an intent without permission, then publishes the exact persisted grant across restart", async () => {
  await reconcileLinearTransport(ctx, m());
  expect((f.mission!.aggregate.linearContinuity!.challenge!.payload.publications as any[])[0].terminalClaim).toBeUndefined();
  const before = f.mission!.aggregate.linearContinuity!.challenge!.challengeId;
  const claimed = await claim(), retained = claimed.aggregate.campaignClosure!.terminalClaim;
  expect(retained).toMatchObject({ ...request(), claimedVersion: claimed.version });
  expect(f.emitted).toHaveBeenCalledTimes(1); // Claim persists; the existing job emits later.
  await reconcileLinearTransport(ctx, m());
  expect(f.mission!.aggregate.linearContinuity!.challenge!.challengeId).not.toBe(before);
  expect((f.mission!.aggregate.linearContinuity!.challenge!.payload.publications as any[])[0].terminalClaim).toEqual(retained);
  const version = f.mission!.version;
  await claim();
  expect(f.mission!.version).toBe(version);
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toEqual(retained);
});

it("allows pause before the terminal claim and rejects the old running request", async () => {
  await command("pause-linear-campaign");
  await expect(claim()).rejects.toMatchObject({ code: "linear_terminal_claim_held" });
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toBeUndefined();
  expect(f.mission!.aggregate.linearContinuity!.publications[0]!.withdrawn).toBeUndefined();
});

it("withdraws unclaimed closure on cancellation without fabricating a successful ACK", async () => {
  await command("cancel-linear-campaign");
  const terminal = f.mission!.aggregate.linearContinuity!.publications[0]!;
  expect(terminal.withdrawn?.reason).toBe("cancelled_before_terminal_claim");
  expect(terminal.acknowledgement).toBeUndefined(); expect(pendingLinearPublication(terminal)).toBe(false);
  await expect(claim()).rejects.toMatchObject({ code: "linear_terminal_claim_identity" });
  await reconcileLinearTransport(ctx, m());
  expect((f.mission!.aggregate.linearContinuity!.challenge!.payload.publications as any[]).some(p => p.intentId === terminal.intentId)).toBe(false);
});

it("a stop winning during claim checks defeats the final mission CAS", async () => {
  vi.mocked(currentCampaignClosureSubject).mockImplementationOnce(async () => {
    const subject = m().aggregate.campaignClosure!.subject;
    await command("cancel-linear-campaign"); return subject;
  });
  await expect(claim()).rejects.toMatchObject({ code: "version_conflict" });
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toBeUndefined();
  expect(f.mission!.aggregate.linearContinuity!.control).toBe("cancel_requested");
  expect(f.emitted).not.toHaveBeenCalled();
});

it.each(["pause-linear-campaign", "cancel-linear-campaign"])("a persisted claim wins against later %s", async name => {
  await claim(); const retained = f.mission!.aggregate.campaignClosure!.terminalClaim;
  await expect(command(name)).rejects.toMatchObject({ code: "linear_campaign_terminal_claimed" });
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toEqual(retained);
});

it("resumes a source hold after the claim with the same grant and an explicit new resume version", async () => {
  await claim(); const retained = f.mission!.aggregate.campaignClosure!.terminalClaim;
  Object.assign(f.mission!.aggregate.linearContinuity!, { control: "paused", controlReason: "source_unavailable",
    controlDiagnostic: { code: "source_unavailable", expectedSourceSha256: hash("source"), changedFields: [], changedSourceIds: [] } });
  await command("resume-linear-campaign");
  expect(f.mission!.aggregate.linearContinuity).toMatchObject({ control: "running", resumeVersion: f.mission!.version });
  expect(f.mission!.aggregate.linearContinuity!.controlDiagnostic).toBeUndefined();
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toEqual(retained);
  await reconcileLinearTransport(ctx, m());
  expect(f.mission!.aggregate.linearContinuity!.challenge!.payload.resumeVersion).toBe(f.mission!.aggregate.linearContinuity!.resumeVersion);
});

it.each(["protocol", "foreign intent", "mutated payload", "stale subject", "missing proof", "authority", "source", "other pending"])("refuses %s without a grant", async failure => {
  const state = f.mission!.aggregate.linearContinuity!;
  if (failure === "protocol") delete state.terminalPublicationProtocol;
  if (failure === "foreign intent") f.mission!.aggregate.campaignClosure!.publicationIntentId = randomUUID();
  if (failure === "mutated payload") state.publications[0]!.payload.changed = true;
  if (failure === "stale subject") vi.mocked(currentCampaignClosureSubject).mockResolvedValue({ ...f.mission!.aggregate.campaignClosure!.subject, resultsSha256: hash("new") });
  if (failure === "missing proof") f.docs.delete("global-proof");
  if (failure === "authority") vi.mocked(assertProjectDeparture).mockRejectedValue(new MissionError(409, "project_authority_changed", "revoked"));
  if (failure === "source") state.observation!.response.availability = "unavailable";
  if (failure === "other pending") state.publications.push({ ...state.publications[0]!, intentId: randomUUID(), kind: "progress" });
  await expect(claim()).rejects.toThrow();
  expect(f.mission!.aggregate.campaignClosure!.terminalClaim).toBeUndefined(); expect(f.emitted).not.toHaveBeenCalled();
});

it("a narrow terminal allowance cannot waive any other pending publication or authorize ordinary work", async () => {
  await expect(assertLinearContinuityDeparture(ctx, m())).rejects.toMatchObject({ code: "linear_continuity_hold" });
  await expect(assertLinearContinuityDeparture(ctx, m(), undefined, request())).resolves.toBeUndefined();
  await expect(assertLinearContinuityDeparture(ctx, m(), undefined, { ...request(), intentId: randomUUID() })).rejects.toThrow();
  f.mission!.aggregate.repositoryCampaign = { campaignRootMissionId: randomUUID() };
  await expect(assertLinearContinuityDeparture(ctx, m(), undefined, request())).rejects.toThrow();
});
