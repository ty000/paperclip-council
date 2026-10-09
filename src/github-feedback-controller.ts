import type { PluginContext, PluginJobContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, MissionError, type MissionRecord } from "./missions.js";
import { n2Cas } from "./n2-missions.js";
import { githubFeedbackStates, type ControllerGithubFeedback } from "./pr-contract.js";
import { assertProjectDeparture } from "./project-mandate-guard.js";
import { matchesGithubFeedbackSecret } from "./github-feedback-authority.js";

type PrRead = { html_url: string; state: string; draft: boolean; head: { sha: string; ref: string }; base: { ref: string } };
const MAX_RESPONSE_BYTES = 2_000_000;
const api = "https://api.github.com";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1000) {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("shape");
  return value;
}
function safeUrl(value: unknown, fallback?: string) {
  const url = value === null || value === undefined || value === "" ? fallback : string(value);
  if (!url || !/^https:\/\//.test(url)) throw new Error("shape");
  return url;
}
async function json(ctx: PluginContext, url: string, token: string) {
  // The SDK does not serialize RequestInit.signal. The host owns the effective
  // fixed 30-second plugin fetch timeout and its pinned outbound transport.
  const response = await ctx.http.fetch(url, { method: "GET", headers: {
    accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2026-03-10",
  } });
  if (response.status !== 200) throw new Error("transport");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(length) || length > MAX_RESPONSE_BYTES) throw new Error("bound");
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("bound");
  return JSON.parse(body) as unknown;
}
function pr(value: unknown): PrRead {
  const v = object(value), head = object(v.head), base = object(v.base);
  if (typeof v.draft !== "boolean") throw new Error("shape");
  return { html_url: string(v.html_url), state: string(v.state), draft: v.draft,
    head: { sha: string(head.sha), ref: string(head.ref) }, base: { ref: string(base.ref) } };
}
function samePr(a: PrRead, b: PrRead) {
  return canonicalPayloadHash(a) === canonicalPayloadHash(b);
}
function assertPrBinding(observed: PrRead, expected: { url: string; headSha: string; headRef: string; baseRef: string; draft: boolean }) {
  if (observed.html_url !== expected.url || observed.state !== "open" || observed.head.sha !== expected.headSha
      || observed.head.ref !== expected.headRef || observed.base.ref !== expected.baseRef || observed.draft !== expected.draft) throw new Error("continuity");
}

async function readChecks(ctx: PluginContext, prefix: string, headSha: string, fallbackUrl: string, token: string) {
  const checksValue = object(await json(ctx, `${prefix}/commits/${headSha}/check-runs?per_page=100`, token));
  const total = checksValue.total_count, runs = checksValue.check_runs;
  if (!Number.isSafeInteger(total) || Number(total) > 100 || !Array.isArray(runs) || runs.length !== total) throw new Error("inventory");
  const named: CheckMap = new Map();
  const cohortUrl = fallbackUrl.replace(/\/pull\/[1-9][0-9]*$/, `/commit/${headSha}/checks`);
  for (const raw of runs) addCheckRun(named, raw, headSha, cohortUrl);

  const statusesValue = object(await json(ctx, `${prefix}/commits/${headSha}/status?per_page=100`, token));
  if (statusesValue.sha !== headSha || !Array.isArray(statusesValue.statuses) || statusesValue.statuses.length >= 100) throw new Error("inventory");
  addCommitStatuses(named, statusesValue.statuses, fallbackUrl);
  return [...named.values()];
}

type Check = { name: string; state: "pending" | "passed" | "failed"; evidenceUrl: string };
type CheckMap = Map<string, Check>;
const CHECK_SEVERITY: Record<Check["state"], number> = { passed: 0, pending: 1, failed: 2 };
function addCheckRun(named: CheckMap, raw: unknown, headSha: string, cohortUrl: string) {
  const item = object(raw), name = string(item.name, 200), id = item.id;
  if (!Number.isSafeInteger(id) || Number(id) < 1 || item.head_sha !== headSha) throw new Error("inventory");
  const status = string(item.status, 100), conclusion = item.conclusion;
  const state = status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(String(conclusion)) ? "passed" : "failed";
  const previous = named.get(name);
  if (!previous) return void named.set(name, { name, state, evidenceUrl: safeUrl(item.html_url) });
  const worst = CHECK_SEVERITY[previous.state] >= CHECK_SEVERITY[state] ? previous.state : state;
  named.set(name, { name, state: worst, evidenceUrl: cohortUrl });
}
function addCommitStatuses(named: CheckMap, statuses: unknown[], fallbackUrl: string) {
  const seen = new Set<string>();
  for (const raw of statuses) {
    const item = object(raw), name = string(item.context, 200), state = string(item.state, 100);
    if (seen.has(name)) continue;
    seen.add(name);
    if (named.has(name)) throw new Error("ambiguous");
    named.set(name, { name, state: state === "success" ? "passed" : state === "pending" ? "pending" : "failed", evidenceUrl: safeUrl(item.target_url, fallbackUrl) });
  }
}

async function readReviews(ctx: PluginContext, pullUrl: string, canonicalUrl: string, token: string) {
  const reviewsValue = await json(ctx, `${pullUrl}/reviews?per_page=100`, token);
  if (!Array.isArray(reviewsValue) || reviewsValue.length >= 100) throw new Error("inventory");
  const reviews = reviewsValue.map(raw => review(raw, canonicalUrl)).filter(value => value !== null);
  if (new Set(reviews.map(review => review.id)).size !== reviews.length) throw new Error("inventory");
  return reviews;
}

function reviewBody(value: unknown) {
  const body = value === null ? "" : value;
  if (typeof body !== "string" || body.length > 8000) throw new Error("shape");
  return body;
}
function reviewState(value: unknown): ControllerGithubFeedback["reviews"][number]["state"] {
  const state = string(value, 100);
  if (!["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(state)) throw new Error("shape");
  return state as ControllerGithubFeedback["reviews"][number]["state"];
}
function review(raw: unknown, canonicalUrl: string): ControllerGithubFeedback["reviews"][number] | null {
  const item = object(raw);
  if (item.state === "PENDING") return null;
  const id = item.id, headSha = string(item.commit_id, 40), submittedAt = string(item.submitted_at, 100), url = safeUrl(item.html_url);
  if (![Number.isSafeInteger(id), Number(id) > 0, /^[a-f0-9]{40}$/.test(headSha), url.startsWith(`${canonicalUrl}#pullrequestreview-`),
    Number.isFinite(Date.parse(submittedAt))].every(Boolean)) throw new Error("shape");
  return { id: Number(id), author: string(object(item.user).login, 200), headSha, state: reviewState(item.state),
    body: reviewBody(item.body), url, submittedAt };
}

async function readFeedback(ctx: PluginContext, m: MissionRecord, job: PluginJobContext, token: string, number: string) {
  const n5 = m.aggregate.n5!, p = n5.publication!, o = p.observation!, repo = n5.authority.repository;
  const prefix = `${api}/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, pullUrl = `${prefix}/pulls/${number}`;
  const expected = { url: o.url, headSha: o.headSha, headRef: n5.authority.headRef, baseRef: n5.authority.baseRef, draft: o.draft };
  const before = pr(await json(ctx, pullUrl, token)); assertPrBinding(before, expected);
  const checks = await readChecks(ctx, prefix, o.headSha, o.url, token);
  const reviews = await readReviews(ctx, pullUrl, o.url, token);
  const after = pr(await json(ctx, pullUrl, token));
  if (!samePr(before, after)) throw new Error("changed");
  assertPrBinding(after, expected);
  return { protocol: "controller-github-feedback-v1", provenance: "council_continuity_http", missionId: m.missionId,
    intentId: p.intentId, issueId: p.issueId!, jobRunId: job.runId, observedAt: new Date().toISOString(), url: o.url,
    repository: repo, headSha: o.headSha, baseRef: n5.authority.baseRef, headRef: n5.authority.headRef, draft: o.draft,
    checks, reviews } satisfies ControllerGithubFeedback;
}

/** Refresh a settled publisher report through the already scheduled Council continuity job. */
export async function reconcileControllerGithubFeedback(ctx: PluginContext, m: MissionRecord, job: PluginJobContext) {
  if (!refreshEligible(m)) return m;
  const n5 = m.aggregate.n5!, p = n5.publication!, contract = n5.authority.contract!, authority = contract.feedbackRefresh!;
  const observation = p.observation!, current = (p.controllerFeedbackReport ?? p.feedbackReport)!;
  const states = githubFeedbackStates(contract, current);
  const feedbackFresh = fresh(current.observedAt);
  if (feedbackFresh && feedbackSettled(contract.result, states)) return m;
  const number = pullNumber(n5.authority.repository, observation.url, observation.headSha, p.submission.candidateCommit);
  if (!number) return m;
  await assertFeedbackAuthority(ctx, m, authority);
  let report: ControllerGithubFeedback;
  try {
    const token = await ctx.secrets.resolve(authority.secretRef, { companyId: m.companyId, configPath: "githubFeedbackToken" });
    report = await readFeedback(ctx, m, job, token, number);
  } catch {
    // Transport, scope, truncation and cohort errors remain a pending result.
    // Do not persist raw provider errors or resolved credentials.
    return m;
  }
  const previous = p.controllerFeedbackReport;
  const comparable = (value: ControllerGithubFeedback) => ({ ...value, observedAt: null, jobRunId: null });
  if (previous && feedbackFresh && canonicalPayloadHash(comparable(previous)) === canonicalPayloadHash(comparable(report))) return m;
  const derived = githubFeedbackStates(contract, report);
  const common = { headSha: report.headSha, observedAt: report.observedAt, agentId: null, runId: null };
  return n2Cas(ctx, m, { ...m.aggregate, n5: { ...n5, publication: { ...p, controllerFeedbackReport: report,
    checks: { ...common, state: derived.checks, evidenceRefs: report.checks.map(check => check.evidenceUrl) },
    reviews: { ...common, state: derived.reviews, evidenceRefs: report.reviews.map(review => review.url) } } } });
}

function refreshEligible(m: MissionRecord) {
  const n5 = m.aggregate.n5, p = n5?.publication;
  const inputs = [n5?.authority.contract, n5?.authority.contract?.feedbackRefresh, p?.settledAt, p?.feedbackReport,
    p?.observation, !p?.readbackUnavailable, p?.issueId].every(Boolean);
  const operation = ["create", "update"].includes(p?.operation ?? "create");
  const continuity = !m.aggregate.linearContinuity || m.aggregate.linearContinuity.control === "running";
  return inputs && operation && continuity;
}
function fresh(observedAt: string) {
  const observed = Date.parse(observedAt);
  return [Number.isFinite(observed), Date.now() - observed <= 300_000, observed <= Date.now() + 5_000].every(Boolean);
}
function feedbackSettled(result: string, states: ReturnType<typeof githubFeedbackStates>) {
  return states.checks !== "pending" && (result === "draft-pr" || states.reviews !== "pending");
}
function pullNumber(repository: string, url: string, observedHead: string, candidateCommit: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)$/.exec(url);
  return match && [match[1] === repository, candidateCommit === observedHead].every(Boolean) ? match[2]! : null;
}
async function assertFeedbackAuthority(ctx: PluginContext, m: MissionRecord, authority: NonNullable<NonNullable<NonNullable<MissionRecord["aggregate"]["n5"]>["authority"]["contract"]>["feedbackRefresh"]>) {
  await assertProjectDeparture(ctx, m);
  const pinned = m.aggregate.projectMandate?.publication?.contract?.feedbackRefresh;
  const config = await ctx.config.get(m.companyId);
  if (![pinned, pinned && canonicalPayloadHash(pinned) === canonicalPayloadHash(authority),
    matchesGithubFeedbackSecret(authority, config.githubFeedbackToken)].every(Boolean)) {
    throw new MissionError(409, "github_feedback_authority_changed", "Controller GitHub read authority no longer matches the pinned project and native secret reference");
  }
}
