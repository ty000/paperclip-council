import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  N3_SPECIALIST_PERSPECTIVES,
  N3OpinionError,
  recordN3Opinion,
  startN3ReviewRound,
  synthesizeN3Review,
  type N3CandidateSubject,
  type N3Finding,
  type N3OpinionSlot,
} from "../src/n3-opinions.js";

const ids = {
  author: randomUUID(),
  finalReviewer: randomUUID(),
  product: randomUUID(),
  security: randomUUID(),
  productSlot: randomUUID(),
  securitySlot: randomUUID(),
};

function subject(candidateCommit = "c".repeat(40), evidenceRevision = 12): N3CandidateSubject {
  return {
    submissionId: randomUUID(),
    candidateCommit,
    bundleSha256: "d".repeat(64),
    evidenceRevision,
    mandateHash: "e".repeat(64),
  };
}

function slots(): N3OpinionSlot[] {
  return [
    {
      slotId: ids.productSlot,
      perspective: "product",
      specialistAgentId: ids.product,
      question: "Does the correction preserve the stated user outcome?",
      required: true,
    },
    {
      slotId: ids.securitySlot,
      perspective: "security",
      specialistAgentId: ids.security,
      question: "Does the corrected authorization boundary prevent cross-project access?",
      required: true,
    },
  ];
}

function finding(findingId = randomUUID()): N3Finding {
  return {
    findingId,
    classification: "blocking_defect",
    criterionOrRisk: "Project isolation",
    evidenceRefs: ["test:project-isolation"],
    evidenceLimits: ["Package test only; native runtime remains unqualified"],
    consequence: "A mismatched project could read the candidate metadata",
    recommendedAction: "Enforce the project binding before native qualification",
  };
}

function round(target = subject()) {
  return startN3ReviewRound({
    subject: target,
    authorAgentIds: [ids.author],
    finalReviewerAgentId: ids.finalReviewer,
    slots: slots(),
  });
}

function expectN3Code(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(N3OpinionError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected N3 error ${code}`);
}

function addProductOpinion(state: ReturnType<typeof round>) {
  return recordN3Opinion(state, {
    subject: state.subject,
    slotId: ids.productSlot,
    authenticatedAgentId: ids.product,
    authenticatedRunId: randomUUID(),
    opinionId: randomUUID(),
    outcome: "support",
    rationale: "The corrected flow preserves the selected user outcome.",
    findings: [],
    unresolvedQuestions: [],
  });
}

describe("N3 attributed specialist opinions", () => {
  it("supports all seven prepared specialties without requiring all seven in a mission", () => {
    const allSlots = N3_SPECIALIST_PERSPECTIVES.map((perspective) => ({
      slotId: randomUUID(),
      perspective,
      specialistAgentId: randomUUID(),
      question: `Answer the bounded ${perspective} question`,
      required: perspective === "product" || perspective === "quality",
    }));
    const state = startN3ReviewRound({
      subject: subject(),
      authorAgentIds: [ids.author],
      finalReviewerAgentId: ids.finalReviewer,
      slots: allSlots,
    });
    expect(state.slots).toHaveLength(7);
    expect(round().slots).toHaveLength(2);
  });

  it("rejects an author acting as an independent specialist or final reviewer", () => {
    expect(() => startN3ReviewRound({
      subject: subject(), authorAgentIds: [ids.author], finalReviewerAgentId: ids.author, slots: slots(),
    })).toThrowError(N3OpinionError);
    const conflicted = slots();
    conflicted[0] = { ...conflicted[0], specialistAgentId: ids.author };
    expect(() => startN3ReviewRound({
      subject: subject(), authorAgentIds: [ids.author], finalReviewerAgentId: ids.finalReviewer, slots: conflicted,
    })).toThrowError(/author cannot supply/);
  });

  it("does not treat a missing required opinion as agreement", () => {
    const state = addProductOpinion(round());
    expect(state.status).toBe("collecting_opinions");
    expectN3Code(() => synthesizeN3Review(state, {
      subject: state.subject,
      authenticatedAgentId: ids.finalReviewer,
      authenticatedRunId: randomUUID(),
      verdict: "approved",
      rationale: "One favorable opinion is insufficient.",
      dispositions: [],
    }), "required_opinion_missing");
  });

  it("rejects an opinion copied from an older candidate", () => {
    const current = round(subject("f".repeat(40), 13));
    const old = subject("a".repeat(40), 12);
    expectN3Code(() => recordN3Opinion(current, {
      subject: old,
      slotId: ids.productSlot,
      authenticatedAgentId: ids.product,
      authenticatedRunId: randomUUID(),
      opinionId: randomUUID(),
      outcome: "support",
      rationale: "This opinion targets the old candidate.",
      findings: [],
      unresolvedQuestions: [],
    }), "stale_n3_subject");
  });

  it("records two attributed perspectives and requires disposition of every material objection", () => {
    const product = addProductOpinion(round());
    const objection = finding();
    const collected = recordN3Opinion(product, {
      subject: product.subject,
      slotId: ids.securitySlot,
      authenticatedAgentId: ids.security,
      authenticatedRunId: randomUUID(),
      opinionId: randomUUID(),
      outcome: "changes_requested",
      rationale: "The evidence exposes a candidate-bound authorization defect.",
      findings: [objection],
      unresolvedQuestions: [],
    });
    expect(collected.status).toBe("ready_for_synthesis");
    expect(collected.opinions.map((opinion) => opinion.perspective)).toEqual(["product", "security"]);
    expectN3Code(() => synthesizeN3Review(collected, {
      subject: collected.subject,
      authenticatedAgentId: ids.finalReviewer,
      authenticatedRunId: randomUUID(),
      verdict: "approved",
      rationale: "Approval cannot omit the security objection.",
      dispositions: [],
    }), "material_objection_undisposed");

    const synthesized = synthesizeN3Review(collected, {
      subject: collected.subject,
      authenticatedAgentId: ids.finalReviewer,
      authenticatedRunId: randomUUID(),
      verdict: "changes_requested",
      rationale: "The product outcome is preserved, but the security correction is required.",
      dispositions: [{
        findingId: objection.findingId,
        disposition: "upheld_with_correction",
        reason: "The evidence demonstrates a mandate-relevant cross-project risk.",
        evidenceRefs: ["test:project-isolation"],
      }],
    });
    expect(synthesized.synthesis).toMatchObject({
      finalReviewerAgentId: ids.finalReviewer,
      verdict: "changes_requested",
      dispositions: [{ findingId: objection.findingId, disposition: "upheld_with_correction" }],
    });
  });
});
