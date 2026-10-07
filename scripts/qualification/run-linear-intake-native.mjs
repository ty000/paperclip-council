import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runProcessGroup } from "./process-group.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
assert(process.env.PAPERCLIP_TEST_HOST_ROOT, "Explicit prepared host path is required");
assert(process.env.LINEAR_INTAKE_TEST_REPOSITORY, "Explicit built intake responder checkout is required");
for (const flag of ["COUNCIL_N1_LIVE_AUTHORIZED", "COUNCIL_N2_LIVE_AUTHORIZED", "COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED"]) {
  assert.notEqual(process.env[flag], "1", "Isolated deterministic qualification excludes LIVE flags");
}
await runProcessGroup("corepack", ["pnpm", "exec", "tsx", "tests/functional/linear-intake-installed.ts"], {
  cwd: repository, timeoutMs: 15 * 60_000, env: { ...process.env },
});
