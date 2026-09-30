import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  compareAndSwapFoundationProbe,
  handleFoundationProbe,
  verifyCandidateAttachment,
} from "../src/foundation-probe.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("L0 foundation probe", () => {
  it("keeps diagnostic CAS writes board-only", async () => {
    const result = await handleFoundationProbe({
      routeKey: "foundation-probe",
      method: "POST",
      path: "/issues/issue-1/foundation-probe",
      params: { issueId: "issue-1" },
      query: {},
      body: { action: "cas", probeId: "p", expectedVersion: 0, payload: {} },
      actor: { actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1" },
      companyId: "company-1",
      headers: {},
    }, {} as PluginContext, {
      apiBaseUrl: "http://127.0.0.1:3100",
      councilAgentId: "agent-1",
      councilApiKey: { type: "secret_ref", secretId: "secret-1" },
    });
    expect(result).toEqual({ status: 403, body: { error: "Board identity required for foundation CAS probe" } });
  });

  it("uses affected-row CAS semantics and reports the observed winner", async () => {
    let version = 0;
    let payload: Record<string, unknown> = {};
    const db = {
      namespace: "plugin_private_paperclip_council_270061461e",
      execute: async (sql: string, params: unknown[]) => {
        if (sql.startsWith("INSERT")) return { rowCount: 0 };
        expect(sql).toContain("AND version = $5");
        if (params[4] !== version) return { rowCount: 0 };
        version += 1;
        payload = JSON.parse(String(params[0]));
        return { rowCount: 1 };
      },
      query: async () => [{
        company_id: "company-1",
        issue_id: "issue-1",
        probe_id: "cas-1",
        version,
        payload,
      }],
    };
    const ctx = { db } as unknown as PluginContext;

    const first = await compareAndSwapFoundationProbe(ctx, {
      companyId: "company-1",
      issueId: "issue-1",
      probeId: "cas-1",
      expectedVersion: 0,
      payload: { winner: "first" },
    });
    const second = await compareAndSwapFoundationProbe(ctx, {
      companyId: "company-1",
      issueId: "issue-1",
      probeId: "cas-1",
      expectedVersion: 0,
      payload: { winner: "second" },
    });

    expect(first).toMatchObject({ outcome: "applied", probe: { version: 1, payload: { winner: "first" } } });
    expect(second).toMatchObject({ outcome: "conflict", probe: { version: 1, payload: { winner: "first" } } });
  });

  it("checks attachment bytes and a self-contained Git bundle in isolated storage", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "council-foundation-test-"));
    cleanup.push(root);
    const repository = resolve(root, "source");
    execFileSync("git", ["init", repository]);
    execFileSync("git", ["config", "user.email", "council@example.test"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Council Test"], { cwd: repository });
    execFileSync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repository });
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    execFileSync("git", ["commit", "--allow-empty", "-m", "candidate"], { cwd: repository });
    const candidateCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    execFileSync("git", ["branch", "base", baseCommit], { cwd: repository });
    execFileSync("git", ["branch", "candidate", candidateCommit], { cwd: repository });
    const bundle = resolve(root, "candidate.bundle");
    execFileSync("git", ["bundle", "create", bundle, "refs/heads/base", "refs/heads/candidate"], { cwd: repository });
    const bytes = await readFile(bundle);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachmentId = randomUUID();
    const ctx = {
      issues: {
        listAttachments: async () => [{ id: attachmentId }],
        getAttachmentContent: async () => ({
          attachmentId,
          contentType: "application/octet-stream",
          byteSize: bytes.byteLength,
          sha256,
          originalFilename: "candidate.bundle",
          contentBase64: bytes.toString("base64"),
        }),
      },
    } as unknown as PluginContext;

    await expect(verifyCandidateAttachment(ctx, {
      companyId: randomUUID(),
      issueId: randomUUID(),
      attachmentId,
      expectedSha256: sha256,
      baseCommit,
      candidateCommit,
    })).resolves.toMatchObject({
      sha256,
      baseCommit,
      candidateCommit,
      relationship: "base-is-ancestor",
      isolatedInspection: true,
    });
  });
});
