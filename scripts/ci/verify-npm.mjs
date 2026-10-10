import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const registry = 'https://registry.npmjs.org';
const deadlineMs = 20 * 60_000;
const intervalMs = 15_000;
const requestMs = 30_000;

export function releaseVersion(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag ?? '')) {
    throw new Error('Expected a v<semver> release tag');
  }
  return tag.slice(1);
}

export function inspectArchive(archive, tag, packageName) {
  const version = releaseVersion(tag);
  const packed = JSON.parse(execFileSync('tar', ['-xOf', resolve(archive), 'package/package.json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  }));
  if (packed.name !== packageName || packed.version !== version) {
    throw new Error('Archive name/version does not match the qualified release');
  }
  return {
    name: packageName, version,
    integrity: `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`,
    distTag: version.split('+')[0].includes('-') ? 'next' : 'latest',
  };
}

function temporaryStatus(status) {
  return status === 404 || status === 429 || status >= 500 && status <= 599;
}

// The timer covers both response headers and body, even if a transport ignores abort.
async function requestJson(url, fetcher, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('request timeout')); }, timeoutMs);
  });
  try {
    let response;
    try {
      response = await Promise.race([
        (async () => {
          const result = await fetcher(url, {
            method: 'GET', redirect: 'error', signal: controller.signal,
            headers: { accept: 'application/json', 'cache-control': 'no-cache' },
          });
          return { status: result.status, body: result.status === 200 ? await result.text() : '' };
        })(), expired,
      ]);
    } catch {
      return { pending: 'registry transport unavailable or request timed out' };
    }
    if (temporaryStatus(response.status)) return { pending: `registry HTTP ${response.status}` };
    if (response.status !== 200) throw new Error(`Registry verification refused: HTTP ${response.status}`);
    try {
      return { data: JSON.parse(response.body) };
    } catch {
      throw new Error('Registry returned invalid JSON metadata');
    }
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

function assertVersion(metadata, expected) {
  const { name, version, dist } = metadata ?? {};
  if ([name !== expected.name, version !== expected.version].some(Boolean)) {
    throw new Error('Registry package name/version is inconsistent with the qualified archive');
  }
  if (dist?.integrity !== expected.integrity) {
    throw new Error('Registry SHA512 integrity differs from the qualified archive');
  }
}

function assertTagMap(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Registry returned inconsistent dist-tag metadata');
  }
}

function tagObservation(data, expected) {
  assertTagMap(data);
  const selected = data[expected.distTag];
  if (selected !== undefined && typeof selected !== 'string') throw new Error('Registry dist-tag must be a version string');
  return selected === expected.version ? null : `dist-tag ${expected.distTag} does not yet select ${expected.version}`;
}

async function observeTags(read, encoded, expected) {
  const tags = await read(`${registry}/-/package/${encoded}/dist-tags`);
  return tags.pending ?? tagObservation(tags.data, expected);
}

async function observe(expected, io, deadline, requestTimeoutMs) {
  const encoded = encodeURIComponent(expected.name);
  const read = (url) => requestJson(url, io.fetch, Math.min(requestTimeoutMs, deadline - io.now()));
  const version = await read(`${registry}/${encoded}/${encodeURIComponent(expected.version)}`);
  if (version.pending) return version.pending;
  assertVersion(version.data, expected);
  if (io.now() >= deadline) return 'verification deadline reached';
  return observeTags(read, encoded, expected);
}

function verificationLimits(options) {
  return {
    timeoutMs: Math.min(options.timeoutMs ?? deadlineMs, deadlineMs),
    requestTimeoutMs: Math.min(options.requestTimeoutMs ?? requestMs, requestMs),
  };
}

export async function verifyRegistry(expected, options = {}) {
  const io = { fetch: globalThis.fetch, now: () => performance.now(), sleep, ...options.io };
  const { timeoutMs, requestTimeoutMs } = verificationLimits(options);
  const deadline = io.now() + timeoutMs;
  let pending = 'version not observed';
  // At most 80 observations / 160 GETs, including when an injected clock stalls.
  for (let attempt = 0; attempt < 80 && io.now() < deadline; attempt += 1) {
    pending = await observe(expected, io, deadline, requestTimeoutMs);
    if (io.now() >= deadline) break;
    if (pending === null) return { status: 'PASS', ...expected, observations: attempt + 1 };
    await io.sleep(Math.min(intervalMs, deadline - io.now()));
  }
  throw new Error(`Registry verification deadline exceeded (${timeoutMs} ms): ${pending}. Run verify-npm.yml with the original run_id for verification only; do not publish again.`);
}

async function main() {
  const directory = process.env.ARCHIVE_DIRECTORY;
  if (!directory || !process.env.PACKAGE_NAME) throw new Error('ARCHIVE_DIRECTORY and PACKAGE_NAME are required');
  const archives = readdirSync(directory).filter((name) => name.endsWith('.tgz'));
  if (archives.length !== 1) throw new Error('Expected exactly one qualified .tgz artifact');
  const expected = inspectArchive(resolve(directory, archives[0]), process.env.RELEASE_TAG, process.env.PACKAGE_NAME);
  console.log(JSON.stringify(await verifyRegistry(expected)));
}

export function runCli(moduleUrl, execute) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(moduleUrl)) {
    execute().catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}

runCli(import.meta.url, main);
