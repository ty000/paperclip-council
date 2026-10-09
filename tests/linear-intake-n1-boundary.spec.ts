// Repository arbitration is exercised with real SQL in repository-occupation tests.
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: vi.fn(async () => {}), releaseReconciledRepository: vi.fn(async () => {}) }));
const campaign = vi.hoisted(() => ({ root: null as any, continuity: vi.fn(async () => undefined), predecessor: vi.fn(async () => undefined) }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: vi.fn(async () => undefined), assertProjectPaths: vi.fn(), assertProjectPublication: vi.fn() }));
vi.mock("../src/repository-campaign.js", () => ({ campaignRoot: async () => campaign.root }));
vi.mock("../src/linear-continuity-control.js", async original => ({ ...await original<any>(), assertLinearContinuityDeparture: (...args: any[]) => campaign.continuity(...args) }));
vi.mock("../src/delivery-leaves.js", async original => ({ ...await original<any>(), assertDeliveryPredecessor: (...args: any[]) => campaign.predecessor(...args) }));
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { linearFixture } from "./linear-intake-fixture.js";
import { canonicalPayloadHash as hash } from "../src/mission-primitives.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { executeN1BoardCommand } from "../src/n1-missions.js";
import { readAdmission, reserveAdmission, settleAdmission } from "../src/admission.js";

vi.mock("../src/admission.js", async original => ({ ...await original<any>(), readAdmission: vi.fn(), reserveAdmission: vi.fn(), settleAdmission: vi.fn() }));

function fixture() {
  const f = linearFixture(), { ids, policy } = f;
  const missionId = randomUUID(), config = { n1FixtureMode: "ephemeral-local-sandbox" };
  policy.content.operatingProfileHash = operatingProfileHash(config);
  const subject = { companyId: ids.company, intakeId: f.readiness.intakeId, activationId: ids.activation,
    configurationFingerprint: f.readiness.configurationFingerprint, requestVersion: 3, nativeRootId: ids.root,
    targetProjectId: ids.project, sourceSha256: f.readiness.sourceSha256, planSha256: f.readiness.planSha256,
    readinessDocumentId: f.readinessDocument.id, readinessRevisionId: f.readinessDocument.latestRevisionId, readinessSha256: hash("receipt fixture") };
  const pinned = { subject, bodySha256: hash(f.readiness) };
  const body = { companyId: ids.company, command: "activate", commandId: randomUUID(), expectedVersion: 1,
    periodKey: "original-period", reservationId: randomUUID(), requestedUnits: 3 };
  const mandate = { ...policy.content.template, objective: "Explicit imported source objective" };
  const state: any = { commands: { activate: structuredClone(body) }, linearIntake: { snapshot: structuredClone(pinned) } };
  const aggregate: any = { schemaVersion: 1, missionId, companyId: ids.company, rootIssueId: ids.root, projectId: ids.project, ownerUserId: ids.owner,
    phase: "draft", control: { status: "inactive" }, mandate, hierarchy: policy.content.hierarchy,
    compositions: { team: { members: [ids.lead, ids.a, ids.b].map(agentId => ({ agentId })) }, council: { members: [{ agentId: ids.owner }] } },
    responsibilities: { integrationLeadAgentId: ids.lead, finalReviewerAgentId: ids.owner }, readiness: { blockers: [] },
    journal: [], commandReceipts: [], effectIntents: [], projectMandate: { projectId: ids.project, revisionId: policy.revisionId,
      version: policy.version, authorizedBy: ids.owner, operatingProfileHash: policy.content.operatingProfileHash,
      mandateHash: hash(mandate), allowedPaths: policy.content.allowedPaths, publication: null, linearIntake: pinned } };
  const row: any = { company_id: ids.company, mission_id: missionId, root_issue_id: ids.root, project_id: ids.project, owner_user_id: ids.owner,
    team_roster_id: ids.teamRoster, team_revision: "team-v1", council_roster_id: ids.councilRoster, council_revision: "council-v1", version: 1,
    aggregate, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  let challenge: any;
  let campaignRootState: any = null;
  function freshAttestation() {
    const now = Date.now();
    const request = { ...subject, schema: "linear-intake-revalidation-request.v1", challengeId: randomUUID(), nonce: "a".repeat(64), stage: "admission",
      admissionId: missionId, mandateId: policy.revisionId, mandateRevisionSha256: hash(policy.content),
      requestedAt: new Date(now - 2000).toISOString(), expiresAt: new Date(now + 298000).toISOString() };
    const response = { schema: "linear-intake-revalidation-result.v1", request, requestSha256: hash(request), status: "confirmed", reason: "handoff_confirmed",
      observedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60000).toISOString() };
    challenge = { company_id: ids.company, mission_id: missionId, stage: "admission", challenge_id: request.challengeId,
      subject_hash: hash({ subject, mandateId: policy.revisionId, mandateRevisionSha256: hash(policy.content) }), request_hash: hash(request), request,
      response_hash: hash(response), response, consumed_at: new Date(now).toISOString() };
    state.linearIntake.admissionReceipt = { challengeId: request.challengeId, stage: "admission", observedAt: response.observedAt,
      validUntil: response.validUntil, requestSha256: hash(request) };
  }
  freshAttestation();
  const query = vi.fn(async (sql: string, params: any[]) => {
    if (sql.includes("project_task_intakes")) {
      if (campaignRootState && params[1] === campaign.root?.missionId) return [{ state: structuredClone(campaignRootState) }];
      expect(params).toEqual([ids.company, missionId, ids.root, ids.project, policy.revisionId]); return [{ state: structuredClone(state) }];
    }
    if (sql.includes("linear_intake_challenges")) {
      expect(params).toEqual([ids.company, missionId, state.linearIntake.admissionReceipt.challengeId]); return [structuredClone(challenge)];
    }
    if (sql.includes("project_mandates")) return [{ company_id: policy.companyId, project_id: policy.projectId, version: policy.version,
      revision_id: policy.revisionId, authorized_by: policy.authorizedBy, content: structuredClone(policy.content) }];
    return [structuredClone(row)];
  });
  const execute = vi.fn(async (_sql: string, params: any[]) => {
    if (params[3] !== row.version) return { rowCount: 0 };
    row.aggregate = JSON.parse(params[0]); row.version++; return { rowCount: 1 };
  });
  Object.assign(f.issues.get(ids.root!)!, { status: "backlog", assigneeAgentId: ids.lead });
  const projectGet = vi.fn(async () => ({ companyId: ids.company, archivedAt: null }));
  const ctx = { ...f.ctx, db: { namespace: "plugin_private_council_test", query, execute }, config: { get: async () => config },
    companies: { get: async () => ({ id: ids.company, defaultResponsibleUserId: ids.owner }) }, projects: { get: projectGet },
    agents: { get: async (id: string) => ({ id, companyId: ids.company, status: "idle" }) } } as unknown as PluginContext;
  return { ...f, ctx, body, row, state, query, execute, projectGet, freshAttestation, challenge: () => challenge,
    setCampaignRootState: (value: any) => { campaignRootState = value; },
    run: (payload = body) => executeN1BoardCommand(ctx, { companyId: ids.company!, missionId, actorUserId: ids.owner!, body: payload }) };
}
type AttestationMutation = (value: ReturnType<typeof fixture>) => void;
const mismatchedAttestations: Array<[string, AttestationMutation]> = [
  ["unconsumed", value => { value.challenge().consumed_at = null; }],
  ["preparation", value => { value.challenge().request.stage = "preparation"; }],
  ["company", value => { value.challenge().company_id = randomUUID(); }],
  ["mission", value => { value.challenge().request.admissionId = randomUUID(); }],
  ["mandate", value => { value.challenge().request.mandateId = randomUUID(); }],
  ["subject", value => { value.challenge().subject_hash = "f".repeat(64); }],
  ["request-hash", value => { value.challenge().request_hash = "f".repeat(64); }],
  ["result-hash", value => { value.challenge().response_hash = "f".repeat(64); }],
  ["blocked", value => { value.challenge().response.status = "blocked"; }],
  ["receipt-time", value => { value.state.linearIntake.admissionReceipt.validUntil = new Date(Date.now() + 90_000).toISOString(); }],
];
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-08T00:00:00.000Z"));
  vi.mocked(readAdmission).mockResolvedValue({ version: 4, measurement: { status: "known", source: "fixture:local-sandbox" },
    allowance: { status: "known", source: "fixture:local-sandbox" }, exposure: { status: "known", source: "fixture:local-sandbox" } } as never);
  vi.mocked(reserveAdmission).mockResolvedValue({ reservation: { status: "reserved" } } as never);
});
afterEach(() => vi.useRealTimers());

it("denies direct Board activation without a consumed original admission observation", async () => {
  const f = fixture(); delete f.state.linearIntake.admissionReceipt;
  await expect(f.run()).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(reserveAdmission).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it.each(mismatchedAttestations)("refuses a mismatched %s attestation before reserving", async (_name, mutate) => {
  const f = fixture();
  mutate(f);
  await expect(f.run()).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(reserveAdmission).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it.each(["commandId", "reservationId", "requestedUnits"])("refuses replacement of the journaled activation %s", async field => {
  const f = fixture(), changed = { ...f.body, [field]: field === "requestedUnits" ? 4 : randomUUID() };
  await expect(f.run(changed)).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(reserveAdmission).not.toHaveBeenCalled();
});
it.each(["mandate read", "root read", "admission read"])("rechecks expiry after the asynchronous %s immediately before reserve", async point => {
  const f = fixture(), expire = () => vi.setSystemTime(new Date(f.state.linearIntake.admissionReceipt.validUntil));
  if (point === "root read") {
    const get = f.get.getMockImplementation()!; f.get.mockImplementationOnce(async (...args) => { expire(); return get(...args); });
  } else if (point === "admission read") {
    const value = await readAdmission(f.ctx, { companyId: f.ids.company!, periodKey: "original-period" });
    vi.mocked(readAdmission).mockImplementationOnce(async () => { expire(); return value; });
  } else {
    const query = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) => { const result = await query(sql, params); if (sql.includes("project_mandates")) expire(); return result; });
  }
  await expect(f.run()).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(reserveAdmission).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
});
it("retains the exact reservation if source expires during reserve and resumes only the original activation payload", async () => {
  const f = fixture(), body = structuredClone(f.body);
  vi.mocked(reserveAdmission).mockImplementationOnce(async () => {
    vi.setSystemTime(new Date(f.state.linearIntake.admissionReceipt.validUntil)); return { reservation: { status: "reserved" } } as never;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(reserveAdmission).toHaveBeenCalledTimes(1); expect(settleAdmission).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  expect(f.row.aggregate.phase).toBe("draft");
  f.freshAttestation();
  await expect(f.run({ ...body, reservationId: randomUUID() })).rejects.toMatchObject({ code: "linear_source_pending" });
  await expect(f.run(body)).resolves.toMatchObject({ outcome: "applied" });
  expect(vi.mocked(reserveAdmission).mock.calls.map(call => call[1].reservationId)).toEqual([body.reservationId, body.reservationId]);
  expect(vi.mocked(reserveAdmission).mock.calls.map(call => call[1].effectId)).toEqual([body.commandId, body.commandId]);
  const writes = f.execute.mock.calls.length;
  vi.setSystemTime(new Date(Date.now() + 300_000));
  await expect(f.run(body)).resolves.toMatchObject({ outcome: "replayed" });
  expect(f.execute).toHaveBeenCalledTimes(writes); expect(reserveAdmission).toHaveBeenCalledTimes(2);
});
it("rechecks current authority if it changes during reservation", async () => {
  const f = fixture();
  vi.mocked(reserveAdmission).mockImplementationOnce(async () => {
    f.policy.content.enabled = false; return { reservation: { status: "reserved" } } as never;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "linear_source_pending" });
  expect(f.execute).not.toHaveBeenCalled(); expect(settleAdmission).not.toHaveBeenCalled();
});
it("activates a trusted campaign leaf through the real N1 admission guard without a second source challenge", async () => {
  const f = fixture(), campaignRootMissionId = randomUUID(), campaignRootIssueId = randomUUID(), sourceId = randomUUID();
  f.row.aggregate.repositoryCampaign = { campaignRootMissionId };
  f.row.aggregate.projectMandate.completion = { result: "integrated-verified" };
  f.row.aggregate.hierarchy = { ...f.policy.content.hierarchy, leaves: [{ issueId: f.ids.root, assigneeAgentId: f.ids.a }] };
  Object.assign(f.issues.get(f.ids.root!)!, { assigneeAgentId: f.ids.a });
  delete f.state.linearIntake;
  f.state.repositoryCampaign = { campaignRootMissionId, campaignRootIssueId, sourceId };
  campaign.root = { companyId: f.ids.company, missionId: campaignRootMissionId, rootIssueId: campaignRootIssueId,
    projectId: f.ids.project, ownerUserId: f.ids.owner, aggregate: { projectMandate: { linearIntake: f.row.aggregate.projectMandate.linearIntake },
      linearContinuity: { mode: "milestone-fixed-v1", publications: [{ payload: { campaignPlan: {} }, acknowledgement: { reference: {} } }] } } };
  f.setCampaignRootState({ linearIntake: { snapshot: { ...f.row.aggregate.projectMandate.linearIntake,
    nodes: [{ nativeId: f.ids.root, sourceId, role: "contribution" }] } } });
  await expect(f.run()).resolves.toMatchObject({ outcome: "applied" });
  expect(campaign.continuity).toHaveBeenCalledWith(f.ctx, campaign.root);
  expect(campaign.predecessor).toHaveBeenCalledWith(f.ctx, expect.objectContaining({ missionId: f.row.mission_id }));
  expect(reserveAdmission).toHaveBeenCalledTimes(1);
});
