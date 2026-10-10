import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "../src/missions.js";
import { reconcileControllerGithubFeedback } from "../src/github-feedback-controller.js";
import { assertConfiguredGithubFeedbackRefresh, parseGithubFeedbackRefreshShape } from "../src/github-feedback-authority.js";
import { inspectN5 } from "../src/n5-state.js";
import { registerContinuityJob } from "../src/continuity-runtime.js";
import { assertLinearContinuityDeparture } from "../src/linear-continuity-control.js";
import { linearAuthorityHash } from "../src/linear-continuity-contract.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";

const f = vi.hoisted(() => ({ cas: vi.fn(), departure: vi.fn(), mission: null as unknown as MissionRecord }));
vi.mock("../src/n2-missions.js", () => ({ n2Cas: async (_ctx: unknown, m: MissionRecord, aggregate: MissionRecord["aggregate"]) => {
    f.cas(aggregate); f.mission = { ...m, version: m.version + 1, aggregate }; return structuredClone(f.mission);
  } }));
vi.mock("../src/project-mandate-guard.js", () => ({ assertProjectDeparture: (...args: unknown[]) => f.departure(...args) }));
vi.mock("../src/project-task-intake.js", () => ({ reconcileProjectTasks: async () => {} }));
vi.mock("../src/n2-ordinary-runtime.js", () => ({ reconcileOrdinaryN2: async (_ctx: unknown, m: MissionRecord) => m }));
vi.mock("../src/n5-runtime.js", () => ({ reconcileN5: async (_ctx: unknown, m: MissionRecord) => m }));
vi.mock("../src/native-runs.js", () => ({ assertNativeRunInventory: async () => {} }));
vi.mock("../src/missions.js", async () => ({ ...await import("../src/mission-primitives.js"), getMission: async () => structuredClone(f.mission) }));

const secretRef = { type: "secret_ref" as const, secretId: "00000000-0000-4000-8000-000000000001", version: "latest" as const };
const job = { jobKey: "mission-continuity", runId: "job-native-1", trigger: "schedule", scheduledAt: new Date().toISOString() } as PluginJobContext;

function fixture() {
  const now = new Date().toISOString(), head = "a".repeat(40), submissionId = "submission";
  const report = { protocol: "publisher-github-feedback-v1" as const, provenance: "publisher_run_report" as const,
    missionId: "mission", intentId: "intent", issueId: "publication-task", runId: "publisher-run", observedAt: now,
    url: "https://github.com/owner/repo/pull/85", repository: "owner/repo", headSha: head, baseRef: "main", headRef: "codex/fix-85", draft: true,
    checks: [{ name: "ci", state: "pending" as const, evidenceUrl: "https://github.com/owner/repo/actions/runs/1" }], reviews: [] };
  return { companyId: "company", projectId: "project", missionId: "mission", ownerUserId: "owner", rootIssueId: "root", version: 7,
    aggregate: { mandate: {}, control: { status: "active" }, phase: "accepted", journal: [], effectIntents: [],
      continuity: { protocol: "council-continuity-v1", enabled: true, authorizedBy: "owner", mandateHash: canonicalPayloadHash({}),
        authorizedAt: now, deadline: new Date(Date.now() + 60_000).toISOString(), n3Slots: [], commands: {} },
      projectMandate: { publication: { contract: { feedbackRefresh: { protocol: "controller-github-feedback-v1", secretRef } } } },
      n2: { status: "accepted", activeSubmissionId: submissionId, ordinary: { protocol: "ordinary-cli-v1", tasks: [] } }, n5: { plan: {}, authority: {
        repository: "owner/repo", baseRef: "main", headRef: "codex/fix-85", contract: { protocol: "council-pr-contract-v1", draftOnly: true,
          result: "draft-pr", feedback: "review-and-correct", requiredChecks: ["ci"], feedbackRefresh: { protocol: "controller-github-feedback-v1", secretRef } } },
        publication: { operation: "create", intentId: "intent", issueId: "publication-task", runId: "publisher-run", settledAt: now,
          submission: { submissionId, candidateCommit: head, mandateHash: createHash("sha256").update(JSON.stringify({})).digest("hex"), sha256: "", evidenceRevision: 1 }, feedbackReport: report,
          checks: { headSha: head, state: "pending", evidenceRefs: [], observedAt: now, agentId: "publisher", runId: "publisher-run" },
          reviews: { headSha: head, state: "pending", evidenceRefs: [], observedAt: now, agentId: "publisher", runId: "publisher-run" },
          observation: { url: report.url, headSha: head, baseRef: "main", headRef: "codex/fix-85", draft: true, state: "open",
            matchesCandidate: true, lastResolvedAt: now } } } } } as unknown as MissionRecord;
}

function github(prAfter?: Record<string, unknown>, options: { total?: number; status?: number; reviews?: unknown[]; draft?: boolean; checkName?: string; checkConclusion?: string; duplicateConclusions?: string[] } = {}) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const pr = { html_url: "https://github.com/owner/repo/pull/85", state: "open", draft: options.draft ?? true,
    head: { sha: "a".repeat(40), ref: "codex/fix-85" }, base: { ref: "main" } };
  let pullReads = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (options.status) return new Response("refused", { status: options.status });
    let body: unknown;
    if (url.endsWith("/pulls/85")) body = ++pullReads === 2 && prAfter ? prAfter : pr;
    else if (url.includes("check-runs")) {
      const check = { id: 3, name: options.checkName ?? "ci", head_sha: "a".repeat(40), status: "completed", conclusion: options.checkConclusion ?? "success", html_url: "https://github.com/owner/repo/actions/runs/2" };
      const checkRuns = [check, ...(options.duplicateConclusions ?? []).map((conclusion, index) => ({ ...check, id: index + 4, conclusion,
        status: conclusion === "pending" ? "in_progress" : "completed" }))];
      body = { total_count: options.total ?? checkRuns.length, check_runs: checkRuns };
    }
    else if (url.includes("/status?")) body = { sha: "a".repeat(40), statuses: [] };
    else body = options.reviews ?? [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const resolve = vi.fn(async () => "TEST_CONTROLLER_TOKEN_DO_NOT_PERSIST");
  const ctx = { config: { get: async () => ({ githubFeedbackToken: secretRef }) }, secrets: { resolve }, http: { fetch } } as unknown as PluginContext;
  return { ctx, fetch, resolve, requests, pr };
}

beforeEach(() => { vi.clearAllMocks(); f.mission = fixture(); });

describe("controller GitHub feedback refresh", () => {
  it("requires an explicit owner payload matching the configured secret-ref identity", () => {
    const authority = parseGithubFeedbackRefreshShape({ protocol: "controller-github-feedback-v1", secretRef });
    expect(parseGithubFeedbackRefreshShape(undefined)).toBeUndefined();
    expect(authority).toEqual({ protocol: "controller-github-feedback-v1", secretRef });
    expect(() => assertConfiguredGithubFeedbackRefresh(authority, secretRef)).not.toThrow();
    expect(() => assertConfiguredGithubFeedbackRefresh(authority, { ...secretRef, version: 2 })).toThrow();
  });

  it("promotes pending required CI after publisher settlement with separate controller provenance", async () => {
    const m = fixture(), h = github();
    const next = await reconcileControllerGithubFeedback(h.ctx, m, job);
    expect(h.resolve).toHaveBeenCalledWith(secretRef, { companyId: "company", configPath: "githubFeedbackToken" });
    expect(h.fetch).toHaveBeenCalledTimes(5);
    expect(h.requests.every(request => request.url.startsWith("https://api.github.com/repos/owner/repo/"))).toBe(true);
    expect(h.requests.every(request => request.init?.method === "GET")).toBe(true);
    expect(h.requests.every(request => request.init?.signal === undefined)).toBe(true);
    expect(next.aggregate.n5!.publication!.feedbackReport).toEqual(m.aggregate.n5!.publication!.feedbackReport);
    expect(next.aggregate.n5!.publication!.controllerFeedbackReport).toMatchObject({ protocol: "controller-github-feedback-v1",
      provenance: "council_continuity_http", jobRunId: job.runId, headSha: "a".repeat(40), checks: [{ name: "ci", state: "passed" }] });
    expect(inspectN5(next)).toMatchObject({ publicationReady: true, mergeReady: false, checksSource: "council_continuity_http" });
    expect(JSON.stringify(next)).not.toContain("TEST_CONTROLLER_TOKEN_DO_NOT_PERSIST");
  });

  it("observes pending-to-passed CI through the registered native continuity worker", async () => {
    const h = github(), documents = new Map<string, { body: string; latestRevisionId: string }>();
    let callback: (job: PluginJobContext) => Promise<void>, stored: unknown;
    const ctx = { ...h.ctx, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) },
      state: { get: async () => stored, set: async (_scope: unknown, value: unknown) => { stored = value; } },
      issues: { documents: { get: async (_issue: string, key: string) => documents.get(key) ?? null,
        upsert: async (input: { key: string; body: string }) => { const doc = { body: input.body, latestRevisionId: "status-v1" }; documents.set(input.key, doc); return doc; } } },
      jobs: { register: (_key: string, handler: typeof callback) => { callback = handler; } } } as unknown as PluginContext;
    registerContinuityJob(ctx, async () => [structuredClone(f.mission)]);
    await callback!(job);
    expect(f.mission.aggregate.n5!.publication!.feedbackReport?.checks[0]?.state).toBe("pending");
    expect(f.mission.aggregate.n5!.publication!.controllerFeedbackReport?.checks[0]?.state).toBe("passed");
    expect(inspectN5(f.mission)).toMatchObject({ publicationReady: true, mergeReady: false });
    expect([...documents.values()][0]?.body).toContain("authorized_pr_observed");
  });

  it.each([
    ["changed head", () => github({ html_url: "https://github.com/owner/repo/pull/85", state: "open", draft: true, head: { sha: "b".repeat(40), ref: "codex/fix-85" }, base: { ref: "main" } })],
    ["truncated inventory", () => github(undefined, { total: 101 })],
    ["transport refusal", () => github(undefined, { status: 403 })],
  ])("keeps publisher evidence pending on %s without persisting provider errors", async (_name, build) => {
    const m = fixture(), h = build();
    const next = await reconcileControllerGithubFeedback(h.ctx, m, job);
    expect(next).toBe(m); expect(f.cas).not.toHaveBeenCalled();
    expect(JSON.stringify(next)).not.toContain("TEST_CONTROLLER_TOKEN_DO_NOT_PERSIST");
  });

  it("keeps an absent explicitly required check pending", async () => {
    const m = fixture(), h = github(undefined, { checkName: "unrelated" });
    const next = await reconcileControllerGithubFeedback(h.ctx, m, job);
    expect(next.aggregate.n5!.publication!.checks?.state).toBe("pending");
    expect(inspectN5(next)?.publicationReady).toBe(false);
  });

  it.each([
    ["success", "passed"],
    ["failure", "failed"],
    ["pending", "pending"],
  ] as const)("aggregates a duplicate same-name %s check without selecting a latest run", async (duplicate, expected) => {
    const next = await reconcileControllerGithubFeedback(github(undefined, { duplicateConclusions: [duplicate] }).ctx, fixture(), job);
    expect(next.aggregate.n5!.publication!.controllerFeedbackReport!.checks).toEqual([{ name: "ci", state: expected,
      evidenceUrl: `https://github.com/owner/repo/commit/${"a".repeat(40)}/checks` }]);
    expect(next.aggregate.n5!.publication!.checks?.state).toBe(expected);
  });

  it("renews an unchanged stale controller observation before readiness can resume", async () => {
    const first = await reconcileControllerGithubFeedback(github().ctx, fixture(), job);
    const prior = first.aggregate.n5!.publication!.controllerFeedbackReport!;
    prior.observedAt = new Date(Date.now() - 400_000).toISOString();
    expect(inspectN5(first)?.publicationReady).toBe(false);
    f.cas.mockClear();
    const next = await reconcileControllerGithubFeedback(github().ctx, first, { ...job, runId: "job-native-2" });
    expect(f.cas).toHaveBeenCalledOnce();
    expect(next.aggregate.n5!.publication!.controllerFeedbackReport).toMatchObject({ jobRunId: "job-native-2", checks: prior.checks });
    expect(inspectN5(next)?.publicationReady).toBe(true);
  });

  it.each(["failed check", "changes requested"])("replaces stale green evidence after a new %s", async kind => {
    const m = fixture(), p = m.aggregate.n5!.publication!;
    p.feedbackReport!.checks[0]!.state = "passed"; p.checks!.state = "passed";
    p.feedbackReport!.observedAt = new Date(Date.now() - 400_000).toISOString();
    let options: Parameters<typeof github>[1] = { checkConclusion: "failure" };
    if (kind === "changes requested") {
      m.aggregate.n5!.authority.contract = { ...m.aggregate.n5!.authority.contract!, result: "reviewed-pr", draftOnly: false };
      p.observation!.draft = false; p.feedbackReport!.draft = false;
      p.feedbackReport!.reviews = [{ id: 1, author: "reviewer", headSha: "a".repeat(40), state: "APPROVED", body: "", url: `${p.observation!.url}#pullrequestreview-1`, submittedAt: new Date(Date.now() - 400_000).toISOString() }];
      p.reviews!.state = "approved";
      options = { draft: false, reviews: [{ id: 2, state: "CHANGES_REQUESTED", user: { login: "reviewer" }, commit_id: "a".repeat(40), body: "",
        html_url: `${p.observation!.url}#pullrequestreview-2`, submitted_at: new Date().toISOString() }] };
    }
    expect(inspectN5(m)?.publicationReady).toBe(false);
    const next = await reconcileControllerGithubFeedback(github(undefined, options).ctx, m, job);
    expect(next.aggregate.n5!.publication!.controllerFeedbackReport).toBeDefined();
    expect(inspectN5(next)?.publicationReady).toBe(false);
    expect(kind === "failed check" ? next.aggregate.n5!.publication!.checks?.state : next.aggregate.n5!.publication!.reviews?.state)
      .toBe(kind === "failed check" ? "failed" : "changes_requested");
  });

  it("still requires exact approval for a reviewed PR", async () => {
    const m = fixture(), p = m.aggregate.n5!.publication!;
    m.aggregate.n5!.authority.contract = { ...m.aggregate.n5!.authority.contract!, result: "reviewed-pr", draftOnly: false };
    p.observation!.draft = false; p.feedbackReport!.draft = false;
    const review = { id: 9, state: "APPROVED", user: { login: "reviewer" }, commit_id: "a".repeat(40), body: "",
      html_url: `${p.observation!.url}#pullrequestreview-9`, submitted_at: new Date().toISOString() };
    const next = await reconcileControllerGithubFeedback(github(undefined, { draft: false, reviews: [review] }).ctx, m, job);
    expect(inspectN5(next)).toMatchObject({ publicationReady: true, mergeReady: true });
  });

  it("does not read a foreign PR scope, cancelled publication or paused continuity", async () => {
    const cases = [fixture(), fixture(), fixture()];
    cases[0]!.aggregate.n5!.publication!.observation!.url = "https://github.com/other/repo/pull/85";
    cases[1]!.aggregate.n5!.publication!.operation = "cancel-pr";
    cases[2]!.aggregate.linearContinuity = { control: "paused" } as never;
    for (const m of cases) {
      const h = github(); expect(await reconcileControllerGithubFeedback(h.ctx, m, job)).toBe(m);
      expect(h.resolve).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it("requires pinned project authority to match the configured native secret reference", async () => {
    const m = fixture(), h = github();
    (h.ctx.config.get as unknown as () => Promise<unknown>) = async () => ({ githubFeedbackToken: { ...secretRef, secretId: "changed" } });
    await expect(reconcileControllerGithubFeedback(h.ctx, m, job)).rejects.toMatchObject({ code: "github_feedback_authority_changed" });
    expect(h.resolve).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
});


it("reads delayed GitHub checks with local gates while reserving fresh source for the next actual departure", async () => {
  const m = f.mission, source = "a".repeat(64), now = Date.now();
  const subject = { sourceSha256: source };
  m.aggregate.projectMandate!.linearIntake = { subject } as any;
  const binding = { companyId: m.companyId, projectId: m.projectId, missionId: m.missionId,
    nativeRootId: m.rootIssueId, subject, authoritySha256: linearAuthorityHash(m) };
  const response = { sourceObservationProtocol: "council-linear-source-observation-v1", sourceInvalidationVersion: 0,
    observationPurpose: "action", sourceSha256: source, availability: "available",
    observedAt: new Date(now - 1_800_000).toISOString(), validUntil: new Date(now - 1_680_000).toISOString() };
  const doc = { id: "observation-doc", latestRevisionId: "observation-revision", body: JSON.stringify(response) };
  const docs = new Map<string, any>([["observation", doc]]), emit = vi.fn();
  m.aggregate.linearContinuity = { mode: "milestone-fixed-v1", protocol: "council-linear-continuity-v1",
    terminalPublicationProtocol: "council-terminal-publication-claim-v1", binding, sourceSha256: source,
    control: "running", sequence: 0, publications: [], consumed: [], safeSettlementIds: {},
    observation: { response, bodySha256: canonicalPayloadHash(doc.body), reference: { key: "observation",
      documentId: doc.id, revisionId: doc.latestRevisionId, bodySha256: canonicalPayloadHash(doc.body) } } } as any;
  f.departure.mockImplementation((ctx, mission, cancellation, intent, requestSource = true) =>
    assertLinearContinuityDeparture(ctx, mission, cancellation, intent, requestSource));
  const native = { issues: { documents: { get: async (_id: string, key: string) => docs.get(key) ?? null,
    upsert: async (input: any) => { const saved = { id: input.key, latestRevisionId: input.key, ...input }; docs.set(input.key, saved); return saved; } } }, events: { emit } };
  const waiting = github(undefined, { duplicateConclusions: ["pending"] });
  await reconcileControllerGithubFeedback({ ...waiting.ctx, ...native } as any, m, job);
  expect(f.mission.aggregate.n5!.publication!.controllerFeedbackReport!.checks[0]!.state).toBe("pending");
  const passed = github(), ctx = { ...passed.ctx, ...native } as any;
  const next = await reconcileControllerGithubFeedback(ctx, f.mission, job);
  expect(inspectN5(next)).toMatchObject({ publicationReady: true });
  expect(emit).not.toHaveBeenCalled();
  await expect(assertLinearContinuityDeparture(ctx, next)).rejects.toMatchObject({ code: "linear_continuity_source_pending" });
  expect(emit).toHaveBeenCalledOnce();
  expect(f.mission.aggregate.linearContinuity!.challenge!.payload.observationPurpose).toBe("action");
});
