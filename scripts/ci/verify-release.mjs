import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (!args.tag || !args.tarball) throw new Error("Usage: verify-release.mjs --tag v<version> --tarball <archive.tgz>");

const tarball = resolve(args.tarball);
const temporary = mkdtempSync(resolve(tmpdir(), "paperclip-council-release-"));
try {
  execFileSync("tar", ["-xzf", tarball, "-C", temporary], { stdio: "inherit", timeout: 30_000 });
  const root = resolve(temporary, "package");
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (pkg.name !== "@ty000/paperclip-council") throw new Error(`unexpected package name: ${pkg.name}`);
  if (!semver.test(pkg.version)) throw new Error(`package version is not supported semver: ${pkg.version}`);
  if (args.tag !== `v${pkg.version}`) throw new Error(`tag ${args.tag} must equal v${pkg.version}`);
  if (pkg.publishConfig?.access !== "public" || pkg.publishConfig?.registry !== "https://registry.npmjs.org/") {
    throw new Error("package publishConfig must target the public npm registry");
  }
  if (pkg.repository !== "https://github.com/ty000/paperclip-council.git") throw new Error("package repository does not match the trusted GitHub repository");
  const manifest = (await import(pathToFileURL(resolve(root, "dist/manifest.js")))).default;
  if (manifest.id !== "private.paperclip-council") throw new Error(`unexpected manifest id: ${manifest.id}`);
  if (manifest.version !== pkg.version) throw new Error(`manifest version ${manifest.version} differs from package ${pkg.version}`);
  if (manifest.database?.namespaceSlug !== "private_paperclip_council") throw new Error("migration namespace changed");
  const distTag = pkg.version.includes("-") ? "next" : "latest";
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `dist_tag=${distTag}\npackage_name=${pkg.name}\npackage_version=${pkg.version}\ntarball=${basename(tarball)}\n`);
  }
  console.log(JSON.stringify({ status: "PASS", tag: args.tag, package: `${pkg.name}@${pkg.version}`, manifestId: manifest.id, distTag, tarball: basename(tarball) }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
