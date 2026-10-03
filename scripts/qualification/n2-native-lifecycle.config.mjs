import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/functional/n2-native-lifecycle.test.ts"], testTimeout: 600000, hookTimeout: 30000, pool: "forks", maxWorkers: 1 } });
