import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { readOrdinaryRunSummary } from "../src/n2-ordinary-report.js";
import { validateOrdinaryReport } from "../src/n2-ordinary-state.js";
import type { NativeRunReadback } from "../src/g4-native.js";

// Frozen real M1 report: the host returned only its first 500 characters.
const observation = JSON.parse(readFileSync(new URL("../docs/reviews/m1-live/observation.json", import.meta.url), "utf8"));
const report = observation.councilReport;
const complete = observation.terminalReportProof.completeFinalAgentMessage as string;
const truncated = observation.terminalReportProof.truncatedSummary as string;
const event = (text: string) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n";
const row = (chunk: string, stream = "stdout") => JSON.stringify({ stream, chunk }) + "\n";
const finished = JSON.stringify({ type: "turn.completed" }) + "\n";
function fixture(stdout = event(complete) + finished) {
  const run = { id: "run1", companyId: "company", logBytes: 0,
    resultJson: { summary: truncated, truncated: true, truncationReason: "oversized_result_json" } } as NativeRunReadback;
  // Start the byte window inside an irrelevant row; split CLI events across chunks.
  const bytes = Buffer.from(row("prior tool output " + "x".repeat(150_000)) + row(stdout.slice(0, 80)) + row(stdout.slice(80)));
  run.logBytes = bytes.length;
  const body = { runId: run.id, content: bytes.subarray(Math.max(0, bytes.length - 131072)).toString("utf8") };
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const ctx = { config: { get: async () => ({ apiBaseUrl: "http://localhost:3100", councilAgentId: "council",
    councilApiKey: { type: "secret_ref", secretId: "fixture" } }) }, secrets: { resolve: async () => "fixture-key" } } as never;
  return { ctx, run, body, fetch };
}
function validate(summary: unknown) {
  return validateOrdinaryReport({ missionId: report.missionId, aggregate: { n2: { submissions: [{
    ...report.subject, sha256: report.subject.bundleSha256,
  }] } } } as never, { taskId: report.taskId, submissionId: report.subject.submissionId, report } as never, summary);
}
afterEach(() => vi.unstubAllGlobals());

it("recovers the real 1397-character report from a completed native log with a truncated summary", async () => {
  const { ctx, run, fetch } = fixture();
  expect(() => validate(truncated)).toThrow();
  expect(validate(await readOrdinaryRunSummary(ctx, run))).toEqual(report);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `http://localhost:3100/api/heartbeat-runs/run1/log?offset=${run.logBytes! - 131072}&limitBytes=131072`,
    expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer fixture-key" }) }));
});
it("keeps ordinary complete summaries on the existing path", async () => {
  const { ctx, run, fetch } = fixture();
  run.resultJson = { summary: complete };
  expect(validate(await readOrdinaryRunSummary(ctx, run))).toEqual(report);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps the final message when a nonzero byte offset starts exactly at its log row", async () => {
  const { ctx, run, body, fetch } = fixture();
  body.content = row(event(complete)) + row(finished);
  fetch.mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));
  expect(validate(await readOrdinaryRunSummary(ctx, run))).toEqual(report);
});
it.each([
  event(complete), // No turn completion.
  event(complete) + event(JSON.stringify({ ...report, taskId: "different" })) + finished,
  JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: complete } }) + "\n" + finished,
  event(complete) + JSON.stringify({ type: "turn.started" }) + "\n" + finished,
])("does not substitute a tool echo, unfinished turn or earlier matching report", async stdout => {
  const { ctx, run } = fixture(stdout);
  expect(() => validate(truncated)).toThrow();
  const summary = await readOrdinaryRunSummary(ctx, run);
  expect(() => validate(summary)).toThrow();
});
it.each([{ runId: "another-run" }, { nextOffset: 300_000 }])("rejects wrong-run or non-terminal log pages", async patch => {
  const { ctx, run, body, fetch } = fixture();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ...body, ...patch }), { status: 200 }));
  await expect(readOrdinaryRunSummary(ctx, run)).rejects.toMatchObject({ code: "ordinary_report_missing" });
});
