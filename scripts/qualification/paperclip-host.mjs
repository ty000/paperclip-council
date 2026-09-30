import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
const hostBuild = configuration.paperclip.hostBuild;
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

function directoryIdentity(path) {
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (!status || status.isSymbolicLink() || !status.isDirectory()) return null;
  return { device: status.dev, inode: status.ino };
}

function hasDirectoryIdentity(path, identity) {
  const current = directoryIdentity(path);
  return current?.device === identity.device && current?.inode === identity.inode;
}

function markerPathFor(hostRoot) {
  return resolve(hostRoot, ownershipMarkerName);
}

function assertRegularMarker(markerPath, { allowMissing = false } = {}) {
  const markerStatus = lstatSync(markerPath, { throwIfNoEntry: false });
  if (!markerStatus) {
    if (allowMissing) return false;
    throw new Error(`Qualification host ownership marker is missing: ${markerPath}`);
  }
  if (markerStatus.isSymbolicLink() || !markerStatus.isFile()) {
    throw new Error(`Qualification host ownership marker must be a regular file, not a symbolic link: ${markerPath}`);
  }
  return true;
}

function openRegularMarker(markerPath, flags) {
  assertRegularMarker(markerPath);
  let descriptor;
  try {
    descriptor = openSync(markerPath, flags | constants.O_NOFOLLOW);
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Qualification host ownership marker must remain a regular file: ${markerPath}`);
    }
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "ELOOP") {
      throw new Error(`Qualification host ownership marker must not be a symbolic link: ${markerPath}`);
    }
    throw error;
  }
}

function readMarker(hostRoot) {
  const markerPath = markerPathFor(hostRoot);
  if (!assertRegularMarker(markerPath, { allowMissing: true })) return null;
  const descriptor = openRegularMarker(markerPath, constants.O_RDONLY);
  try {
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally {
    closeSync(descriptor);
  }
}

function createMarker(hostRoot, marker) {
  const markerPath = markerPathFor(hostRoot);
  if (lstatSync(markerPath, { throwIfNoEntry: false })) {
    assertRegularMarker(markerPath);
    throw new Error(`Fresh qualification host already contains an ownership marker: ${markerPath}`);
  }
  const descriptor = openSync(
    markerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, `${JSON.stringify(marker, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
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

function prepareHostBuild(hostRoot) {
  run("corepack", ["pnpm", ...hostBuild.arguments], {
    cwd: hostRoot,
    env: { ...process.env, COREPACK_HOME: resolve(runtimeRoot, "corepack") },
  });
  const invalidOutputs = Object.entries(hostBuild.requiredOutputs)
    .filter(([output, expectedSha256]) => {
      const outputPath = resolve(hostRoot, output);
      return !existsSync(outputPath) || sha256(readFileSync(outputPath)) !== expectedSha256;
    })
    .map(([output]) => output);
  if (invalidOutputs.length > 0) {
    throw new Error(`Paperclip host build outputs differ from pinned digests: ${invalidOutputs.join(", ")}`);
  }
  return { command: ["corepack", "pnpm", ...hostBuild.arguments], requiredOutputs: hostBuild.requiredOutputs };
}

export function updateMarker(hostRoot, values) {
  const markerPath = markerPathFor(hostRoot);
  const marker = readMarker(hostRoot);
  const serializedMarker = `${JSON.stringify({ ...marker, ...values }, null, 2)}\n`;
  const temporaryMarkerPath = `${markerPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(
      temporaryMarkerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new Error(`Qualification host temporary ownership marker must be a regular file: ${temporaryMarkerPath}`);
    }
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, serializedMarker, "utf8");
    fsyncSync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = undefined;
    closeSync(completedDescriptor);
    assertRegularMarker(markerPath);
    renameSync(temporaryMarkerPath, markerPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryMarkerPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw new AggregateError([error, cleanupError], "Ownership marker update and cleanup failed");
    }
    throw error;
  }
}

export function assertOwnedTarget(target, allowedRoot = runtimeRoot) {
  const absoluteTarget = resolve(target);
  const absoluteRoot = resolve(allowedRoot);
  const pathFromRoot = relative(absoluteRoot, absoluteTarget);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`Qualification host target must be a child of ${absoluteRoot}`);
  }
  for (const [label, candidate] of [["root", absoluteRoot], ["target", absoluteTarget]]) {
    let existing = candidate;
    while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
    if (existsSync(existing) && realpathSync(existing) !== existing) {
      throw new Error(`Qualification host ${label} has a symbolic-link redirection: ${candidate}`);
    }
  }
  return absoluteTarget;
}

export function inspectHost(
  target,
  expectedCommit = expectedPaperclipCommit,
  allowedRoot = runtimeRoot,
) {
  const absoluteTarget = assertOwnedTarget(target, allowedRoot);
  if (!existsSync(resolve(absoluteTarget, ".git"))) {
    return { prepared: false, target: absoluteTarget, expectedCommit };
  }
  const head = git(absoluteTarget, ["rev-parse", "HEAD"]);
  const trackedStatus = git(absoluteTarget, ["status", "--porcelain", "--untracked-files=no"]);
  const marker = readMarker(absoluteTarget);
  const owned = marker?.schemaVersion === 1
    && marker?.environmentClass === "local-sandbox"
    && marker?.expectedCommit === expectedCommit
    && marker?.source === defaultPaperclipSource;
  const dependencyPreparation = marker?.dependencyPreparation ?? null;
  const dependencyPreparationValid = dependencyPreparation?.mode === "validated-lock-metadata-repair"
    && dependencyPreparation.originalSha256 === lockfileRepair.originalSha256
    && dependencyPreparation.repairedSha256 === lockfileRepair.repairedSha256
    && dependencyPreparation.diffSha256 === lockfileRepair.diffSha256
    && existsSync(resolve(absoluteTarget, "node_modules/.pnpm/lock.yaml"))
    && sha256(readFileSync(resolve(absoluteTarget, "node_modules/.pnpm/lock.yaml"))) === lockfileRepair.repairedSha256;
  const hostBuildPreparation = marker?.hostBuildPreparation ?? null;
  const hostBuildValid = JSON.stringify(hostBuildPreparation?.command) === JSON.stringify(["corepack", "pnpm", ...hostBuild.arguments])
    && Object.entries(hostBuild.requiredOutputs).every(([output, expectedSha256]) => {
      const outputPath = resolve(absoluteTarget, output);
      return existsSync(outputPath) && sha256(readFileSync(outputPath)) === expectedSha256;
    });
  return {
    prepared: head === expectedCommit && trackedStatus === "" && owned,
    target: absoluteTarget,
    expectedCommit,
    head,
    trackedClean: trackedStatus === "",
    owned,
    dependencyPreparation,
    dependenciesInstalled: dependencyPreparationValid && existsSync(resolve(absoluteTarget, "node_modules")),
    hostBuildPreparation,
    runtimeReady: dependencyPreparationValid && hostBuildValid,
  };
}

async function materializeFreshHost({ absoluteTarget, source, expectedCommit, clone }) {
  await mkdir(absoluteTarget);
  const reservedTargetIdentity = directoryIdentity(absoluteTarget);
  if (!reservedTargetIdentity) throw new Error(`Qualification host target reservation is not a regular directory: ${absoluteTarget}`);
  let reservationDescriptor;
  try {
    reservationDescriptor = openSync(
      absoluteTarget,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const reservationStatus = fstatSync(reservationDescriptor);
    if (reservationStatus.dev !== reservedTargetIdentity.device || reservationStatus.ino !== reservedTargetIdentity.inode) {
      throw new Error(`Qualification host target identity changed during reservation: ${absoluteTarget}`);
    }
    await clone(source, absoluteTarget);
    run("git", ["-C", absoluteTarget, "checkout", "--detach", expectedCommit]);
    const trackedStatus = git(absoluteTarget, ["status", "--porcelain", "--untracked-files=no"]);
    if (trackedStatus !== "") throw new Error("Fresh Paperclip host checkout is unexpectedly dirty");
    createMarker(absoluteTarget, {
      schemaVersion: 1,
      environmentClass: "local-sandbox",
      expectedCommit,
      source: defaultPaperclipSource,
      materializedFrom: source,
    });
  } catch (error) {
    if (hasDirectoryIdentity(absoluteTarget, reservedTargetIdentity)) {
      await rm(absoluteTarget, { recursive: true, force: true });
    } else if (existsSync(absoluteTarget)) {
      throw new AggregateError(
        [error],
        `Qualification host target identity changed; refusing cleanup: ${absoluteTarget}`,
      );
    }
    throw error;
  } finally {
    if (reservationDescriptor !== undefined) closeSync(reservationDescriptor);
  }
}

export async function materializeHost({
  source = defaultPaperclipSource,
  target = defaultHostRoot,
  expectedCommit = expectedPaperclipCommit,
  install = true,
  allowedRoot = runtimeRoot,
  clone = (cloneSource, cloneTarget) => run("git", ["clone", "--no-checkout", cloneSource, cloneTarget]),
} = {}) {
  const absoluteTarget = assertOwnedTarget(target, allowedRoot);
  if (existsSync(absoluteTarget)) {
    const current = inspectHost(absoluteTarget, expectedCommit, allowedRoot);
    if (!current.prepared) {
      throw new Error(`Existing qualification host is not an owned clean ${expectedCommit} checkout: ${absoluteTarget}`);
    }
    if (!install) return current;
  } else {
    await mkdir(dirname(absoluteTarget), { recursive: true });
    await materializeFreshHost({ absoluteTarget, source, expectedCommit, clone });
  }

  if (install) {
    const corepackHome = resolve(runtimeRoot, "corepack");
    await mkdir(corepackHome, { recursive: true });
    updateMarker(absoluteTarget, { dependencyPreparation: prepareDependencies(absoluteTarget) });
    updateMarker(absoluteTarget, { hostBuildPreparation: prepareHostBuild(absoluteTarget) });
  }
  const result = inspectHost(absoluteTarget, expectedCommit, allowedRoot);
  if (!result.prepared || (install && !result.runtimeReady)) {
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
  const source = options.source ?? process.env.PAPERCLIP_QUALIFICATION_SOURCE ?? defaultPaperclipSource;
  let result;
  if (options.command === "prepare") {
    result = await materializeHost({ source, target, install: options.install });
  } else if (options.command === "status" || options.command === "verify") {
    result = inspectHost(target, expectedPaperclipCommit, runtimeRoot);
    if (options.command === "verify" && (!result.prepared || !result.runtimeReady)) process.exitCode = 1;
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
