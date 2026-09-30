import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/persistence/*.integration.ts"], environment: "node" } });
