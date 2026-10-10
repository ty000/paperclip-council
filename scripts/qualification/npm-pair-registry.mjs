import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

// An ephemeral read-only registry serves the exact candidate archives. Public
// dependency requests go to npm; no publishing or credential forwarding exists.
async function archive(path, expectedName) {
  const file = resolve(path);
  const bytes = await readFile(file);
  const pkg = JSON.parse(execFileSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8", timeout: 30_000 }));
  assert.equal(pkg.name, expectedName);
  assert.equal(pkg.private, undefined, "Candidate must be publishable");
  assert.equal(pkg.publishConfig?.access, "public");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  return { file, bytes, pkg, sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

function metadata(candidate, origin, index) {
  const version = { ...candidate.pkg, dist: { integrity: candidate.integrity,
    shasum: createHash("sha1").update(candidate.bytes).digest("hex"), tarball: `${origin}/archive/${index}.tgz` } };
  return { name: candidate.pkg.name, "dist-tags": { latest: candidate.pkg.version },
    versions: { [candidate.pkg.version]: version } };
}

function requestName(url) {
  try { return decodeURIComponent(url.pathname.slice(1)); }
  catch { return null; }
}

function serveArchiveRequest(context, name, url, response) {
  const { packages, requests, origin } = context;
  const index = packages.findIndex(candidate => candidate.pkg.name === name);
  if (index !== -1) {
    requests.push({ package: name, kind: "metadata" });
    response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(metadata(packages[index], origin, index)));
    return;
  }
  const candidate = packages.find((_, number) => name === `archive/${number}.tgz`);
  if (candidate) {
    requests.push({ package: candidate.pkg.name, kind: "tarball" });
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(candidate.bytes);
    return;
  }
  if (name.startsWith("@ty000/") || name.startsWith("archive/")) { response.writeHead(404).end(); return; }
  // Fixed public origin; the incoming URL cannot select a redirect host.
  response.writeHead(307, { location: `https://registry.npmjs.org${url.pathname}${url.search}` }).end();
}

export async function startPackageRegistry(councilArchive, intakeArchive) {
  const packages = await Promise.all([
    archive(councilArchive, "@ty000/paperclip-council"),
    archive(intakeArchive, "@ty000/paperclip-linear-intake"),
  ]);
  const requests = [];
  let origin;
  const server = createServer((request, response) => {
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (request.headers.authorization) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, "http://127.0.0.1");
    const name = requestName(url);
    if (name === null) { response.writeHead(400).end(); return; }
    serveArchiveRequest({ packages, requests, origin }, name, url, response);
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  assert(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, requests,
    packages: packages.map(({ file, pkg, sha256, integrity }) => ({ file, name: pkg.name, version: pkg.version, sha256, integrity })),
    async close() {
      server.closeAllConnections();
      await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
    },
  };
}
