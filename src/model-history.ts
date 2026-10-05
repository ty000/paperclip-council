import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { councilNativeRequest } from "./decision-adapter.js";
import { ModelSelectionError } from "./model-state.js";

const MAX_PAGES = 256;
const PAGE_SIZE = 100;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const PART_CHARACTERS = 16000;

export type InterventionHistoryInput = {
  companyId: string; missionId: string; interventionKey: string; issues: string[];
  runs: Array<{ runId: string; issueId: string; agentId: string }>;
  journal: Array<Record<string, unknown>>;
};
export type HistoryPart = {
  name: string; content: string; sha256: string; source: string; bytes: number;
  file: string; position: number; encoding: "utf-8";
};
export type HistoryArchive = {
  version: 1; companyId: string; missionId: string; interventionKey: string; cutoff: string;
  parts: HistoryPart[];
  files: Array<{ name: string; source: string; sha256: string; bytes: number; parts: string[] }>;
  gaps: Array<{ source: string; reason: string }>;
  excluded: Array<{ source: string; count: number; reason: string }>;
  runs: InterventionHistoryInput["runs"];
  limits: { maxPages: number; maxArchiveBytes: number; maxAttachmentBytes: number };
};
export type PublishedInterventionHistory = {
  indexKey: string; indexSha256: string; parts: Array<{ key: string; name: string; sha256: string }>;
};

function hash(content: string | Uint8Array) { return createHash("sha256").update(content).digest("hex"); }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function id(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9-]{1,128}$/.test(value); }
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(v => !record(v))) throw new Error("Invalid public list");
  return value as Record<string, unknown>[];
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function json(value: unknown) { return JSON.stringify(value, null, 2) + "\n"; }
function usageCounters(value: unknown) {
  const usage = record(value);
  return Object.fromEntries(["inputTokens", "outputTokens", "cachedInputTokens"].flatMap(key => {
    const count = usage?.[key];
    return typeof count === "number" && Number.isFinite(count) && count >= 0 ? [[key, count]] : [];
  }));
}
class PublicHistoryReadError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}
function chunks(content: string) {
  const result: string[] = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + PART_CHARACTERS);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    result.push(content.slice(offset, end)); offset = end;
  }
  return result;
}

/** Public material only. The caller independently settles prior run state/effects before any ascent. */
export async function collectInterventionHistory(ctx: PluginContext, input: InterventionHistoryInput): Promise<HistoryArchive> {
  const archive: HistoryArchive = {
    version: 1, companyId: input.companyId, missionId: input.missionId, interventionKey: input.interventionKey,
    cutoff: new Date().toISOString(), parts: [], files: [], gaps: [], excluded: [], runs: [],
    limits: { maxPages: MAX_PAGES, maxArchiveBytes: MAX_ARCHIVE_BYTES, maxAttachmentBytes: MAX_ATTACHMENT_BYTES },
  };
  let bytes = 0;
  const gap = (source: string, reason: string) => { archive.gaps.push({ source, reason }); };
  const exclude = (source: string, count: number, reason: string) => { if (count) archive.excluded.push({ source, count, reason }); };
  function add(source: string, value: unknown) {
    const content = json(value); const size = Buffer.byteLength(content);
    if (bytes + size > MAX_ARCHIVE_BYTES) { gap(source, "archive_byte_limit"); return false; }
    bytes += size;
    const name = `source-${String(archive.files.length + 1).padStart(5, "0")}.json`;
    const parts: string[] = [];
    for (const chunk of chunks(content)) {
      const partName = `${name}.part-${String(parts.length + 1).padStart(4, "0")}`;
      archive.parts.push({ name: partName, content: chunk, source, sha256: hash(chunk), bytes: Buffer.byteLength(chunk),
        file: name, position: parts.length, encoding: "utf-8" });
      parts.push(partName);
    }
    archive.files.push({ name, source, sha256: hash(content), bytes: size, parts });
    return true;
  }
  async function read<T>(source: string, action: () => Promise<T>): Promise<T | undefined> {
    try { return await action(); }
    catch (error) {
      gap(source, error instanceof PublicHistoryReadError ? error.reason
        : error instanceof Error && /^Native response is not bounded valid JSON .*truncated=true,/.test(error.message)
          ? "public_response_size_limit" : "public_read_failed");
      return undefined;
    }
  }
  async function native(source: string, options: Parameters<typeof councilNativeRequest>[3] = {}) {
    const response = await councilNativeRequest(ctx, input.companyId, source, options);
    if (response.status !== 200) throw new PublicHistoryReadError(`public_http_${response.status}`);
    return response.body;
  }
  const issueIds = new Set(input.issues.filter(id));
  if (issueIds.size !== new Set(input.issues).size) gap("input:issues", "invalid_issue_ids_excluded");
  const suppliedRunIds = new Set(input.runs.map(r => r.runId));
  const journal = input.journal.filter(row => row.interventionKey === input.interventionKey
    || row.contributionId === input.interventionKey || suppliedRunIds.has(String(row.runId ?? "")));
  add("council:intervention-journal", journal);
  exclude("council:intervention-journal", input.journal.length - journal.length, "other_or_unattributed_intervention");

  // Only an explicit produced-artifact inventory establishes ownership of material
  // whose public API has no run attribution (notably document revisions).
  const artifactRefs = journal.flatMap(row => record(row.historyArtifacts) ? [record(row.historyArtifacts)!] : []);
  const explicit = (field: string, value: unknown) => typeof value === "string" && artifactRefs.some(ref => strings(ref[field]).includes(value));
  const documentRefs = artifactRefs.flatMap(ref => Array.isArray(ref.documents) ? ref.documents.flatMap(d => record(d) ? [record(d)!] : []) : []);
  const acceptedRuns = new Set<string>();

  for (const run of input.runs) {
    const source = `/api/heartbeat-runs/${run.runId}`;
    if (!id(run.runId) || !id(run.agentId) || !issueIds.has(run.issueId)) { gap(source, "run_binding_invalid"); continue; }
    if (acceptedRuns.has(run.runId)) continue;
    const response = await read(source, () => native(source));
    const value = record(response);
    if (!value) { if (response !== undefined) gap(source, "invalid_public_run"); continue; }
    const contextIssue = record(value.contextSnapshot)?.issueId;
    if (value.id !== run.runId || value.companyId !== input.companyId || value.agentId !== run.agentId
        || (value.nativeIssueId !== run.issueId && contextIssue !== run.issueId)
        || (value.nativeIssueId != null && value.nativeIssueId !== run.issueId)
        || (contextIssue != null && contextIssue !== run.issueId)) { gap(source, "run_binding_mismatch"); continue; }
    acceptedRuns.add(run.runId); archive.runs.push({ ...run });
    // Do not copy contextSnapshot, sessions, resultJson or provider trace fields.
    add(source, { ...run, status: value.status, startedAt: value.startedAt, finishedAt: value.finishedAt,
      usageJson: usageCounters(value.usageJson) });

    // Native streams classify transport (stdout/stderr/system), not authorship.
    // Even a correctly bound run can contain input, other reviewers' opinions or
    // private provider traces. Do not fetch/copy or heuristically parse them.
    gap(`${source}/log`, "raw_transcript_attribution_unproven");
    gap(`${source}/events`, "raw_transcript_attribution_unproven");
  }

  function belongs(row: Record<string, unknown>, issueId: string, kind: "comment" | "interaction" | "attachment") {
    if (row.issueId !== issueId || row.companyId !== input.companyId) return false;
    const runId = kind === "comment" ? row.createdByRunId ?? row.derivedCreatedByRunId
      : kind === "interaction" ? row.sourceRunId : row.originatingRunId;
    // An explicit different run always wins over an artifact reference.
    if (typeof runId === "string") return acceptedRuns.has(runId);
    if (kind === "attachment" && typeof row.issueCommentId === "string" && acceptedComments.has(row.issueCommentId)) return true;
    return explicit(`${kind}Ids`, row.id);
  }
  const acceptedComments = new Set<string>();
  function select(source: string, values: Record<string, unknown>[], issueId: string, kind: "comment" | "interaction" | "attachment") {
    const selected = values.filter(row => belongs(row, issueId, kind));
    const omitted = values.length - selected.length;
    exclude(source, omitted, "outside_intervention_or_attribution_missing");
    if (omitted) gap(source, "records_without_proven_intervention_attribution_excluded");
    return selected;
  }
  for (const issueId of issueIds) {
    const source = `sdk:issues/${issueId}`;
    const issue = await read(source, () => ctx.issues.get(issueId, input.companyId));
    if (!issue) { if (issue === null) gap(source, "issue_unavailable"); continue; }
    if (issue.id !== issueId || issue.companyId !== input.companyId) { gap(source, "issue_binding_mismatch"); continue; }
    add(source, { id: issue.id, companyId: issue.companyId, identifier: issue.identifier, title: issue.title,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, parentId: issue.parentId, projectId: issue.projectId });
    gap(source, "shared_issue_body_not_attributed_to_intervention");

    const commentSource = `/api/issues/${issueId}/comments`; let after: string | undefined;
    const seenComments = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const comments = await read(commentSource, async () => rows(await native(commentSource, { commentPage: { after, limit: PAGE_SIZE } })));
      if (!comments) break;
      if (comments.some(c => !id(c.id) || seenComments.has(c.id))) { gap(commentSource, "comment_cursor_did_not_advance"); break; }
      const selected = select(commentSource, comments, issueId, "comment");
      for (const c of selected) acceptedComments.add(String(c.id));
      if (!add(`${commentSource}?after=${after ?? ""}`, selected)) break;
      if (!comments.length) break;
      comments.forEach(c => seenComments.add(String(c.id))); after = String(comments.at(-1)!.id);
      if (page === MAX_PAGES - 1) gap(commentSource, "page_limit");
    }
    const interactionsSource = `${source}/interactions`;
    const interactions = await read(interactionsSource, async () => rows(await ctx.issues.listInteractions(issueId, input.companyId)));
    if (interactions) add(interactionsSource, select(interactionsSource, interactions, issueId, "interaction"));

    const documentsSource = `${source}/documents`;
    const documents = await read(documentsSource, () => ctx.issues.documents.list(issueId, input.companyId));
    for (const document of documents ?? []) {
      const docSource = `${documentsSource}/${document.key}`;
      const ref = documentRefs.find(r => r.issueId === issueId && r.key === document.key);
      if (!ref || document.issueId !== issueId || document.companyId !== input.companyId) {
        gap(docSource, "document_has_no_explicit_intervention_attribution"); continue;
      }
      const revisionIds = new Set(strings(ref.revisionIds));
      if (typeof ref.latestRevisionId === "string") revisionIds.add(ref.latestRevisionId);
      if (document.latestRevisionId && revisionIds.has(document.latestRevisionId)) {
        const full = await read(docSource, () => ctx.issues.documents.get(issueId, document.key, input.companyId));
        if (full?.issueId === issueId && full.companyId === input.companyId && full.key === document.key
            && full.latestRevisionId === document.latestRevisionId) add(docSource, full);
        else if (full !== undefined) gap(docSource, "document_changed_or_unavailable");
      } else gap(docSource, "current_document_revision_not_attributed");
      const revisionSource = `/api/issues/${issueId}/documents/${document.key}/revisions`;
      const revisions = await read(revisionSource, async () => rows(await native(revisionSource)));
      if (revisions) {
        const selected = revisions.filter(r => r.issueId === issueId && r.companyId === input.companyId && r.key === document.key && revisionIds.has(String(r.id)));
        add(revisionSource, selected);
        exclude(revisionSource, revisions.length - selected.length, "revision_not_attributed");
        for (const revisionId of revisionIds) if (!selected.some(r => r.id === revisionId)) gap(`${revisionSource}/${revisionId}`, "referenced_revision_unavailable");
      }
    }

    const attachmentsSource = `${source}/attachments`;
    const attachments = await read(attachmentsSource, async () => rows(await ctx.issues.listAttachments(issueId, input.companyId)));
    for (const attachment of attachments ? select(attachmentsSource, attachments, issueId, "attachment") : []) {
      const attachmentSource = `${attachmentsSource}/${attachment.id}`;
      add(attachmentSource, attachment);
      if (!id(attachment.id)) { gap(attachmentSource, "invalid_attachment_id"); continue; }
      const content = await read(`${attachmentSource}/content`, () => ctx.issues.getAttachmentContent(attachment.id as string, input.companyId, { maxBytes: MAX_ATTACHMENT_BYTES }));
      if (!content) { if (content === null) gap(attachmentSource, "attachment_content_unavailable"); continue; }
      const raw = Buffer.from(content.contentBase64, "base64");
      if (content.attachmentId !== attachment.id || raw.length !== content.byteSize || raw.length > MAX_ATTACHMENT_BYTES
          || raw.toString("base64") !== content.contentBase64 || hash(raw) !== content.sha256
          || content.sha256 !== attachment.sha256 || content.byteSize !== attachment.byteSize) {
        gap(attachmentSource, "attachment_integrity_mismatch"); continue;
      }
      add(`${attachmentSource}/content`, { ...content, encoding: "base64" });
    }
  }
  return archive;
}

class HistoryPublicationError extends ModelSelectionError {
  constructor(public readonly code: "history_archive_invalid" | "history_document_conflict" | "history_readback_mismatch", message: string) {
    super(code, message); this.name = "HistoryPublicationError";
  }
}

/** No wake. Callers serialize a launch; the public upsert API does not provide atomic create-only/CAS. */
export async function publishInterventionHistory(ctx: PluginContext, companyId: string, targetIssueId: string,
  launchKey: string, archive: HistoryArchive): Promise<PublishedInterventionHistory> {
  if (archive.companyId !== companyId || !launchKey || !id(targetIssueId)
      || new Set(archive.parts.map(p => p.name)).size !== archive.parts.length
      || archive.parts.some(p => hash(p.content) !== p.sha256 || Buffer.byteLength(p.content) !== p.bytes)) {
    throw new HistoryPublicationError("history_archive_invalid", "Archive identity or content hashes do not match");
  }
  const indexedParts = new Map(archive.parts.map(p => [p.name, p]));
  const indexedNames: string[] = [];
  for (const file of archive.files) {
    const fileParts = file.parts.map(name => indexedParts.get(name));
    const content = fileParts.map(part => part?.content ?? "").join("");
    if (fileParts.some((part, position) => !part || part.file !== file.name || part.position !== position || part.source !== file.source)
        || hash(content) !== file.sha256 || Buffer.byteLength(content) !== file.bytes) {
      throw new HistoryPublicationError("history_archive_invalid", "Archive file index does not match its content");
    }
    indexedNames.push(...file.parts);
  }
  if (indexedNames.length !== archive.parts.length || new Set(indexedNames).size !== archive.parts.length) {
    throw new HistoryPublicationError("history_archive_invalid", "Archive has missing or duplicate indexed parts");
  }
  const issue = await ctx.issues.get(targetIssueId, companyId);
  if (!issue || issue.id !== targetIssueId || issue.companyId !== companyId) {
    throw new HistoryPublicationError("history_archive_invalid", "History target is outside the archive company");
  }
  const prefix = `council-history-${hash(json([companyId, archive.missionId, archive.interventionKey, launchKey])).slice(0, 32)}`;
  const indexKey = `${prefix}-index`;
  const parts = archive.parts.map((p, i) => ({ key: `${prefix}-p${String(i + 1).padStart(5, "0")}`, name: p.name, sha256: p.sha256 }));
  const manifest = { ...archive, parts: archive.parts.map(({ content: _content, ...p }, i) => ({ ...p, documentKey: parts[i]!.key })), launchKey, targetIssueId };
  const manifestBody = json(manifest);
  const manifestPages = chunks(manifestBody).map((body, i) => ({ key: `${prefix}-m${String(i + 1).padStart(5, "0")}`, body }));
  const index = { version: 1, companyId, missionId: archive.missionId, interventionKey: archive.interventionKey, launchKey,
    cutoff: archive.cutoff, fileCount: archive.files.length, gapCount: archive.gaps.length, manifestSha256: hash(manifestBody),
    manifestPages: manifestPages.map(p => ({ key: p.key, sha256: hash(p.body), bytes: Buffer.byteLength(p.body) })) };
  const indexBody = `# Council intervention history\n\nRead the manifest pages below in order and concatenate them to recover the full JSON inventory, provenance and gaps. It indexes all content pages; concatenate each file's parts in order to recover its exact UTF-8 JSON. Read progressively without replacing files by a summary. Binary contents remain base64 with original metadata and SHA-256. Only attributable public material is collected. Raw run logs and events are omitted because their APIs do not distinguish produced output from input context, protected opinions or private provider traces; each omission is recorded as a gap. Private sessions, provider trace fields and unattributed material are excluded. This archive is not a complete transcript. Gaps do not establish prior execution state.\n\n\`\`\`json\n${json(index)}\`\`\`\n`;
  const documents = [...archive.parts.map((part, i) => ({ key: parts[i]!.key, body: part.content })), ...manifestPages, { key: indexKey, body: indexBody }];
  // Inspect every existing key before any write. Existing immutable content is reused.
  const existing = new Map<string, boolean>();
  for (const document of documents) {
    const prior = await ctx.issues.documents.get(targetIssueId, document.key, companyId);
    if (prior && (prior.issueId !== targetIssueId || prior.companyId !== companyId || prior.key !== document.key || prior.body !== document.body)) {
      throw new HistoryPublicationError("history_document_conflict", `History document ${document.key} already contains different data`);
    }
    existing.set(document.key, prior !== null);
  }
  for (const document of documents) {
    if (!existing.get(document.key)) await ctx.issues.documents.upsert({ issueId: targetIssueId, companyId, key: document.key,
      body: document.body, format: "markdown", title: document.key === indexKey ? "Council intervention history index" : document.key,
      changeSummary: "Immutable Council intervention history for an authorized attempt" });
    const observed = await ctx.issues.documents.get(targetIssueId, document.key, companyId);
    if (!observed || observed.issueId !== targetIssueId || observed.companyId !== companyId || observed.key !== document.key || observed.body !== document.body) {
      throw new HistoryPublicationError("history_readback_mismatch", `History document ${document.key} readback differs`);
    }
  }
  return { indexKey, indexSha256: hash(indexBody), parts };
}
