import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { candidateAttachmentTarget, submissionAttachmentIssue } from "../src/candidate-attachment.js";
import type { MissionRecord } from "../src/missions.js";

function mission(result?: "draft-pr" | "reviewed-pr" | "integrated-verified") {
  const rootIssueId = randomUUID();
  const integrationIssueId = randomUUID();
  return {
    rootIssueId,
    aggregate: {
      ...(result ? { projectMandate: { completion: { protocol: "council-proof-close-v1", result } } } : {}),
      n1: { integration: { issueId: integrationIssueId } },
      n2: { ordinary: { tasks: [] } },
    },
  } as unknown as MissionRecord;
}

it.each(["draft-pr", "reviewed-pr", "integrated-verified"] as const)(
  "pins a %s candidate to its admitted integration task while retaining the product subject",
  result => {
    const m = mission(result);
    const integrationIssueId = (m.aggregate.n1!.integration as { issueId: string }).issueId;
    expect(candidateAttachmentTarget(m, integrationIssueId)).toBe(integrationIssueId);
    expect(submissionAttachmentIssue(m, { attachmentIssueId: integrationIssueId })).toBe(integrationIssueId);
  },
);

it("retains the historical root attachment fallback and refuses another task", () => {
  const m = mission();
  expect(candidateAttachmentTarget(m, randomUUID())).toBeUndefined();
  expect(submissionAttachmentIssue(m, {})).toBe(m.rootIssueId);
  expect(() => submissionAttachmentIssue(m, { attachmentIssueId: randomUUID() })).toThrow(/exact admitted candidate actor/);
});
