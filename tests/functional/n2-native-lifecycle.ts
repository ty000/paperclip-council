import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { prepareN2Prerequisite } from "./n2-prerequisite.js";
import { runLiveN2 } from "./n2-live.js";
import { nativeRunEvidence } from "./n1-live.js";

// Only model execution is deterministic. Admission, HTTP auth, plugin RPC,
// heartbeat finalization, cost accounting, event delivery and recovery are real.
export async function runN2NativeLifecycle(input: any) {
  const { request, hostImport, evidence, save, agentTokens, db, tables, eq } = input;
  const registry = await hostImport("server/src/adapters/registry.ts");
  await registry.waitForExternalAdapters();
  let prepared: Awaited<ReturnType<typeof prepareN2Prerequisite>>;
  const released = new Set<string>();
  const waiters = new Map<string, () => void>();
  const executions: any[] = [];
  const errors: string[] = [];
  const original = registry.getServerAdapter("codex_local");
  const modelReady = (runId: string) => {
    released.add(runId);
    waiters.get(runId)?.();
  };
  registry.registerServerAdapter({
    ...original,
    async execute(ctx: any) {
      const observation = { runId: ctx.runId, agentId: ctx.agent.id, issueId: ctx.context.issueId, usage: { inputTokens: 101, outputTokens: 23 } };
      executions.push(observation);
      try {
        assert(prepared, "model cannot execute before mission preparation");
        assert.equal(ctx.context.issueId, prepared.rootIssueId);
        assert(executions.length <= 3, "unexpected fourth model execution");
        // A rendezvous models provider duration until the operator has observed
        // dispatch and disabled further wakes. It does not alter host lifecycle.
        if (!released.has(ctx.runId)) await new Promise<void>((accept, reject) => {
          const timer = setTimeout(() => reject(new Error("model dispatch rendezvous timed out")), 15_000);
          waiters.set(ctx.runId, () => { clearTimeout(timer); accept(); });
        });
        const reviewer = ctx.agent.id === prepared.agents.reviewer.id;
        assert(reviewer || ctx.agent.id === prepared.agents.lead.id);
        const actor = reviewer ? "n2-prerequisite-reviewer" : "n2-prerequisite-lead";
        agentTokens.set(actor, { ...agentTokens.get(actor), runId: ctx.runId });
        const route = `/api/plugins/${input.pluginId}/api/issues/${prepared.rootIssueId}/council/commands`;
        const call = async (body: any) => {
          const response = await request(actor, "POST", route, { missionId: prepared.missionId, ...body });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          return response.body;
        };
        let inspection = await call({ command: "inspect" });
        if (reviewer) {
          await call({ command: "confirm-review-handoff", commandId: randomUUID(), expectedVersion: inspection.version });
          inspection = await call({ command: "inspect" });
          const submission = inspection.n2.submission;
          const approved = inspection.n2.review.round === 2;
          const content = execFileSync("git", ["show", `${submission.candidateCommit}:alpha.txt`], { cwd: prepared.repository, encoding: "utf8" });
          assert.equal(content, approved ? "alpha contribution corrected after independent review\n" : "alpha contribution\n");
          const result = await request(actor, "POST", `/api/plugins/${input.pluginId}/api/issues/${prepared.rootIssueId}/decision`, {
            operationId: randomUUID(), verdict: approved ? "approved" : "changes_requested",
            ...(approved ? { approvedCommit: submission.candidateCommit } : { correctionReservationId: randomUUID() }),
            resultReference: `council:n2:submission:${submission.submissionId}`,
            justification: approved ? "V2 contains the requested bounded correction" : "alpha.txt needs the independent correction marker",
          });
          assert.equal(result.status, 202, JSON.stringify(result.body));
        } else {
          assert.equal(inspection.n2.status, "correcting");
          const git = (args: string[]) => execFileSync("git", args, { cwd: prepared.repository, encoding: "utf8" }).trim();
          git(["switch", "contribution-beta"]);
          git(["switch", "-c", "deterministic-correction"]);
          git(["merge", "--no-ff", "--no-commit", "contribution-alpha"]);
          await writeFile(resolve(prepared.repository, "alpha.txt"), "alpha contribution corrected after independent review\n");
          git(["add", "alpha.txt"]);
          git(["commit", "-m", "Deterministic model: bounded N2 correction"]);
          const candidateCommit = git(["rev-parse", "HEAD"]);
          git(["branch", "-f", "candidate", candidateCommit]);
          const bundle = resolve(input.runtime, "deterministic-v2.bundle");
          git(["bundle", "create", bundle, "refs/heads/base", "refs/heads/candidate"]);
          const bytes = await readFile(bundle);
          const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
          const form = new FormData();
          form.append("file", new Blob([bytes]), "deterministic-v2.bundle");
          const identity = agentTokens.get(actor);
          const uploaded = await fetch(`${input.baseUrl}/api/companies/${prepared.companyId}/issues/${prepared.rootIssueId}/attachments`, {
            method: "POST", headers: { authorization: `Bearer ${identity.token}`, "x-paperclip-run-id": ctx.runId }, body: form,
          });
          const attachment = await uploaded.json() as any;
          assert.equal(uploaded.status, 201, JSON.stringify(attachment));
          assert.equal(attachment.sha256, expectedSha256);
          inspection = await call({ command: "inspect" });
          await call({ command: "prepare-resubmission", commandId: randomUUID(), expectedVersion: inspection.version,
            submissionId: randomUUID(), attachmentId: attachment.id, expectedSha256,
            baseCommit: prepared.baseCommit, candidateCommit, correctedPaths: ["alpha.txt"] });
        }
        return { exitCode: 0, signal: null, timedOut: false, usage: observation.usage, usageBasis: "per_run",
          provider: "deterministic-test", model: "n2-lifecycle-fixture", billingType: "api", costUsd: 0.001,
          summary: "Deterministic model completed its bounded Council action." };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  });
  evidence.configuration.models = "deterministic adapter execution only; no provider";
  evidence.nativeLifecycle = { executions, modelErrors: errors, simulatedUsage: true,
    rendezvous: "model completion waits for operator dispatch observation and wake disabling; fast-provider toggle race is not covered",
    fixtureBoundary: "N1 prerequisite only is seeded; N2 heartbeat, costs, recovery, API and plugin event delivery are native" };
  const listRuns = (agentId: string) => db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.agentId, agentId));
  const getRun = (runId: string) => db.select().from(tables.heartbeatRuns).where(eq(tables.heartbeatRuns.id, runId)).then((rows: any[]) => rows[0] ?? null);
  try {
    prepared = await prepareN2Prerequisite({ ...input,
      registerActor: (actor: string, identity: any) => agentTokens.set(actor, { ...identity, runId: "", agentId: identity.id }),
      liveN2Profile: { model: "deterministic-test", effort: "high", runReservationUnits: 2_000_000, periodAllowanceUnits: 6_000_000 },
    });
    evidence.nativeLifecycle.prerequisite = prepared;
    await save();
    const result = await runLiveN2({ request, getRun, listRuns, pluginId: input.pluginId, evidence,
      n1: prepared, runEvidence: nativeRunEvidence, persistEvidence: save, onRunCaptured: modelReady });
    const { heartbeatService } = await hostImport("server/src/services/heartbeat.ts");
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    const costs = await db.select().from(tables.costEvents).where(eq(tables.costEvents.companyId, prepared.companyId));
    const runs = [...await listRuns(prepared.agents.reviewer.id), ...await listRuns(prepared.agents.lead.id)]
      .filter((run: any) => !prepared.fixtureHeartbeatRuns.some((fixture: any) => fixture.runId === run.id));
    assert.equal(runs.length, 3);
    assert.equal(executions.length, 3);
    assert.equal(costs.length, 3);
    assert(runs.every((run: any) => run.status === "succeeded" && run.usageJson?.inputTokens === 101 && run.usageJson?.outputTokens === 23));
    evidence.nativeLifecycle.costs = costs;
    evidence.nativeLifecycle.finalRuns = runs.map(nativeRunEvidence);
    evidence.nativeLifecycle.accepted = result.finalMission;
    evidence.outcome = "N2 NATIVE LIFECYCLE WITH DETERMINISTIC MODEL VALIDATED";
  } finally {
    registry.registerServerAdapter(original);
    await save();
  }
}
