import { describe, expect, it } from "vitest";
import { assertProviderFreeN2HandoffReady, preserveN2RunBeforeBusinessAssertion } from "./functional/n2-live.js";

describe("N2 live evidence preservation", () => {
  it("admits the provider-free handoff only after every fixture is terminal and lock-free", () => {
    const terminalRuns = ["lead", "alpha", "beta"].map((id) => ({
      id,
      status: "succeeded",
      finishedAt: "2026-10-02T00:00:00.000Z",
      wakeupRequestId: null,
      processStartedAt: null,
    }));
    expect(() => assertProviderFreeN2HandoffReady({
      providerFreePrerequisite: true,
      fixtureLifecycle: {
        activeRunCount: 0,
        openCheckoutCount: 0,
        openExecutionCount: 0,
        terminalRuns,
      },
    })).not.toThrow();
    expect(() => assertProviderFreeN2HandoffReady({
      providerFreePrerequisite: true,
      fixtureLifecycle: {
        activeRunCount: 1,
        openCheckoutCount: 1,
        openExecutionCount: 1,
        terminalRuns: [{ ...terminalRuns[0], status: "running", finishedAt: null }],
      },
    })).toThrow(/occupy an execution slot/);
  });

  it("keeps a terminal reviewer proof and attempts settlement before surfacing a missing verdict", async () => {
    const events: string[] = [];
    const evidence: Record<string, any> = { runs: [], settlements: [] };
    const run = { id: "review-run", status: "succeeded", usageJson: null };
    const businessError = new Error("expected correction_requested, observed review_handoff");

    await expect(preserveN2RunBeforeBusinessAssertion({
      evidence,
      run,
      label: "review-1",
      observe: async () => {
        events.push("observe");
        return { n2: { status: "review_handoff" } };
      },
      reconcile: async () => {
        events.push("settle");
        throw new Error("review usage binding missing");
      },
      readback: async () => {
        events.push("readback");
        return {
          mission: { n2: { status: "review_handoff" } },
          admission: {
            envelope: {
              reservations: [{
                reservationId: "review-reservation",
                status: "reserved",
                usage: { status: "unknown" },
                remainingExposure: { status: "known", units: 2_000_000 },
              }],
            },
          },
        };
      },
      validateBusiness: () => {
        events.push("validate");
        throw businessError;
      },
    })).rejects.toBe(businessError);
    events.push("cleanup");

    expect(events).toEqual(["observe", "validate", "settle", "readback", "cleanup"]);
    expect(evidence.runs).toEqual([run]);
    expect(evidence.settlements).toEqual([{
      label: "review-1",
      status: "failed",
      error: expect.objectContaining({ message: "review usage binding missing" }),
    }]);
    expect(evidence.businessError).toEqual(expect.objectContaining({ message: businessError.message }));
    expect(evidence.admission.envelope.reservations[0]).toMatchObject({
      status: "reserved",
      usage: { status: "unknown" },
      remainingExposure: { status: "known", units: 2_000_000 },
    });
  });
});
