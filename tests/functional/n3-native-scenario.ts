import { continuationMode } from "./n5-continuation-scenario.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/** Exercises installed command/auth boundaries; only the model supplies deterministic content. */
export async function prepareN3Scenario(input: any, prepared: any) {
  const { request, agentTokens } = input;
  const specialists: any[] = [];
  for (const perspective of ["product", "quality"]) {
    const actor = `n3-${perspective}`;
    const created = await request("human", "POST", `/api/companies/${prepared.companyId}/agents`, {
      name: `N3 ${perspective}`, role: "engineer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex", model: "deterministic-test" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false, maxConcurrentRuns: 1 } }, budgetMonthlyCents: 0,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const key = await request("human", "POST", `/api/agents/${created.body.id}/keys`, { name: actor, scope: { kind: "standard" } });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    agentTokens.set(actor, { id: created.body.id, agentId: created.body.id, companyId: prepared.companyId, token: key.body.token, runId: "" });
    specialists.push({ ...created.body, actor, perspective, slotId: randomUUID() });
  }
  const slots = specialists.map(agent => ({ slotId: agent.slotId, perspective: agent.perspective, specialistAgentId: agent.id,
    required: true, question: agent.perspective === "product" ? "Does the candidate meet the bounded user outcome?" : "Does alpha.txt contain the required independent correction marker?" }));
  const guards: any[] = [];
  const route = (issueId: string) => `/api/plugins/${input.pluginId}/api/issues/${issueId}/council/commands`;
  return {
    agents: specialists, slots, guards,
    async specialist(execution: any) {
      const agent = specialists.find(agent => agent.id === execution.binding.agentId);
      if (!agent) return false;
      const runId = execution.binding.runId;
      agentTokens.set(agent.actor, { ...agentTokens.get(agent.actor), runId });
      const call = (body: any) => request(agent.actor, "POST", route(execution.binding.issueId), { missionId: prepared.missionId, ...body });
      const inspected = await call({ command: "n3-inspect" });
      assert.equal(inspected.status, 200, JSON.stringify(inspected.body));
      const n3 = inspected.body.n3;
      const prior = n3.review.subject.submissionId !== (await request("human", "GET", `${prepared.missionPath}?companyId=${prepared.companyId}`)).body.mission.aggregate.n2.submissions[0].submissionId;
      const finding = { findingId: randomUUID(), classification: "blocking_defect", criterionOrRisk: "alpha.txt correction marker",
        evidenceRefs: [`git:${n3.review.subject.candidateCommit}:alpha.txt`], evidenceLimits: ["deterministic model content; provider quality not qualified"],
        consequence: "The required corrected candidate is absent", recommendedAction: "Correct alpha.txt once" };
      const opinion = { subject: n3.review.subject, slotId: agent.slotId, opinionId: randomUUID(),
        outcome: agent.perspective === "quality" && !prior && !continuationMode ? "changes_requested" : "support",
        rationale: agent.perspective === "product" ? "The bounded integrated product outcome is present" : prior ? "V2 includes the correction marker" : "V1 lacks the requested correction marker",
        findings: agent.perspective === "quality" && !prior && !continuationMode ? [finding] : [], unresolvedQuestions: [] };
      const stale = await call({ command: "n3-opinion", commandId: randomUUID(), expectedVersion: inspected.body.version,
        opinion: { ...opinion, subject: { ...opinion.subject, evidenceRevision: opinion.subject.evidenceRevision + 1 } } });
      assert.equal(stale.status, 409, JSON.stringify(stale.body));
      assert.equal(stale.body.code, "stale_n3_subject");
      const conflict = await call({ command: "n3-opinion", commandId: randomUUID(), expectedVersion: inspected.body.version,
        opinion: { ...opinion, slotId: specialists.find(other => other.id !== agent.id)!.slotId } });
      assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
      assert.equal(conflict.body.code, "reviewer_conflict");
      const invalidOutcome = await call({ command: "n3-opinion", commandId: randomUUID(), expectedVersion: inspected.body.version,
        opinion: { ...opinion, outcome: "typo_changes_requested", findings: [finding] } });
      assert.equal(invalidOutcome.status, 409, JSON.stringify(invalidOutcome.body));
      assert.equal(invalidOutcome.body.code, "invalid_n3_outcome");
      const unchanged = await call({ command: "n3-inspect" });
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
      assert.equal(unchanged.body.version, inspected.body.version);
      assert.deepEqual(unchanged.body.n3.review, n3.review);
      const recorded = await call({ command: "n3-opinion", commandId: randomUUID(), expectedVersion: inspected.body.version, opinion });
      assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
      guards.push({ runId, subject: opinion.subject, stale: stale.body.code, conflict: conflict.body.code,
        invalidOutcome: invalidOutcome.body.code, rejectedOutcomeUnchangedVersion: unchanged.body.version, missingBefore: n3.missing, opinion: recorded.body.mission.aggregate.n3.rounds.at(-1).review.opinions.at(-1) });
      return true;
    },
    async synthesize(call: any, inspection: any, actor: string, decisionBody: any) {
      const endpoint = `/api/plugins/${input.pluginId}/api/issues/${prepared.rootIssueId}/decision`;
      const blocked = await request(actor, "POST", endpoint, decisionBody);
      assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
      assert.equal(blocked.body.code, "n3_synthesis_required");
      const review = inspection.n3.review;
      assert.equal(inspection.n3.missing.length, 0);
      assert.equal(inspection.n3.usageUnknown.length, 0);
      const synthesis = { subject: review.subject, verdict: decisionBody.verdict, rationale: "Independent final reviewer preserves the distinct views and resolves every material objection",
        dispositions: review.opinions.flatMap((opinion: any) => opinion.findings.filter((finding: any) => finding.classification !== "deferrable_improvement")
          .map((finding: any) => ({ findingId: finding.findingId, disposition: "upheld_with_correction", reason: "One bounded alpha.txt correction is necessary", evidenceRefs: finding.evidenceRefs }))) };
      const invalidVerdict = await request(actor, "POST", route(prepared.rootIssueId), { missionId: prepared.missionId,
        command: "n3-synthesize", commandId: randomUUID(), expectedVersion: inspection.version,
        synthesis: { ...synthesis, verdict: "typo_approved" } });
      assert.equal(invalidVerdict.status, 409, JSON.stringify(invalidVerdict.body));
      assert.equal(invalidVerdict.body.code, "invalid_n3_verdict");
      const unchanged = await call({ command: "inspect" });
      assert.equal(unchanged.version, inspection.version);
      assert.deepEqual(unchanged.n3.review, review);
      await call({ command: "n3-synthesize", commandId: randomUUID(), expectedVersion: inspection.version, synthesis });
      guards.push({ subject: review.subject, missingSynthesis: blocked.body.code, invalidVerdict: invalidVerdict.body.code, rejectedVerdictUnchangedVersion: unchanged.version, synthesis });
    },
  };
}
