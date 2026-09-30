import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "../..");
export const runtimeRoot = resolve(repositoryRoot, ".paperclip/qualification");
export const defaultHostRoot = resolve(runtimeRoot, "paperclip");
const configuration = JSON.parse(readFileSync(resolve(repositoryRoot, "qualification/environments.json"), "utf8"));

export const expectedPaperclipCommit = configuration.paperclip.commit;
export const defaultPaperclipSource = configuration.paperclip.repository;
const lockfileRepair = configuration.paperclip.lockfileRepair;
const ownershipMarkerName = ".paperclip-council-owned.json";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  })?.trim();
}

function git(root, args) {
  return run("git", ["-C", root, ...args], { capture: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prepareDependencies(hostRoot) {
  const lockfilePath = resolve(hostRoot, "pnpm-lock.yaml");
  const originalLockfile = readFileSync(lockfilePath);
  if (sha256(originalLockfile) !== lockfileRepair.originalSha256) {
    throw new Error("Pinned Paperclip lockfile does not match the approved repair source hash");
  }
  const corepackHome = resolve(runtimeRoot, "corepack");
  const storeDirectory = resolve(runtimeRoot, "pnpm-store");
  const environment = { ...process.env, COREPACK_HOME: corepackHome };
  try {
    run("corepack", ["pnpm", "install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile", "--store-dir", storeDirectory], {
      cwd: hostRoot,
      env: environment,
    });
    const repairedLockfile = readFileSync(lockfilePath);
    const repairDiff = git(hostRoot, ["diff", "--binary", "--", "pnpm-lock.yaml"]);
    if (sha256(repairedLockfile) !== lockfileRepair.repairedSha256 || sha256(`${repairDiff}\n`) !== lockfileRepair.diffSha256) {
      throw new Error("Paperclip lockfile repair differs from the approved bounded metadata delta");
    }
    run("corepack", ["pnpm", "install", "--frozen-lockfile", "--store-dir", storeDirectory], {
      cwd: hostRoot,
      env: environment,
    });
  } finally {
    writeFileSync(lockfilePath, originalLockfile);
  }
  if (git(hostRoot, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
    throw new Error("Paperclip host tracked files changed during dependency preparation");
  }
  return {
    mode: "validated-lock-metadata-repair",
    originalSha256: lockfileRepair.originalSha256,
    repairedSha256: lockfileRepair.repairedSha256,
    diffSha256: lockfileRepair.diffSha256,
  };
}

export function assertOwnedTarget(target, allowedRoot = runtimeRoot) {
  const absoluteTarget = resolve(target);
  const absoluteRoot = resolve(allowedRoot);
  const pathFromRoot = relative(absoluteRoot, absoluteTarget);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Qualification host target must be a child of ${absoluteRoot}`);
  }
  return absoluteTarget;
}

export function inspectHost(target, expectedCommit = expectedPaperclipCommit, allowedRoot = runtimeRoot) {
  const absoluteTarget = assertOwnedTarget(target, allowedRoot);
  if (!existsSync(resolve(absoluteTarget, ".git"))) {
    return { prepared: false, target: absoluteTarget, expectedCommit };
  }
  const head = git(absoluteTarget, ["rev-parse", "HEAD"]);
  const trackedStatus = git(absoluteTarget, ["status", "--porcelain", "--untracked-files=no"]);
  const markerPath = resolve(absoluteTarget, ownershipMarkerName);
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null;
  const dependencyPreparation = marker?.dependencyPreparation ?? null;
  const dependencyPreparationValid = dependencyPreparation?.mode === "validated-lock-metadata-repair"
    && dependencyPreparation.originalSha256 === lockfileRepair.originalSha256
    && dependencyPreparation.repairedSha256 === lockfileRepair.repairedSha256
    && dependencyPreparation.diffSha256 === lockfileRepair.diffSha256;
  return {
    prepared: head === expectedCommit && trackedStatus === "" && marker?.expectedCommit === expectedCommit,
    target: absoluteTarget,
    expectedCommit,
    head,
    trackedClean: trackedStatus === "",
    owned: marker?.environmentClass === "local-sandbox",
    dependencyPreparation,
    dependenciesInstalled: dependencyPreparationValid && existsSync(resolve(absoluteTarget, "node_modules")),
  };
}

export async function materializeHost({
  source = defaultPaperclipSource,
  target = defaultHostRoot,
  expectedCommit = expectedPaperclipCommit,
  install = true,
  allowedRoot = runtimeRoot,
} = {}) {
  const absoluteTarget = assertOwnedTarget(target, allowedRoot);
  if (existsSync(absoluteTarget)) {
    const current = inspectHost(absoluteTarget, expectedCommit, allowedRoot);
    if (!current.prepared) {
      throw new Error(`Existing qualification host is not an owned clean ${expectedCommit} checkout: ${absoluteTarget}`);
    }
    if (!install || current.dependenciesInstalled) return current;
  } else {
    await mkdir(dirname(absoluteTarget), { recursive: true });
    const partialTarget = assertOwnedTarget(`${absoluteTarget}.partial-${process.pid}`, allowedRoot);
    try {
      run("git", ["clone", "--no-checkout", source, partialTarget]);
      run("git", ["-C", partialTarget, "checkout", "--detach", expectedCommit]);
      const trackedStatus = git(partialTarget, ["status", "--porcelain", "--untracked-files=no"]);
      if (trackedStatus !== "") throw new Error("Fresh Paperclip host checkout is unexpectedly dirty");
      await writeFile(resolve(partialTarget, ownershipMarkerName), `${JSON.stringify({
        schemaVersion: 1,
        environmentClass: "local-sandbox",
        expectedCommit,
        source,
      }, null, 2)}\n`);
      await rename(partialTarget, absoluteTarget);
    } catch (error) {
      await rm(partialTarget, { recursive: true, force: true });
      throw error;
    }
  }

  if (install) {
    const corepackHome = resolve(runtimeRoot, "corepack");
    await mkdir(corepackHome, { recursive: true });
    const dependencyPreparation = prepareDependencies(absoluteTarget);
    const markerPath = resolve(absoluteTarget, ownershipMarkerName);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    await writeFile(markerPath, `${JSON.stringify({ ...marker, dependencyPreparation }, null, 2)}\n`);
  }
  const result = inspectHost(absoluteTarget, expectedCommit, allowedRoot);
  if (!result.prepared || (install && !result.dependenciesInstalled)) {
    throw new Error("Paperclip qualification host did not reach the requested prepared state");
  }
  return result;
}

function parseArguments(argumentsList) {
  const [command = "status", ...rest] = argumentsList;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--source") options.source = rest[++index];
    else if (argument === "--target") options.target = rest[++index];
    else if (argument === "--skip-install") options.install = false;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const target = options.target ?? defaultHostRoot;
  let result;
  if (options.command === "prepare") {
    result = await materializeHost({ source: options.source, target, install: options.install });
  } else if (options.command === "status" || options.command === "verify") {
    result = inspectHost(target);
    if (options.command === "verify" && (!result.prepared || !result.dependenciesInstalled)) process.exitCode = 1;
  } else if (options.command === "path") {
    console.log(assertOwnedTarget(target));
    return;
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
