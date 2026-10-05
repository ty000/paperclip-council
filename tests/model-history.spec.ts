import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { councilNativeRequest } from "../src/decision-adapter.js";
import { collectInterventionHistory, publishInterventionHistory, type HistoryArchive, type InterventionHistoryInput } from "../src/model-history.js";

const sha = (content: string | Uint8Array) => createHash("sha256").update(content).digest("hex");
const binding = { runId: "run-1", issueId: "issue-1", agentId: "agent-1" };
function input(): InterventionHistoryInput {
  return { companyId: "company-1", missionId: "mission-1", interventionKey: "review-1", issues: ["issue-1"], runs: [binding],
    journal: [{ interventionKey: "review-1", runId: "run-1", action: "own-event" }, { interventionKey: "review-other", action: "other-opinion" }] };
}
function fixture() {
  const documents = new Map<string, Record<string, unknown>>();
  const issue = { id: "issue-1", companyId: "company-1", title: "Task", description: "OTHER SHARED OPINION", status: "todo", identifier: "C-1" };
  const get = vi.fn(async (_issueId: string, key: string, _companyId: string) => documents.get(key) ?? null);
  const upsert = vi.fn(async (value: Record<string, unknown>) => { const doc = { ...value, id: `doc-${value.key}` }; documents.set(String(value.key), doc); return doc; });
  const sdk = {
    get: vi.fn(async (issueId: string) => ({ ...issue, id: issueId })),
    listInteractions: vi.fn(async () => [] as unknown[]),
    listAttachments: vi.fn(async () => [] as unknown[]),
    getAttachmentContent: vi.fn(async () => null as unknown),
    documents: { list: vi.fn(async () => [] as unknown[]), get, upsert },
    requestWakeup: vi.fn(async () => { throw Error("No wake authorized"); }),
    summaries: { getOrchestration: vi.fn(async () => { throw Error("No summary inventory authorized"); }) },
  };
  const ctx = { issues: sdk, config: { get: async () => ({ apiBaseUrl: "http://localhost:3100", councilAgentId: "council", councilApiKey: { type: "secret_ref", secretId: "fixture" } }) },
    secrets: { resolve: vi.fn(async () => "fixture-token") } } as unknown as PluginContext;
  const respond = (url: URL): unknown => {
    if (url.pathname === "/api/heartbeat-runs/run-1") return { id: "run-1", companyId: "company-1", agentId: "agent-1",
      status: "succeeded", contextSnapshot: { issueId: "issue-1", privateSession: "DO NOT COPY" }, resultJson: { privateProviderTrace: "DO NOT COPY" } };
    if (url.pathname.endsWith("/log")) return { runId: "run-1", content: "public log" };
    return [];
  };
  const fetch = vi.fn(async (raw: string | URL | Request) => new Response(JSON.stringify(respond(new URL(String(raw)))), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return { ctx, sdk, documents, get, upsert, fetch, respond };
}
function decoded(archive: HistoryArchive, source: string) {
  const file = archive.files.find(f => f.source === source)!;
  return JSON.parse(file.parts.map(name => archive.parts.find(p => p.name === name)!.content).join(""));
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("public intervention history", () => {
  it("binds durable runs and walks attributable comments to exhaustion", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async raw => {
      const url = new URL(String(raw)); let body: unknown = f.respond(url);
      if (url.pathname.endsWith("/comments")) {
        body = !url.searchParams.get("after") ? [{ id: "comment-1", companyId: "company-1", issueId: "issue-1", createdByRunId: "run-1", body: "own comment" }]
          : url.searchParams.get("after") === "comment-1" ? [{ id: "comment-2", companyId: "company-1", issueId: "issue-1", createdByRunId: "run-other", body: "OTHER OPINION" }] : [];
      }
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(decoded(archive, "/api/heartbeat-runs/run-1")).toMatchObject({ ...binding, status: "succeeded" });
    expect(decoded(archive, "/api/issues/issue-1/comments?after=")[0].body).toBe("own comment");
    expect(archive.runs).toEqual([binding]);
    const content = archive.parts.map(p => p.content).join("");
    expect(content).not.toMatch(/OTHER OPINION|OTHER SHARED OPINION|other-opinion|DO NOT COPY|privateSession|privateProviderTrace/);
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toContain("http://localhost:3100/api/issues/issue-1/comments?limit=100&order=asc&after=comment-2");
    expect(f.sdk.summaries.getOrchestration).not.toHaveBeenCalled();
    for (const file of archive.files) {
      const body = file.parts.map(name => archive.parts.find(p => p.name === name)!.content).join("");
      expect(sha(body)).toBe(file.sha256); expect(Buffer.byteLength(body)).toBe(file.bytes);
    }
  });

  it("never reads or republishes unclassified prompt, protected opinions or private traces from a bound run", async () => {
    const f = fixture();
    const sensitive = { prompt: "PROMPT_WITH_OTHER_CONTEXT", protectedOpinion: "INDEPENDENT_REVIEWER_SECRET_OPINION",
      providerTrace: "PRIVATE_PROVIDER_TRACE_CONTENT" };
    // Both public endpoints can return these fields despite exact run/company binding.
    const rawLog = { runId: "run-1", content: JSON.stringify({ stream: "stdout", chunk: JSON.stringify(sensitive) }) };
    const rawEvents = [{ id: 1, seq: 1, runId: "run-1", companyId: "company-1", eventType: "adapter.output",
      stream: "stdout", message: sensitive.protectedOpinion, payload: sensitive }];
    f.fetch.mockImplementation(async raw => {
      const url = new URL(String(raw));
      const body = url.pathname.endsWith("/log") ? rawLog
        : url.pathname.endsWith("/events") ? rawEvents
          : url.pathname.endsWith("/run-1") ? { ...f.respond(url) as object,
            usageJson: { inputTokens: 42, outputTokens: sensitive.providerTrace, ...sensitive } }
            : f.respond(url);
      return new Response(JSON.stringify(body));
    });
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(f.fetch.mock.calls.every(([url]) => !/\/(log|events)(\?|$)/.test(String(url)))).toBe(true);
    expect(archive.gaps).toEqual(expect.arrayContaining([
      { source: "/api/heartbeat-runs/run-1/log", reason: "raw_transcript_attribution_unproven" },
      { source: "/api/heartbeat-runs/run-1/events", reason: "raw_transcript_attribution_unproven" },
    ]));
    expect(archive.files.some(file => /\/(log|events)(\?|$)/.test(file.source))).toBe(false);
    expect(decoded(archive, "/api/heartbeat-runs/run-1").usageJson).toEqual({ inputTokens: 42 });
    const result = await publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive);
    const published = [...f.documents.values()].map(doc => String(doc.body)).join("");
    for (const marker of Object.values(sensitive)) {
      expect(JSON.stringify(archive)).not.toContain(marker);
      expect(published).not.toContain(marker);
    }
    expect(String(f.documents.get(result.indexKey)!.body)).toContain("not a complete transcript");
    expect(f.sdk.requestWakeup).not.toHaveBeenCalled();
  });

  it("does not fetch run logs/events when public run identity differs", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async raw => new Response(JSON.stringify(String(raw).endsWith("/run-1")
      ? { ...f.respond(new URL(String(raw))) as object, agentId: "foreign-agent" } : [])));
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(archive.runs).toEqual([]);
    expect(archive.gaps).toContainEqual({ source: "/api/heartbeat-runs/run-1", reason: "run_binding_mismatch" });
    expect(f.fetch.mock.calls.every(([url]) => !/\/(log|events)(\?|$)/.test(String(url)))).toBe(true);
  });

  it("keeps public read failures and stalled cursors explicit without retrying or summarizing", async () => {
    const f = fixture();
    f.sdk.listInteractions.mockRejectedValue(Error("fixture denied"));
    f.sdk.documents.list.mockRejectedValue(Error("fixture denied"));
    f.fetch.mockImplementation(async raw => {
      const url = new URL(String(raw));
      const body = url.pathname.endsWith("/comments") ? [{ id: "same", companyId: "company-1", issueId: "issue-1", createdByRunId: "run-1", body: "once" }]
          : f.respond(url);
      return new Response(JSON.stringify(body));
    });
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(archive.gaps.map(g => g.reason)).toEqual(expect.arrayContaining(["raw_transcript_attribution_unproven", "comment_cursor_did_not_advance", "public_read_failed"]));
    expect(archive.parts.some(p => p.content.includes("fixture denied"))).toBe(false);
    expect(f.sdk.requestWakeup).not.toHaveBeenCalled();
  });

  it("stops unbounded pagination at the recorded technical limit", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async raw => {
      const url = new URL(String(raw));
      const seq = Number(url.searchParams.get("after")?.split("-").at(-1) ?? 0) + 1;
      return new Response(JSON.stringify(url.pathname.endsWith("/comments")
        ? [{ id: `comment-${seq}`, createdByRunId: "run-1", issueId: "issue-1", companyId: "company-1" }] : f.respond(url)));
    });
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(archive.gaps).toContainEqual({ source: "/api/issues/issue-1/comments", reason: "page_limit" });
    expect(f.fetch.mock.calls.filter(([url]) => String(url).includes("/comments?")).length).toBe(archive.limits.maxPages);
  });

  it("collects explicitly attributed document revisions and binary metadata; excludes other opinions", async () => {
    const f = fixture(); const args = input();
    args.journal[0]!.historyArtifacts = { documents: [{ issueId: "issue-1", key: "own_doc", latestRevisionId: "revision-1" }] };
    const doc = { id: "doc-1", companyId: "company-1", issueId: "issue-1", key: "own_doc", latestRevisionId: "revision-1", body: "whole document" };
    f.sdk.documents.list.mockResolvedValue([doc, { ...doc, key: "other-opinion" }]); f.documents.set("own_doc", doc);
    const raw = Buffer.from([0, 1, 128, 255]); const hash = sha(raw);
    const attachment = { id: "attachment-1", companyId: "company-1", issueId: "issue-1", originatingRunId: "run-1", sha256: hash, byteSize: 4, contentType: "application/octet-stream" };
    f.sdk.listAttachments.mockResolvedValue([attachment]);
    f.sdk.getAttachmentContent.mockResolvedValue({ attachmentId: "attachment-1", contentType: "application/octet-stream", originalFilename: "proof.bin", byteSize: 4, sha256: hash, contentBase64: raw.toString("base64") });
    f.sdk.listInteractions.mockResolvedValue([{ id: "interaction-1", companyId: "company-1", issueId: "issue-1", sourceRunId: "run-1", payload: { detail: "full interaction" } }]);
    f.fetch.mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/revisions")
      ? [{ id: "revision-1", companyId: "company-1", issueId: "issue-1", key: "own_doc", body: "whole revision" },
        { id: "revision-other", companyId: "company-1", issueId: "issue-1", key: "own_doc", body: "OTHER OPINION" }]
      : f.respond(new URL(String(url))))));
    const archive = await collectInterventionHistory(f.ctx, args);
    expect(decoded(archive, "sdk:issues/issue-1/documents/own_doc").body).toBe("whole document");
    expect(decoded(archive, "/api/issues/issue-1/documents/own_doc/revisions")).toHaveLength(1);
    expect(decoded(archive, "sdk:issues/issue-1/attachments/attachment-1/content")).toMatchObject({ contentBase64: "AAGA/w==", encoding: "base64", sha256: hash });
    expect(archive.parts.map(p => p.content).join("")).not.toContain("OTHER OPINION");
    expect(archive.gaps.some(g => g.source.endsWith("other-opinion"))).toBe(true);
    expect(f.get.mock.calls.some(([, key]) => key === "other-opinion")).toBe(false);
  });

  it("reports attachment corruption instead of presenting altered bytes as evidence", async () => {
    const f = fixture();
    f.sdk.listAttachments.mockResolvedValue([{ id: "attachment-1", companyId: "company-1", issueId: "issue-1", originatingRunId: "run-1", sha256: sha("a"), byteSize: 1 }]);
    f.sdk.getAttachmentContent.mockResolvedValue({ attachmentId: "attachment-1", byteSize: 1, sha256: sha("a"), contentBase64: "Yg==" });
    const archive = await collectInterventionHistory(f.ctx, input());
    expect(archive.gaps.some(g => g.reason === "attachment_integrity_mismatch")).toBe(true);
    expect(archive.files.some(file => file.source.endsWith("attachment-1/content"))).toBe(false);
  });
});

describe("immutable application-level history publication", () => {
  it("publishes bounded pages and full inventory before index, verifies readback, and reuses an exact replay", async () => {
    const f = fixture(); const args = input();
    args.journal[0]!.detail = "é🌳".repeat(30000);
    const archive = await collectInterventionHistory(f.ctx, args);
    expect(archive.files.find(file => file.source === "council:intervention-journal")!.parts.length).toBeGreaterThan(1);
    expect(decoded(archive, "council:intervention-journal")[0].detail).toBe(args.journal[0]!.detail);
    const result = await publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive);
    expect(f.upsert.mock.calls.at(-1)![0].key).toBe(result.indexKey);
    expect(f.upsert.mock.calls.every(([v]) => String(v.body).length < 524288)).toBe(true);
    const indexBody = String(f.documents.get(result.indexKey)!.body);
    expect(sha(indexBody)).toBe(result.indexSha256);
    const index = JSON.parse(indexBody.split("```json\n")[1]!.split("```")[0]!);
    const manifestBody = index.manifestPages.map((p: { key: string }) => f.documents.get(p.key)!.body).join("");
    expect(sha(manifestBody)).toBe(index.manifestSha256);
    const manifest = JSON.parse(manifestBody);
    expect(manifest.gaps).toEqual(archive.gaps); expect(manifest.files).toEqual(archive.files);
    expect(manifest.parts.every((p: Record<string, unknown>) => p.content === undefined && typeof p.documentKey === "string")).toBe(true);
    const writes = f.upsert.mock.calls.length;
    await expect(publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive)).resolves.toEqual(result);
    expect(f.upsert).toHaveBeenCalledTimes(writes); expect(f.sdk.requestWakeup).not.toHaveBeenCalled();
  });

  it("detects an existing conflicting part before any further write", async () => {
    const f = fixture(); const archive = await collectInterventionHistory(f.ctx, input());
    const result = await publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive);
    f.documents.set(result.parts[0]!.key, { ...f.documents.get(result.parts[0]!.key), body: "conflict" });
    f.upsert.mockClear();
    await expect(publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive)).rejects.toMatchObject({ code: "history_document_conflict" });
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it("rejects a corrupt file index before any publication", async () => {
    const f = fixture(); const archive = await collectInterventionHistory(f.ctx, input());
    archive.files[0]!.sha256 = "wrong";
    await expect(publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive)).rejects.toMatchObject({ code: "history_archive_invalid" });
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it("stops at changed readback and never writes the ready index or wakes", async () => {
    const f = fixture(); const archive = await collectInterventionHistory(f.ctx, input());
    f.upsert.mockImplementation(async value => { const wrong = { ...value, id: "doc-wrong", body: "other bytes" }; f.documents.set(String(value.key), wrong); return wrong; });
    await expect(publishInterventionHistory(f.ctx, "company-1", "target-1", "launch-1", archive)).rejects.toMatchObject({ code: "history_readback_mismatch" });
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect([...f.documents.keys()].some(key => key.endsWith("-index"))).toBe(false);
    expect(f.sdk.requestWakeup).not.toHaveBeenCalled();
  });
});

it.each([
  ["/api/issues/issue-1/comments", { commentPage: { limit: 100, after: "id&evil=true" } }],
  ["/api/issues/issue-1", { commentPage: { limit: 100 } }],
  ["/api/heartbeat-runs/run-1/events", { eventPage: { limit: 100, afterSeq: -1 } }],
  ["/api/heartbeat-runs/run-1/events", { eventPage: { limit: 101, afterSeq: 0 } }],
  ["/api/heartbeat-runs/run-1/events", { method: "POST", eventPage: { limit: 10, afterSeq: 0 } }],
] as const)("rejects unsafe pagination %s without an HTTP call", async (path, options) => {
  const f = fixture();
  await expect(councilNativeRequest(f.ctx, "company-1", path, options)).rejects.toThrow(/Invalid Council/);
  expect(f.fetch).not.toHaveBeenCalled();
});
