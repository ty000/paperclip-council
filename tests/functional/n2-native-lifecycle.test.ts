import { it, vi } from "vitest";
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
}, 600000);
