import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/functional/n2-native-dependency.test.ts"], testTimeout: 30000, hookTimeout: 30000, pool: "forks", maxWorkers: 1 } });
