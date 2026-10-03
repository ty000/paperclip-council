import { expect, it, vi } from "vitest";
import { prepareN2Decision } from "../src/n2-missions.js";

it("refuses a second rejection before native effects or a new admission", async () => {
  const execute = vi.fn();
  const mission = { aggregate: { n2: { status: "reviewing", correctionsUsed: 1, correctionLimit: 1,
    activeSubmissionId: "v2", submissions: [{ submissionId: "v2", candidateCommit: "c".repeat(40) }],
    rounds: [{ round: 2, submissionId: "v2", reviewerAgentId: "reviewer", handoff: { reviewerRunId: "run2" } }],
    native: { profile: "paperclip_runner-experimental" },
  } } };
  await expect(prepareN2Decision({ db: { execute } } as never, mission as never, {
    verdict: "changes_requested", actorAgentId: "reviewer", runId: "run2", operationId: "op2",
    resultReference: "council:n2:submission:v2", justification: "Another correction requested",
  }, "10000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ code: "correction_limit_exceeded" });
  expect(execute).not.toHaveBeenCalled();
});
