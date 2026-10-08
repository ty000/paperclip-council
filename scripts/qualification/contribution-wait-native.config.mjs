import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
if (!host || !process.env.COUNCIL_CONTRIBUTION_WAIT_RUNTIME) {
  throw new Error("Use run-contribution-wait-native.mjs with an explicit read-only Paperclip host");
}

export default defineConfig({
  cacheDir: resolve(process.env.COUNCIL_CONTRIBUTION_WAIT_RUNTIME, "vite-cache"),
  resolve: { alias: [
    { find: /^@council-wait-host\//, replacement: `${resolve(host)}/` },
    { find: /^@paperclipai\/paperclip-runner$/, replacement: resolve(host, "packages/paperclip-runner/src/index.ts") },
  ] },
  test: {
    include: ["tests/functional/contribution-wait-native.test.ts"],
    environment: "node", pool: "forks", maxWorkers: 1,
    testTimeout: 30_000, hookTimeout: 60_000, teardownTimeout: 30_000,
    cache: false,
  },
});
