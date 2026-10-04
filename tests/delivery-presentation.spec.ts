import { describe, expect, it } from "vitest";
import { projectDeliveryPresentation } from "../src/delivery-presentation.js";

const candidate = "a".repeat(40);
const otherHead = "b".repeat(40);

function readyInspection(): any {
  return {
    plan: { documentId: "plan-document", revisionId: "plan-revision" },
    authority: { publisherAgentId: "publisher" },
    publication: {
      state: "opened",
      submission: { candidateCommit: candidate },
      observation: { url: "https://github.com/example/repo/pull/7", headSha: candidate, state: "open", draft: false, matchesCandidate: true },
      checks: { headSha: candidate, state: "passed" },
      reviews: { headSha: candidate, state: "approved" },
    },
    ready: true,
    nativeReadbackFresh: true,
    nextActor: "publisher",
    nextAction: "PR handoff observed; merge is separate",
  };
}

describe("projectDeliveryPresentation", () => {
  it.each([null, undefined])("is total when N5 inspection is %s", value => {
    expect(projectDeliveryPresentation(value)).toMatchObject({
      status: { key: "configuration_missing", tone: "neutral" },
      waitingReason: expect.any(String),
      nextAction: { actorId: null },
      references: { plan: null, pullRequest: null },
      details: { acceptedCandidateCommit: null, observedHeadSha: null, checksState: null, reviewsState: null, nativeReadbackFresh: false },
    });
  });

  it("requires both the bound plan and publication authority", () => {
    const input = readyInspection();
    delete input.authority;
    expect(projectDeliveryPresentation(input).status.key).toBe("configuration_missing");
    input.authority = { publisherAgentId: "publisher" };
    delete input.plan.revisionId;
    expect(projectDeliveryPresentation(input).status.key).toBe("configuration_missing");
  });

  it("projects admitted publication lifecycle without inferring an effect", () => {
    const input = readyInspection();
    delete input.publication;
    expect(projectDeliveryPresentation(input).status.key).toBe("publication_not_admitted");
    input.publication = readyInspection().publication;
    input.publication.state = "pending";
    expect(projectDeliveryPresentation(input).status.key).toBe("publication_pending");
    input.publication.state = "unknown";
    expect(projectDeliveryPresentation(input)).toMatchObject({
      status: { key: "publication_unknown", tone: "attention" },
      waitingReason: expect.stringContaining("without repeating"),
    });
    input.publication.state = "opened";
    delete input.publication.observation;
    expect(projectDeliveryPresentation(input).status.key).toBe("observation_missing");
  });

  it("keeps historical references while rejecting a divergent observed head", () => {
    const input = readyInspection();
    input.publication.observation.headSha = otherHead;
    input.publication.observation.matchesCandidate = false;
    const result = projectDeliveryPresentation(input);
    expect(result).toMatchObject({
      status: { key: "candidate_mismatch", tone: "danger" },
      references: {
        plan: { documentId: "plan-document", revisionId: "plan-revision" },
        pullRequest: { url: "https://github.com/example/repo/pull/7", state: "open" },
      },
      details: { acceptedCandidateCommit: candidate, observedHeadSha: otherHead },
    });
  });

  it("applies PR state and native freshness before check and review state", () => {
    const input = readyInspection();
    input.publication.observation.state = "closed";
    input.publication.observation.draft = true;
    input.nativeReadbackFresh = false;
    input.publication.checks.state = "failed";
    input.publication.reviews.state = "changes_requested";
    expect(projectDeliveryPresentation(input)).toMatchObject({
      status: { key: "pull_request_not_open" },
      references: {
        pullRequest: { url: "https://github.com/example/repo/pull/7", state: "closed" },
      },
    });
    input.publication.observation.state = "open";
    expect(projectDeliveryPresentation(input).status.key).toBe("pull_request_draft");
    expect(projectDeliveryPresentation(input).references.pullRequest?.state).toBe("draft");
    input.publication.observation.draft = false;
    expect(projectDeliveryPresentation(input).status.key).toBe("readback_stale");
  });

  it.each([
    [null, "checks_waiting"],
    ["unknown", "checks_waiting"],
    ["pending", "checks_waiting"],
    ["failed", "checks_failed"],
  ])("presents checks state %s as %s", (state, expected) => {
    const input = readyInspection();
    if (state === null) delete input.publication.checks;
    else input.publication.checks.state = state;
    expect(projectDeliveryPresentation(input).status.key).toBe(expected);
  });

  it("requires passed checks to be attributed to the observed head", () => {
    const input = readyInspection();
    input.publication.checks.headSha = otherHead;
    expect(projectDeliveryPresentation(input).status.key).toBe("checks_head_mismatch");
  });

  it.each([
    [null, "reviews_waiting"],
    ["unknown", "reviews_waiting"],
    ["pending", "reviews_waiting"],
    ["changes_requested", "reviews_changes_requested"],
  ])("presents review state %s as %s", (state, expected) => {
    const input = readyInspection();
    if (state === null) delete input.publication.reviews;
    else input.publication.reviews.state = state;
    expect(projectDeliveryPresentation(input).status.key).toBe(expected);
  });

  it("requires an approving review to be attributed to the observed head", () => {
    const input = readyInspection();
    input.publication.reviews.headSha = otherHead;
    expect(projectDeliveryPresentation(input).status.key).toBe("reviews_head_mismatch");
  });

  it("never upgrades aligned visible evidence when backend readiness is not explicitly true", () => {
    const input = readyInspection();
    input.ready = false;
    const result = projectDeliveryPresentation(input);
    expect(result.status.key).toBe("acceptance_not_current");
    expect(result.references.pullRequest?.state).toBe("open");
  });

  it("projects ready only from explicit backend readiness and preserves backend action authority", () => {
    const result = projectDeliveryPresentation(readyInspection());
    expect(result).toEqual({
      status: { key: "ready", label: "Ready for handoff", tone: "success" },
      waitingReason: null,
      nextAction: { actorId: "publisher", label: "PR handoff observed; merge is separate" },
      references: {
        plan: { documentId: "plan-document", revisionId: "plan-revision" },
        pullRequest: { url: "https://github.com/example/repo/pull/7", state: "ready" },
      },
      details: {
        acceptedCandidateCommit: candidate,
        observedHeadSha: candidate,
        checksState: "passed",
        reviewsState: "approved",
        nativeReadbackFresh: true,
      },
    });
  });

  it("preserves a backend next actor and action even in a higher-priority waiting state", () => {
    const input = readyInspection();
    input.publication.state = "unknown";
    input.nextActor = "mission-owner";
    input.nextAction = "Inspect the uncertain one-shot effect";
    expect(projectDeliveryPresentation(input).nextAction).toEqual({ actorId: "mission-owner", label: "Inspect the uncertain one-shot effect" });
  });
});
