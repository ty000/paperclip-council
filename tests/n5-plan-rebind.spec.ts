import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { rebindN5Plan } from "../src/n5-continuation.js";
import { readN5Plan } from "../src/n5-native.js";
import { readNativeRun } from "../src/g4-native.js";
import { n2CommandCas } from "../src/n2-missions.js";
vi.mock("../src/n5-native.js", () => ({ readN5Plan: vi.fn() }));
vi.mock("../src/g4-native.js", () => ({ readNativeRun: vi.fn() }));
vi.mock("../src/n2-missions.js", () => ({ n2CommandCas: vi.fn(), nativeN2Profile: vi.fn(), reserveN2Run: vi.fn(), runtimeUuid: (id: string) => id }));
beforeEach(() => vi.clearAllMocks());
function setup() {
  const lead = randomUUID(); const runId = randomUUID(); const rootIssueId = randomUUID();
  const plan = { documentId: randomUUID(), revisionId: randomUUID(), bodyHash: "old", mandateHash: "same", plannerAgentId: lead,
    orchestratorAgentId: lead, integrationLeadAgentId: lead, qaAgentId: randomUUID() };
  const m: any = { rootIssueId, aggregate: { responsibilities: { integrationLeadAgentId: lead }, n2: { correction: { runId } },
    n5: { plan, authority: { publisherAgentId: randomUUID(), repository: "owner/repo", baseRef: "main", headRef: "delivery" } } } };
  const input: any = { params: { issueId: rootIssueId }, actor: { actorType: "agent", agentId: lead, runId } };
  const body = { planRevisionId: randomUUID(), reason: "Attach bounded correction evidence" };
  vi.mocked(readNativeRun).mockResolvedValue({ status: "running", startedAt: "now", finishedAt: null } as never);
  vi.mocked(readN5Plan).mockResolvedValue({ ...plan, revisionId: body.planRevisionId, bodyHash: "new" });
  return { m, input, body };
}
it.each(["actor", "run", "issue", "terminal", "mandate", "roles"])("rejects plan rebinding outside exact %s authority", async kind => {
  const { m, input, body } = setup();
  if (kind === "actor") input.actor.agentId = randomUUID();
  if (kind === "run") input.actor.runId = randomUUID();
  if (kind === "issue") input.params.issueId = randomUUID();
  if (kind === "terminal") vi.mocked(readNativeRun).mockResolvedValue({ status: "succeeded", startedAt: "then", finishedAt: "now" } as never);
  if (kind === "mandate") vi.mocked(readN5Plan).mockResolvedValue({ ...m.aggregate.n5.plan, mandateHash: "changed" });
  if (kind === "roles") vi.mocked(readN5Plan).mockResolvedValue({ ...m.aggregate.n5.plan, qaAgentId: randomUUID() });
  await expect(rebindN5Plan({} as never, m, input, body)).rejects.toThrow();
  expect(n2CommandCas).not.toHaveBeenCalled();
});
it("records the native revision history while preserving publisher and repository authority", async () => {
  const { m, input, body } = setup(); const before = structuredClone(m.aggregate.n5);
  await rebindN5Plan({} as never, m, input, body);
  const next = vi.mocked(n2CommandCas).mock.calls[0]![5];
  expect(next.n5!.authority).toEqual(before.authority); expect(next.n5!.plan.revisionId).toBe(body.planRevisionId);
  expect(next.n5!.planHistory![0]!.plan).toEqual(before.plan); expect(m.aggregate.n5).toEqual(before);
});
