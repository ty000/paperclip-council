/** Offline rehearsal only. No HTTP, runtime, database restore, provider or publication. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleMissionApi } from "../../src/missions.js";

const root = resolve(import.meta.dirname, "../..");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const observation = JSON.parse(await readFile(resolve(root, "docs/reviews/m2-live/observation.json"), "utf8"));
const files = ["artifacts/ordinary-campaign-m2-final-paused.json", "artifacts/ordinary-campaign-m2-reference-mismatch.json", "artifacts/ordinary-campaign-m2-partial-B.bundle"];
const inputs = new Map<string, Buffer>();
for (const path of files) {
  const bytes = await readFile(resolve(root, path));
  const recorded = observation.files.find((entry: any) => entry.path === path);
  assert(recorded && recorded.sha256 === hash(bytes), "Historical input hash mismatch: " + path);
  inputs.set(path, bytes);
}
const snapshot = JSON.parse(inputs.get(files[0])!.toString());
const mismatch = JSON.parse(inputs.get(files[1])!.toString());
const mission = structuredClone(snapshot.B.mission);
const historical = structuredClone(mission.aggregate);
const directory = await mkdtemp(resolve(tmpdir(), "council-m2-recovery-rehearsal-"));
try {
  const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, GIT_AUTHOR_NAME: "Council owner recovery preparation", GIT_AUTHOR_EMAIL: "recovery@example.invalid",
    GIT_COMMITTER_NAME: "Council owner recovery preparation", GIT_COMMITTER_EMAIL: "recovery@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-04T21:14:14Z", GIT_COMMITTER_DATE: "2026-10-04T21:14:14Z",
  } }).trim();
  git("init", "--bare", "--quiet");
  git("fetch", "--quiet", resolve(root, files[2]), "refs/heads/codex/council-delivery-m2-coordination-cards:refs/heads/partial");
  const baseCommit = git("rev-parse", mismatch.acceptedACommit + "^{commit}");
  const frontendCommit = git("rev-parse", "refs/heads/partial^{commit}");
  assert.equal(frontendCommit, mismatch.frontendCommit);
  const replacementCommit = git("rev-parse", frontendCommit + "^1");
  assert.equal(replacementCommit, mismatch.actualBackendCommit);
  const candidateCommit = git("commit-tree", git("rev-parse", frontendCommit + "^{tree}"), "-p", frontendCommit,
    "-m", "Prepare owner-assisted integration of preserved M2 contributions");
  git("update-ref", "refs/heads/base", baseCommit);
  git("update-ref", "refs/heads/candidate", candidateCommit);
  const bundle = resolve(directory, "candidate.bundle");
  git("bundle", "create", bundle, "refs/heads/base", "refs/heads/candidate");
  const bytes = await readFile(bundle);
  const sha256 = hash(bytes);
  // This attachment ID belongs solely to the in-memory SDK fixture, never to Paperclip.
  const fixtureAttachment = "11111111-1111-4111-8111-111111111111";
  const body = { command: "recover-integration", commandId: "22222222-2222-4222-8222-222222222222", expectedVersion: mission.version,
    contributionId: mismatch.payload.contributionId, previousCommit: mismatch.recordedBackendCommit, replacementCommit,
    reason: "Owner-assisted recovery of the known recorded-reference mismatch; exact original Git objects retained",
    attachmentId: fixtureAttachment, expectedSha256: sha256, baseCommit, candidateCommit };
  let aggregate = structuredClone(historical), version = mission.version, writes = 0;
  const row = () => ({ ...mission, company_id: mission.companyId, mission_id: mission.missionId,
    root_issue_id: mission.rootIssueId, project_id: mission.projectId, owner_user_id: mission.ownerUserId,
    team_roster_id: mission.teamRosterId, team_revision: mission.teamRevision,
    council_roster_id: mission.councilRosterId, council_revision: mission.councilRevision,
    aggregate, version, created_at: mission.createdAt, updated_at: mission.updatedAt });
  const ctx = {
    db: { namespace: "plugin_council_recovery_fixture",
      query: async (sql: string) => sql.includes(".admission") ? [{ company_id: mission.companyId, period_key: historical.n1.periodKey,
        version: snapshot.admission.envelope.version, document: snapshot.admission.envelope,
        created_at: snapshot.admission.envelope.createdAt, updated_at: snapshot.admission.envelope.updatedAt }] : [row()],
      execute: async (_sql: string, parameters: any[]) => {
        assert.equal(parameters[3], version); aggregate = JSON.parse(parameters[0]); version++; writes++; return { rowCount: 1 };
      },
    },
    companies: { get: async () => ({ id: mission.companyId, defaultResponsibleUserId: mission.ownerUserId }) },
    issues: {
      get: async (issueId: string) => {
        const slot = historical.n1.contributions.find((item: any) => item.childIssueId === issueId);
        assert(slot, "Only recorded child reads expected");
        return { id: issueId, companyId: mission.companyId, projectId: mission.projectId, parentId: mission.rootIssueId,
          assigneeAgentId: slot.assigneeAgentId, status: "done" };
      },
      summaries: { getOrchestration: async ({ issueId }: { issueId: string }) => ({ runs: snapshot.runs.filter((run: any) => run.contextSnapshot.issueId === issueId) }) },
      listAttachments: async () => [{ id: fixtureAttachment }],
      getAttachmentContent: async () => ({ attachmentId: fixtureAttachment, byteSize: bytes.length, sha256,
        contentBase64: bytes.toString("base64"), contentType: "application/octet-stream" }),
    },
  } as unknown as PluginContext;
  const input = { routeKey: "mission-command", method: "POST" as const, path: "", query: {}, headers: {},
    params: { companyId: mission.companyId, missionId: mission.missionId }, companyId: mission.companyId, body,
    actor: { actorType: "user" as const, actorId: mission.ownerUserId, userId: mission.ownerUserId } };
  const response = await handleMissionApi(input, ctx);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(aggregate.phase, "ready_for_review");
  assert.deepEqual(aggregate.commandReceipts.slice(0, -1), historical.commandReceipts);
  assert.deepEqual(aggregate.n6, historical.n6);
  assert.equal(aggregate.n2, undefined);
  assert.equal(aggregate.n1.contributions[0].authorRunId, historical.n1.contributions[0].authorRunId);
  assert.equal((await handleMissionApi(input, ctx)).status, 200);
  assert.equal(writes, 1, "Exact replay must not mutate again");
  const bundleRelative = `artifacts/m2-recovery-${candidateCommit}.bundle`;
  await writeFile(resolve(root, bundleRelative), bytes);
  const prepared = { proofClass: "offline-rehearsal-real-git-and-historical-native-readbacks", status: "prepared-not-applied",
    source: git("rev-parse", baseCommit), missionId: mission.missionId, historicalVersion: mission.version,
    bundle: { path: bundleRelative, sha256, bytes: bytes.length }, candidateCommit, previousCommit: mismatch.recordedBackendCommit,
    replacementCommit, inputs: files.map(path => ({ path, sha256: hash(inputs.get(path)!) })),
    result: { phase: aggregate.phase, gitChecks: aggregate.n1.candidate.checks, originalReceiptsPreserved: true,
      dependencyPreserved: true, originalRunsPreserved: true, replayWrites: writes },
    nativeMutation: false, databaseRestored: false, providerRuns: 0, accepted: false, published: false,
    commandTemplate: { ...body, attachmentId: "REPLACE_WITH_NATIVE_UPLOAD_ID", commandId: "GENERATE_ONCE_FOR_REAL_EFFECT" },
    next: "Restore disabled native backup, install reviewed recovery code, upload this bundle on the same B root, inspect current version, then explicitly apply the owner command. No provider or publication implied.",
  };
  await writeFile(resolve(root, "artifacts/m2-recovery-prepared.json"), JSON.stringify(prepared, null, 2) + "\n");
  for (const path of files) assert.equal(hash(await readFile(resolve(root, path))), hash(inputs.get(path)!));
  console.log(JSON.stringify({ status: prepared.status, candidateCommit, gitChecks: prepared.result.gitChecks.length,
    nativeMutation: false, providerRuns: 0, artifact: "artifacts/m2-recovery-prepared.json" }));
} finally { await rm(directory, { recursive: true, force: true }); }
