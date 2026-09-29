import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface PreparedCandidate {
  packageRoot: string;
  sourceArchiveSha256: string;
  distSha256: string;
}

export function digestDirectory(root: string): string {
  const hash = createHash("sha256");

  function visit(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      const entry = relative(root, path).replaceAll("\\", "/");
      hash.update(`${entry}\0${stat.mode.toString(8)}\0`);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isSymbolicLink()) {
        hash.update(`link\0${readlinkSync(path)}\0`);
      } else {
        hash.update(readFileSync(path));
        hash.update("\0");
      }
    }
  }

  visit(root);
  return hash.digest("hex");
}

export async function exportCandidateSource(
  repositoryRoot: string,
  commit: string,
  destination: string,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  const archive = execFileSync("git", ["archive", "--format=tar", commit], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive });
  return createHash("sha256").update(archive).digest("hex");
}

export async function prepareCandidatePackage(
  repositoryRoot: string,
  commit: string,
  runtimeRoot: string,
): Promise<PreparedCandidate> {
  const packageRoot = resolve(runtimeRoot, "candidate");
  const storeRoot = resolve(runtimeRoot, "pnpm-store");
  const sourceArchiveSha256 = await exportCandidateSource(repositoryRoot, commit, packageRoot);

  execFileSync("pnpm", ["install", "--frozen-lockfile", "--store-dir", storeRoot], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  execFileSync("pnpm", ["build"], { cwd: packageRoot, stdio: "inherit" });

  return {
    packageRoot,
    sourceArchiveSha256,
    distSha256: digestDirectory(resolve(packageRoot, "dist")),
  };
}
