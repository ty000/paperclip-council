import { expect, it } from "vitest";
// @ts-expect-error Qualification contracts are plain ESM.
import { n45Profile, assertN45Result } from "../scripts/qualification/n45-contract.mjs";
// @ts-expect-error Qualification labels are plain ESM.
import { nativeLifecycleLabel } from "../scripts/qualification/native-lifecycle-label.mjs";
const sha = "a".repeat(40);
const profile = { candidateSha: sha, repository: "ty000/paperclip-council", baseRef: "main", headRef: "codex/council-delivery-example", model: "gpt-5.6-sol", effort: "medium", maxRuns: 15, runUnits: 2_000_000, periodUnits: 30_000_000 };
it("allows preparation without authorizing a single model run", () => {
  expect(n45Profile(profile, "prepare", sha)).toMatchObject({ mode: "prepare", maxCorrections: 1 });
  expect(() => n45Profile(profile, "launch", sha)).toThrow("authorization");
  expect(() => n45Profile({ ...profile, providerAuthorized: true }, "launch", sha)).toThrow("authorization");
});
it("requires exact candidate and the single explicit envelope", () => {
  expect(() => n45Profile(profile, "prepare", "b".repeat(40))).toThrow("candidateSha");
  expect(() => n45Profile({ ...profile, maxRuns: 9 }, "prepare", sha)).toThrow("15-run");
});
it("never turns complete JSON into a pass when the whole command failed", () => {
  const evidence = { candidate: { commit: sha }, n45: { mode: "prepare" }, outcome: "N45 PREPARATION OBSERVED", launcherCleanup: { ownedRuntimeRemoved: true } };
  expect(() => assertN45Result(1, evidence, "prepare", sha)).toThrow("exit0");
  expect(() => assertN45Result(0, evidence, "prepare", sha)).not.toThrow();
});
it.each([[{}, "N2"], [{ COUNCIL_N3_NATIVE_LIFECYCLE: "1" }, "N3"], [{ COUNCIL_N5_NATIVE_LIFECYCLE: "1" }, "N5"], [{ COUNCIL_N5_CONTINUATION: "1", COUNCIL_N5_NATIVE_LIFECYCLE: "1" }, "N5 CONTINUATION"]])("uses the same exact lifecycle label for dispatch and assertion", (env, label) => {
  expect(nativeLifecycleLabel(env)).toBe(label);
});
