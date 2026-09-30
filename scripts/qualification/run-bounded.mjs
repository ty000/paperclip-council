import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { materializeHost, repositoryRoot } from "./paperclip-host.mjs";

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

const candidateCommit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") {
  throw new Error("Bounded qualification requires a clean committed candidate");
}

const host = await materializeHost({ source: process.env.PAPERCLIP_QUALIFICATION_SOURCE });

execFileSync("corepack", ["pnpm", "test:functional"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    COUNCIL_PACKAGE_EXPECTED_COMMIT: candidateCommit,
    PAPERCLIP_TEST_HOST_ROOT: host.target,
    COUNCIL_PACKAGE_EVIDENCE_PATH: process.env.COUNCIL_PACKAGE_EVIDENCE_PATH
      ?? resolve(repositoryRoot, "artifacts/functional.json"),
  },
});
