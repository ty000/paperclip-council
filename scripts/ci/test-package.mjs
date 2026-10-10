import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8"));
const outputArg = process.argv.indexOf("--output-dir");
if (outputArg !== -1 && !process.argv[outputArg + 1]) throw new Error("--output-dir requires a path");
const ownedRoot = outputArg === -1 ? mkdtempSync(resolve(tmpdir(), "paperclip-council-npm-")) : null;
const outputDirectory = resolve(outputArg === -1 ? ownedRoot : process.argv[outputArg + 1]);
const consumer = resolve(ownedRoot ?? mkdtempSync(resolve(tmpdir(), "paperclip-council-consumer-")), "consumer");

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 300_000,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const requiredFiles = [
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/dist/manifest.js",
  "package/dist/worker.js",
  "package/dist/ui/index.js",
  "package/migrations/001_foundation_probe.sql",
  "package/migrations/008_repository_occupation.sql",
  "package/scripts/operations/workspace_preflight.py",
  "package/scripts/operations/publisher_preflight.py",
  "package/scripts/operations/github_feedback.py",
  "package/scripts/operations/github_integration.py",
  "package/scripts/operations/integrate_delivery.py",
  "package/scripts/operations/cancel_delivery.py",
];
const allowedFiles = new Set(requiredFiles.filter((path) => !path.startsWith("package/dist/") && !path.startsWith("package/migrations/")));
const allowedPrefixes = ["package/dist/", "package/migrations/"];
const forbiddenParts = ["node_modules", ".git", ".runtime", ".paperclip", "artifacts", "tests", "qualification", "__pycache__"];

try {
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(consumer, { recursive: true });

  run("pnpm", ["build"], { capture: false });
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outputDirectory]));
  assert(Array.isArray(packed) && packed.length === 1, "npm pack must produce exactly one archive");
  const pack = packed[0];
  const archive = resolve(outputDirectory, pack.filename);
  const entries = pack.files.map(({ path }) => `package/${path}`);
  const sourceMigrations = readdirSync(resolve(repository, "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `package/migrations/${entry.name}`)
    .sort();
  const packedMigrations = entries.filter((path) => path.startsWith("package/migrations/")).sort();

  for (const path of requiredFiles) assert(entries.includes(path), `npm archive is missing ${path}`);
  assert(JSON.stringify(packedMigrations) === JSON.stringify(sourceMigrations), "npm archive migrations differ from the source migration set");
  for (const path of entries) {
    assert(allowedFiles.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix)), `unexpected npm archive path: ${path}`);
    assert(!forbiddenParts.some((part) => path.split("/").includes(part)), `runtime/local path leaked into npm archive: ${path}`);
  }

  writeFileSync(resolve(consumer, "package.json"), JSON.stringify({ name: "council-package-consumer", private: true, type: "module" }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", archive], { cwd: consumer, capture: false });

  for (const devOnly of ["typescript", "esbuild", "vitest", "fallow", "tsx", "@paperclipai/shared"]) {
    assert(!readFileSync(resolve(consumer, "package.json"), "utf8").includes(devOnly), `consumer package unexpectedly declares ${devOnly}`);
    try {
      run("npm", ["ls", devOnly, "--depth=0", "--json"], { cwd: consumer });
      throw new Error(`consumer unexpectedly installed dev-only package ${devOnly}`);
    } catch (error) {
      if (error.message.startsWith("consumer unexpectedly")) throw error;
    }
  }

  const installedRoot = resolve(consumer, "node_modules", "@ty000", "paperclip-council");
  const installedPackage = JSON.parse(readFileSync(resolve(installedRoot, "package.json"), "utf8"));
  assert(installedPackage.name === packageJson.name, "installed package name differs from source package");
  assert(installedPackage.version === packageJson.version, "installed package version differs from source package");
  assert(installedPackage.private !== true, "installed package remains private");
  assert(installedPackage.publishConfig?.access === "public", "installed package is not configured for public access");
  for (const script of requiredFiles.filter((path) => path.endsWith(".py"))) {
    run("python3", [resolve(installedRoot, script.slice("package/".length)), "--help"], { cwd: installedRoot, timeout: 30_000 });
  }
  const manifest = (await import(pathToFileURL(resolve(installedRoot, "dist/manifest.js")))).default;
  const worker = (await import(pathToFileURL(resolve(installedRoot, "dist/worker.js")))).default;
  assert(manifest.id === "private.paperclip-council", "published manifest id changed");
  assert(manifest.version === installedPackage.version, "manifest and package versions differ");
  assert(manifest.database?.namespaceSlug === "private_paperclip_council", "published migration namespace changed");
  assert(worker && typeof worker.definition?.setup === "function", "installed worker definition did not load");
  const health = await worker.definition.onHealth();
  assert(health?.status === "ok", "installed worker provider-free health smoke failed");

  console.log(JSON.stringify({
    status: "PASS",
    package: `${installedPackage.name}@${installedPackage.version}`,
    archive,
    filename: basename(archive),
    integrity: pack.integrity,
    shasum: pack.shasum,
    fileCount: entries.length,
    install: "temporary consumer, --ignore-scripts, --omit=dev",
    manifest: { id: manifest.id, version: manifest.version, namespaceSlug: manifest.database.namespaceSlug },
    workerHealth: health.status,
  }, null, 2));
} finally {
  if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  else rmSync(dirname(consumer), { recursive: true, force: true });
}
