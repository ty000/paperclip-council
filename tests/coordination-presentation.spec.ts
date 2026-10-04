import { describe, expect, it } from "vitest";
import { projectCoordinationPresentation } from "../src/coordination-presentation.js";

const sourceMissionId = "source-mission";
const sourceRootIssueId = "source-root";
const coordinatorAgentId = "coordinator";
const ownerAgentId = "owner";

const expectedCandidate = {
  submissionId: "submission-v1",
  candidateCommit: "a".repeat(40),
  bundleSha256: "b".repeat(64),
  evidenceRevision: 18,
  mandateHash: "c".repeat(64),
};

function waitingInspection(): any {
  return {
    state: "waiting",
    blockage: "Source result has not been accepted and settled",
    sourceMissionId,
    sourceRootIssueId,
    expectedResult: expectedCandidate,
    coordination: {
      state: "held",
      coordinatorAgentId,
      priority: "high",
      reason: "Await the exact accepted predecessor result",
    },
    nextActor: coordinatorAgentId,
    nextAction: "Reconcile the accepted source result",
    publicationRequired: false,
  };
}

describe("projectCoordinationPresentation", () => {
  it.each([null, undefined])("keeps a missing inspection explicitly unknown for %s", inspection => {
    expect(projectCoordinationPresentation(inspection)).toEqual({
      status: { key: "inspection_missing", label: "Coordination unavailable", tone: "neutral" },
      waitingReason: null,
      source: {
        sourceMissionId: null,
        sourceRootIssueId: null,
        expectedCandidate: {
          submissionId: null,
          candidateCommit: null,
          bundleSha256: null,
          evidenceRevision: null,
          mandateHash: null,
        },
        verifiedCandidate: {
          submissionId: null,
          candidateCommit: null,
          bundleSha256: null,
          evidenceRevision: null,
          mandateHash: null,
        },
      },
      delegation: {
        state: null,
        coordinatorAgentId: null,
        priority: null,
        reason: null,
      },
      nextAction: {
        actorId: null,
        label: "Wait for the authorized actor to complete the displayed prerequisite.",
      },
      boundaries: {
        acceptedResult: "Exact accepted predecessor result required",
        settledUsage: "All referenced source usage must be settled and exposure-free",
        publicationRequired: null,
      },
    });
  });

  it("projects a held wait without treating the expected candidate as verified", () => {
    const result = projectCoordinationPresentation(waitingInspection());

    expect(result).toMatchObject({
      status: { key: "held", label: "Coordination held", tone: "attention" },
      waitingReason: "Source result has not been accepted and settled",
      source: {
        sourceMissionId,
        sourceRootIssueId,
        expectedCandidate,
      },
      delegation: {
        state: "held",
        coordinatorAgentId,
        priority: "high",
      },
      nextAction: {
        actorId: coordinatorAgentId,
        label: "Reconcile the accepted source result",
      },
      boundaries: { publicationRequired: false },
    });
    expect(result.source.verifiedCandidate).toEqual({
      submissionId: null,
      candidateCommit: null,
      bundleSha256: null,
      evidenceRevision: null,
      mandateHash: null,
    });
  });

  it("preserves a reserved owner decision and assigns its explicit next actor", () => {
    const input = waitingInspection();
    input.blockage = null;
    input.coordination = {
      state: "owner_required",
      coordinatorAgentId,
      priority: "high",
      reason: "ACTUAL_RESERVED_OWNER_DECISION",
    };
    input.nextActor = ownerAgentId;
    input.nextAction = "Resolve the reserved priority decision";

    expect(projectCoordinationPresentation(input)).toMatchObject({
      status: { key: "owner_required", label: "Owner decision required", tone: "attention" },
      waitingReason: "ACTUAL_RESERVED_OWNER_DECISION",
      delegation: {
        state: "owner_required",
        coordinatorAgentId,
        priority: "high",
        reason: "ACTUAL_RESERVED_OWNER_DECISION",
      },
      nextAction: { actorId: ownerAgentId, label: "Resolve the reserved priority decision" },
    });
  });

  it("shows an accepted source change and keeps both candidate identities visible", () => {
    const input = waitingInspection();
    const changedCandidate = {
      ...expectedCandidate,
      submissionId: "submission-v2",
      candidateCommit: "d".repeat(40),
      evidenceRevision: 19,
    };
    input.blockage = "n6_result_mismatch";
    input.verifiedArtifact = { expectedResult: changedCandidate };
    input.nextActor = ownerAgentId;
    input.nextAction = "Rebind or reject the changed accepted source";

    expect(projectCoordinationPresentation(input)).toMatchObject({
      status: { key: "source_mismatch", label: "Accepted source changed", tone: "danger" },
      waitingReason: "n6_result_mismatch",
      source: {
        expectedCandidate,
        verifiedCandidate: changedCandidate,
      },
      nextAction: { actorId: ownerAgentId, label: "Rebind or reject the changed accepted source" },
    });
  });

  it("projects release while retaining source, coordinator, reason, and next actor", () => {
    const input = waitingInspection();
    input.state = "verified";
    input.blockage = null;
    input.verifiedArtifact = { expectedResult: expectedCandidate };
    input.coordination.state = "released";
    input.coordination.reason = "Exact accepted result and settled usage verified";
    input.nextActor = "integration-lead";
    input.nextAction = "Start the authorized downstream mission";

    expect(projectCoordinationPresentation(input)).toMatchObject({
      status: { key: "released", label: "Coordination released", tone: "neutral" },
      waitingReason: "Exact accepted result and settled usage verified",
      source: {
        sourceMissionId,
        sourceRootIssueId,
        expectedCandidate,
        verifiedCandidate: expectedCandidate,
      },
      delegation: {
        state: "released",
        coordinatorAgentId,
        reason: "Exact accepted result and settled usage verified",
      },
      nextAction: { actorId: "integration-lead", label: "Start the authorized downstream mission" },
    });
  });

  it("projects the started state without inventing publication or action authority", () => {
    const input = waitingInspection();
    input.state = "started";
    input.blockage = null;
    input.verifiedArtifact = { expectedResult: expectedCandidate };
    input.coordination.state = "released";
    input.coordination.reason = null;
    input.nextActor = null;
    input.nextAction = null;
    delete input.publicationRequired;

    expect(projectCoordinationPresentation(input)).toMatchObject({
      status: { key: "started", label: "Downstream mission started", tone: "success" },
      waitingReason: null,
      nextAction: { actorId: null, label: "Continue the admitted downstream mission." },
      boundaries: { publicationRequired: null },
    });
  });
});
