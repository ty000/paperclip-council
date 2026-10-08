import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/admission.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/admission.js")>(), readAdmission: vi.fn(), recordUnadmittedRun: vi.fn(),
}));
vi.mock("../src/decision-adapter.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/decision-adapter.js")>(), councilNativeRequest: vi.fn(),
}));

import { readAdmission, recordUnadmittedRun } from "../src/admission.js";
import { councilNativeRequest } from "../src/decision-adapter.js";
import { closeQualifiedContribution } from "../src/contribution-proof.js";
import { executeN1BoardCommand, type N1State } from "../src/n1-missions.js";
import { getMission, handleMissionApi, type MissionAggregate } from "../src/missions.js";

const id: Record<string, string> = Object.fromEntries(["company", "project", "mission", "root", "owner", "lead", "leadRun", "leadReservation",
  "alpha", "beta", "alphaRun", "betaRun", "alphaChild", "betaChild", "alphaContribution", "betaContribution",
  "alphaReservation", "betaReservation", "attachment", "workProduct"].map(key => [key, randomUUID()]));
let directory: string, sourceBase: string, alphaCommit: string, betaCommit: string, bytes: Buffer, digest: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "council-recovery-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--quiet"); git("config", "user.name", "Recovery Test"); git("config", "user.email", "recovery@example.test");
  git("commit", "--quiet", "--allow-empty", "-m", "base"); sourceBase = git("rev-parse", "HEAD");
  await writeFile(join(directory, "alpha.txt"), "first contribution\n"); git("add", "."); git("commit", "--quiet", "-m", "alpha"); alphaCommit = git("rev-parse", "HEAD");
  await writeFile(join(directory, "beta.txt"), "second contribution\n"); git("add", "."); git("commit", "--quiet", "-m", "beta"); betaCommit = git("rev-parse", "HEAD");
  const refs = ["base", "candidate"].map(ref => `refs/council/proof/${id.betaContribution}/${ref}`);
  git("update-ref", refs[0], alphaCommit); git("update-ref", refs[1], betaCommit);
  git("bundle", "create", join(directory, "beta.bundle"), ...refs);
  bytes = await readFile(join(directory, "beta.bundle")); digest = createHash("sha256").update(bytes).digest("hex");
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const state = { periodKey: "test-period", activatedAt: new Date().toISOString(), activationReservationId: id.leadReservation,
    rootDispatchMode: "native", rootDispatchState: "requested", rootDispatchRunId: id.leadRun, sourceBaseCommit: sourceBase,
    contributions: ["alpha", "beta"].map(key => ({ contributionId: id[key + "Contribution"], assigneeAgentId: id[key],
      title: key, ownedPaths: [key + ".txt"], issueState: "confirmed", childIssueId: id[key + "Child"],
      dispatchState: "requested", dispatchRunId: id[key + "Run"], dispatchReservationId: id[key + "Reservation"],
      ...(key === "alpha" ? { commit: alphaCommit, authorRunId: id.alphaRun, proof: { commit: alphaCommit, closedAt: new Date().toISOString() } } : {}) })),
  } as N1State;
  const aggregate = { schemaVersion: 1, missionId: id.mission, companyId: id.company, rootIssueId: id.root, projectId: id.project,
    ownerUserId: id.owner, phase: "executing", control: { status: "active" }, n1: state,
    nativeWakePolicy: { protocol: "council-native-wake-v2", rootBaseline: [] },
    projectMandate: { completion: { protocol: "council-proof-close-v1", result: "draft-pr" } },
    responsibilities: { integrationLeadAgentId: id.lead }, readiness: { blockers: [] },
    journal: [{ action: "historical" }], commandReceipts: [], effectIntents: [{ kind: "child_wakeup", state: "requested" }],
  } as unknown as MissionAggregate;
  const row = { company_id: id.company, project_id: id.project, mission_id: id.mission, root_issue_id: id.root,
    owner_user_id: id.owner, version: 9, aggregate, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString() };
  const issues = new Map(["alpha", "beta"].map(key => [id[key + "Child"], { id: id[key + "Child"], companyId: id.company,
    projectId: id.project, parentId: id.root, assigneeAgentId: id[key], status: "done", checkoutRunId: null as string | null,
    executionRunId: null as string | null }]));
  const runs = ["lead", "alpha", "beta"].map(key => ({ id: id[key + "Run"], companyId: id.company, agentId: id[key],
    issueId: key === "lead" ? id.root : id[key + "Child"], status: "succeeded", startedAt: new Date(0).toISOString(), finishedAt: new Date().toISOString(),
    contextSnapshot: { issueId: key === "lead" ? id.root : id[key + "Child"] }, nativeIssueId: null,
  }));
  const products = [{ id: id.workProduct, type: "commit", provider: "git", companyId: id.company, projectId: id.project,
    issueId: id.betaChild, externalId: betaCommit, createdByRunId: id.betaRun }];
  vi.mocked(councilNativeRequest).mockImplementation(async (_ctx, _company, path) => ({ status: 200,
    body: path.endsWith("/work-products") ? products : runs.find(r => path.endsWith(r.id)) }));
  const reservations = [id.leadReservation, id.alphaReservation, id.betaReservation].map(reservationId => ({ reservationId,
    missionId: id.mission, status: "settled", usage: { status: "known", units: 100 }, remainingExposure: { status: "known", units: 0 } }));
  vi.mocked(readAdmission).mockResolvedValue({ reservations } as never);
  const execute = vi.fn(async (_sql: string, params: unknown[]) => {
    if (row.version !== params[3]) return { rowCount: 0 };
    row.aggregate = JSON.parse(params[0] as string); row.version++; return { rowCount: 1 };
  });
  const update = vi.fn(), wake = vi.fn();
  const ctx = { db: { namespace: "plugin_council_test", query: vi.fn(async () => [structuredClone(row)]), execute },
    companies: { get: async () => ({ id: id.company, defaultResponsibleUserId: id.owner }) },
    config: { get: async () => ({ n1OperatingProfile: { kind: "paperclip-orchestration-tokens-v1", periodKey: "test-period",
      periodStart: "2026-01-01T00:00:00Z", periodEnd: "2027-01-01T00:00:00Z", periodAllowanceUnits: 10000, runReservationUnits: 1000,
      initialKnownUsageUnits: 0, initialExposureUnits: 0, initialTokenAccountingSource: "test" } }) },
    issues: { get: async (issueId: string) => issues.get(issueId), update, requestWakeup: wake,
      summaries: { getOrchestration: async ({ issueId }: { issueId: string }) => ({ companyId: id.company, issueId, runs: runs.filter(r => r.issueId === issueId) }) },
      listAttachments: async () => [{ id: id.attachment }],
      getAttachmentContent: async () => ({ attachmentId: id.attachment, contentBase64: bytes.toString("base64"), sha256: digest, byteSize: bytes.length }),
    },
  } as unknown as PluginContext;
  const body = { command: "recover-contribution", commandId: randomUUID(), expectedVersion: 9, contributionId: id.betaContribution,
    commit: betaCommit, workProductId: id.workProduct, reason: "Recover the committed native result without repeating implementation",
    proof: { attachmentId: id.attachment, expectedSha256: digest, segmentRootCommit: alphaCommit } };
  const apply = (actorUserId = id.owner) => executeN1BoardCommand(ctx, { companyId: id.company, missionId: id.mission, actorUserId, body });
  return { ctx, row, state, issues, runs, products, reservations, execute, update, wake, body, apply };
}

it("recovers the second contribution with real Git proof and native author, preserving history and permitting later closure without a wake", async () => {
  const f = fixture(), before = structuredClone(f.row.aggregate);
  const response = await handleMissionApi({ companyId: id.company, routeKey: "mission-command", method: "POST", path: "/missions/test/commands", query: {}, headers: {}, params: { companyId: id.company, missionId: id.mission },
    actor: { actorType: "user", actorId: id.owner, userId: id.owner }, body: f.body } as PluginApiRequestInput, f.ctx);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const n1 = f.row.aggregate.n1 as N1State;
  expect(n1.contributions[0]).toEqual((before.n1 as N1State).contributions[0]);
  expect(n1.contributions[1]).toMatchObject({ commit: betaCommit, authorRunId: id.betaRun, dispatchRunId: id.betaRun,
    dispatchReservationId: id.betaReservation, contributionRecovery: { actorUserId: id.owner, commandId: f.body.commandId, workProductId: id.workProduct },
    proof: { commit: betaCommit, segmentRootCommit: alphaCommit, changedPaths: ["beta.txt"] } });
  expect(n1.integration).toBeUndefined(); expect(n1.candidate).toBeUndefined(); expect(n1.contributions[1].proof!.closedAt).toBeUndefined();
  expect(f.row.aggregate.phase).toBe("executing"); expect(f.row.aggregate.effectIntents).toEqual(before.effectIntents);
  expect(f.row.aggregate.journal.at(-1)).toMatchObject({ action: "owner_recovered_contribution", assistance: "owner-native-work-product", originalAuthorRunId: id.betaRun });
  expect(f.row.aggregate.commandReceipts[0]).toMatchObject({ command: "recover-contribution", actorType: "user", actorId: id.owner });
  const mission = (await getMission(f.ctx, id.company, id.mission))!;
  const closed = await closeQualifiedContribution(f.ctx, mission, id.betaContribution, async (m, aggregate) => ({ ...m, aggregate, version: m.version + 1 }));
  expect((closed.aggregate.n1 as N1State).contributions[1].proof!.closedAt).toBeTruthy();
  expect(f.wake).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled(); expect(recordUnadmittedRun).not.toHaveBeenCalled();
  expect(await f.apply()).toMatchObject({ outcome: "replayed" }); expect(f.execute).toHaveBeenCalledTimes(1);
  f.body.reason = "A different payload"; await expect(f.apply()).rejects.toMatchObject({ code: "command_identity_conflict" });
});

it.each(["id", "companyId", "projectId", "issueId", "createdByRunId", "externalId", "type", "provider"])("rejects a native product with mismatched %s", async field => {
  const f = fixture(); (f.products[0] as Record<string, string>)[field] = randomUUID();
  await expect(f.apply()).rejects.toMatchObject({ code: "contribution_recovery_provenance" }); expect(f.execute).not.toHaveBeenCalled();
});
it.each(["running", "failed", "cancelled"])("rejects the admitted run when %s", async status => {
  const f = fixture(); f.runs[2].status = status;
  await expect(f.apply()).rejects.toMatchObject({ code: "contribution_recovery_run" }); expect(f.execute).not.toHaveBeenCalled();
});
it.each(["checkoutRunId", "executionRunId"])("rejects an existing native %s lock", async field => {
  const f = fixture(); f.issues.get(id.betaChild)![field as "checkoutRunId" | "executionRunId"] = id.betaRun;
  await expect(f.apply()).rejects.toMatchObject({ code: "contribution_recovery_issue" }); expect(f.execute).not.toHaveBeenCalled();
});
it.each(["unknown", "exposed", "reserved", "missing"])("rejects %s settlement without new spending", async kind => {
  const f = fixture();
  if (kind === "unknown") f.reservations[2].usage.status = "unknown";
  if (kind === "exposed") f.reservations[0].remainingExposure.units = 1;
  if (kind === "reserved") f.reservations[1].status = "reserved";
  if (kind === "missing") f.reservations.pop();
  await expect(f.apply()).rejects.toMatchObject({ code: "contribution_recovery_usage" }); expect(f.execute).not.toHaveBeenCalled();
});
it("rejects an unadmitted native run and retains its accounting exception", async () => {
  const f = fixture(); f.runs.push({ ...f.runs[2], id: randomUUID() });
  await expect(f.apply()).rejects.toMatchObject({ code: "unadmitted_native_run" });
  expect(recordUnadmittedRun).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
});
it.each(["digest", "predecessor", "ownership"])("verifies the actual bundle %s instead of trusting the work product", async kind => {
  const f = fixture();
  if (kind === "digest") f.body.proof.expectedSha256 = "f".repeat(64);
  if (kind === "predecessor") f.body.proof.segmentRootCommit = sourceBase;
  if (kind === "ownership") f.state.contributions[1].ownedPaths = ["alpha.txt"];
  await expect(f.apply()).rejects.toMatchObject({ code: kind === "predecessor" ? "contribution_proof_required" : "contribution_proof_invalid" });
  expect(f.execute).not.toHaveBeenCalled();
});
it("requires the owner and a fresh version, and preserves the source on a concurrent CAS loss", async () => {
  const f = fixture(); await expect(f.apply(id.beta)).rejects.toMatchObject({ code: "owner_required" });
  f.body.expectedVersion = 8; await expect(f.apply()).rejects.toMatchObject({ code: "version_conflict" });
  f.body.expectedVersion = 9; f.execute.mockResolvedValueOnce({ rowCount: 0 });
  await expect(f.apply()).rejects.toMatchObject({ code: "version_conflict" });
  expect(f.state.contributions[1].commit).toBeUndefined(); expect(f.row.aggregate.commandReceipts).toEqual([]);
});
it.each(["candidate", "integration", "recorded", "predecessor-open"])("refuses recovery after %s", async kind => {
  const f = fixture();
  if (kind === "candidate") f.state.candidate = {} as never;
  if (kind === "integration") f.state.integration = {} as never;
  if (kind === "recorded") f.state.contributions[1].commit = betaCommit;
  if (kind === "predecessor-open") delete f.state.contributions[0].proof!.closedAt;
  await expect(f.apply()).rejects.toMatchObject({ code: ["candidate", "integration"].includes(kind) ? "contribution_recovery_unavailable" : "contribution_recovery_binding" });
  expect(f.execute).not.toHaveBeenCalled();
});
