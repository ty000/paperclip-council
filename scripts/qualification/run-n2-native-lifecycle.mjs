import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repositoryRoot } from "./paperclip-host.mjs";
import { withOwnedQualificationRuntime } from "./run-bounded.mjs";
import { runProcessGroup } from "./process-group.mjs";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const candidate = git(repositoryRoot, ["rev-parse", "HEAD"]);
if (git(repositoryRoot, ["status", "--porcelain"])) throw new Error("A clean committed Council candidate is required");
const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
const hostCommit = process.env.COUNCIL_N2_NATIVE_HOST_COMMIT;
if (!host || !/^[a-f0-9]{40}$/.test(hostCommit ?? "") || git(host, ["rev-parse", "HEAD"]) !== hostCommit
    || git(host, ["status", "--porcelain", "--untracked-files=no"])) {
  throw new Error("Explicit clean host path and exact COUNCIL_N2_NATIVE_HOST_COMMIT are required");
}
for (const name of ["COUNCIL_N1_LIVE_AUTHORIZED", "COUNCIL_N2_LIVE_AUTHORIZED", "COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED", "COUNCIL_N2_PREREQUISITE"]) {
  if (process.env[name] === "1") throw new Error("Deterministic native qualification excludes LIVE and prerequisite modes");
}
const continuation = process.env.COUNCIL_N5_CONTINUATION === "1";
const n5 = process.env.COUNCIL_N5_NATIVE_LIFECYCLE === "1";
const n3 = process.env.COUNCIL_N3_NATIVE_LIFECYCLE === "1";
const path = resolve(repositoryRoot, `artifacts/${continuation ? "n5-continuation" : n5 ? "n5" : n3 ? "n3" : "n2"}-native-lifecycle-${candidate}.json`);
mkdirSync(resolve(repositoryRoot, "artifacts"), { recursive: true });
writeFileSync(path, "{}\n", { flag: "wx" });
let runtimePath;
try {
  await withOwnedQualificationRuntime(async (runtime) => {
    runtimePath = runtime;
    await runProcessGroup("corepack", ["pnpm", "exec", "vitest", "run", "--config", "scripts/qualification/n2-native-lifecycle.config.mjs"], {
      cwd: repositoryRoot, timeoutMs: 15 * 60_000,
      env: { ...process.env, COUNCIL_N2_NATIVE_LIFECYCLE: "1", COUNCIL_PACKAGE_EXPECTED_COMMIT: candidate,
        PAPERCLIP_QUALIFICATION_RUNTIME: runtime, COUNCIL_PACKAGE_EVIDENCE_PATH: path },
    });
  });
} finally {
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  evidence.launcherCleanup = { runtimePath, ownedRuntimeRemoved: Boolean(runtimePath && !existsSync(runtimePath)) };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}
const evidence = JSON.parse(readFileSync(path, "utf8"));
if (evidence.outcome !== `${continuation ? "N5 CONTINUATION" : n5 ? "N5" : n3 ? "N3" : "N2"} NATIVE LIFECYCLE WITH DETERMINISTIC MODEL VALIDATED`
    || evidence.head !== hostCommit || evidence.candidate?.commit !== candidate
    || evidence.nativeLifecycle?.finalRuns?.length !== ((n3 ? 10 : 4) + (n5 ? continuation ? 2 : 1 : 0)) || evidence.nativeLifecycle?.costs?.length !== ((n3 ? 10 : 4) + (n5 ? continuation ? 2 : 1 : 0))
    || !evidence.launcherCleanup.ownedRuntimeRemoved) {
  throw new Error(`Native deterministic lifecycle did not qualify: ${path}`);
}
console.log(`Native deterministic lifecycle proof: ${path}`);
