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
it("qualifies the four-run Council native lifecycle through the installed plugin", async () => {
  await import("./run.js");
  const proof = JSON.parse(await readFile(process.env.COUNCIL_PACKAGE_EVIDENCE_PATH!, "utf8"));
  expect(proof.outcome, JSON.stringify(proof.error)).toBe("N2 NATIVE LIFECYCLE WITH DETERMINISTIC MODEL VALIDATED");
}, 600000);
