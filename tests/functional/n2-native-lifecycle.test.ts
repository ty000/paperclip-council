import { nativeLifecycleLabel } from "../../scripts/qualification/native-lifecycle-label.mjs";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
vi.mock("../../.paperclip/qualification/paperclip/server/src/services/heartbeat.ts", async original => {
  const real: any = await original();
  const { nativeModel } = await import("./n2-native-model.js");
  return { ...real, heartbeatService: (db: any, options: any = {}) => real.heartbeatService(db, {
    ...options, nativeSessionBackendFactory: options.nativeSessionBackendFactory ?? ((execution: any) => {
      if (!nativeModel.factory) throw new Error("Native deterministic model not configured");
      return nativeModel.factory(execution);
    }),
  }) };
});
vi.mock("../../.paperclip/qualification/paperclip/server/src/services/github-external-object-provider.ts", async original => {
  const real: any = await original();
  const { fakeN5GitHub } = await import("./n5-native-scenario.js");
  return { ...real, createGitHubExternalObjectProvider: (db: any, options: any = {}) => real.createGitHubExternalObjectProvider(db,
    process.env.COUNCIL_N5_NATIVE_LIFECYCLE === "1" ? { ...options, fetch: (url: string) => fakeN5GitHub.fetch(url), tokenProvider: () => null } : options) };
});
it("qualifies the four-run Council native lifecycle through the installed plugin", async () => {
  await import("./run.js");
  const proof = JSON.parse(await readFile(process.env.COUNCIL_PACKAGE_EVIDENCE_PATH!, "utf8"));
  expect(proof.outcome, JSON.stringify(proof.error)).toBe(`${nativeLifecycleLabel()} NATIVE LIFECYCLE WITH DETERMINISTIC MODEL VALIDATED`);
}, 600000);
