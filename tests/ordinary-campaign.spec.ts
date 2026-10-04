import { expect, it } from "vitest";
// @ts-expect-error Qualification contracts are plain ESM.
import { ordinaryCampaignProfile, assertOrdinaryCampaignResult } from "../scripts/qualification/ordinary-campaign-contract.mjs";
import { ordinaryCampaignHandoff } from "./functional/ordinary-campaign.js";
import { ordinaryCampaignInstructions } from "./functional/ordinary-campaign-instructions.js";
const sha = "a".repeat(40);
const profile = { candidateSha: sha, repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/council-delivery-ui-m1", model: "gpt-5.6-sol", effort: "medium",
  nominalRuns: 7, maxRuns: 12, runUnits: 2_000_000, periodUnits: 24_000_000, providerAuthorized: false, githubPublicationAuthorized: false };
it.each(["prepare", "session"])("allows %s without provider authority or agent wake", mode => {
  expect(ordinaryCampaignProfile(profile, mode, sha)).toMatchObject({ mode, runtimeProfile: "ordinary-cli-v1", maxCorrections: 1, providerAuthorized: false });
});
it.each([{ candidateSha: "b".repeat(40) }, { maxRuns: 15 }, { periodUnits: 30_000_000 }, { providerAuthorized: true }, { githubPublicationAuthorized: true }])("refuses changed identity/envelope or execution authority %j", changes => {
  expect(() => ordinaryCampaignProfile({ ...profile, ...changes }, "session", sha)).toThrow();
});
it("does not expose an inert launch mode or treat incomplete cleanup as a preparation pass", () => {
  expect(() => ordinaryCampaignProfile(profile, "launch", sha)).toThrow();
  const evidence = { candidate: { commit: sha }, ordinaryCampaign: { profile: { mode: "session" } }, outcome: "ORDINARY CAMPAIGN PREPARATION OBSERVED", launcherCleanup: { ownedRuntimeRemoved: true } };
  expect(() => assertOrdinaryCampaignResult(0, evidence, { ...profile, mode: "session" })).not.toThrow();
  expect(() => assertOrdinaryCampaignResult(1, evidence, { ...profile, mode: "session" })).toThrow();
  evidence.launcherCleanup.ownedRuntimeRemoved = false;
  expect(() => assertOrdinaryCampaignResult(0, evidence, { ...profile, mode: "session" })).toThrow();
});
it("gives all seven actual roles an ordinary API contract and explicitly supersedes historical N1 child closure", () => {
  for (const role of ["lead", "backend", "frontend", "development", "quality", "reviewer", "publisher"]) {
    const text = ordinaryCampaignInstructions(role, profile); expect(text).toContain("X-Paperclip-Run-Id"); expect(text).not.toContain("undefined");
  }
  for (const role of ["backend", "frontend"]) expect(ordinaryCampaignInstructions(role, profile)).toContain("do NOT PATCH done");
});

it("requires current mission and plan revisions at execution rather than replaying the prepared plan UUID", () => {
  const c: any = { agents: { publisher: { id: "publisher" } }, operatingProfile: {}, planRevisionId: "initial-plan", n3Slots: [] };
  const payload = ordinaryCampaignHandoff(c, {}, profile);
  expect(payload.preparedPlanRevisionId).toBe("initial-plan");
  expect(payload.configureDelivery.body.planRevisionId).toBe("READ_CURRENT_PLAN_REVISION");
  expect(payload.configureDelivery.body.expectedVersion).toBe("READ_CURRENT_MISSION_VERSION");
});

it("prepares the separate M2 envelope without inheriting M1 execution authority", () => {
  const m2 = { ...profile, campaign: "m2-coordination-v1", nominalRuns: 16, maxRuns: 25, periodUnits: 50_000_000 };
  expect(ordinaryCampaignProfile(m2, "session", sha)).toMatchObject({ campaign: "m2-coordination-v1", providerAuthorized: false, maxRetries: 0 });
  expect(() => ordinaryCampaignProfile({ ...m2, periodUnits: 24_000_000 }, "session", sha)).toThrow();
  for (const role of ["pm", "pmSuccessor", "facilitator", "backend", "frontend", "lead"]) {
    const text = ordinaryCampaignInstructions(role, m2); expect(text).not.toContain("undefined"); expect(text).toContain("PAPERCLIP_API_KEY");
  }
  expect(ordinaryCampaignInstructions("backend", m2)).not.toContain("src/delivery-presentation.ts");
  expect(ordinaryCampaignInstructions("lead", m2)).toContain("n6Handoff");
});
