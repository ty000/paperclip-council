import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspectArchive, releaseVersion, verifyRegistry } from './verify-npm.mjs';
import { validateRunEvidence } from './verify-npm-run.mjs';

const expected = { name: '@ty000/paperclip-council', version: '1.2.3', integrity: 'sha512-fixture', distTag: 'latest' };
const metadata = { name: expected.name, version: expected.version, dist: { integrity: expected.integrity } };
const reply = (data, status = 200) => ({ status, text: async () => JSON.stringify(data) });

function fakeRegistry(responses) {
  let elapsed = 0;
  const calls = [];
  return {
    calls, now: () => elapsed,
    advance: (milliseconds) => { elapsed += milliseconds; },
    sleep: async (milliseconds) => { elapsed += milliseconds; },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      assert.equal(options.method, 'GET');
      assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'unexpected request');
      return response;
    },
  };
}

for (const status of [404, 429, 500, 503]) {
  test(`delayed visibility recovers from HTTP ${status} using GET only`, async () => {
    const io = fakeRegistry([reply({}, status), reply(metadata), reply({ latest: expected.version })]);
    assert.equal((await verifyRegistry(expected, { io })).status, 'PASS');
    assert.equal(io.calls.length, 3);
    assert.equal(io.now(), 15_000);
  });
}

test('transport failure and stale dist-tag wait before succeeding', async () => {
  const io = fakeRegistry([new Error('offline'), reply(metadata), reply({ latest: '1.2.2' }), reply(metadata), reply({ latest: expected.version })]);
  await verifyRegistry(expected, { io });
  assert.equal(io.now(), 30_000);
  assert.equal(io.calls.length, 5);
});

for (const [label, response, message] of [
  ['wrong integrity', reply({ ...metadata, dist: { integrity: 'sha512-other' } }), /SHA512 integrity/],
  ['wrong name', reply({ ...metadata, name: '@someone/else' }), /name\/version/],
  ['wrong version', reply({ ...metadata, version: '1.2.4' }), /name\/version/],
  ['forbidden', reply({}, 403), /HTTP 403/],
  ['bad request', reply({}, 400), /HTTP 400/],
  ['malformed metadata', { status: 200, text: async () => 'not json' }, /invalid JSON/],
]) {
  test(`${label} fails without a retry`, async () => {
    const io = fakeRegistry([response]);
    await assert.rejects(verifyRegistry(expected, { io }), message);
    assert.equal(io.calls.length, 1);
    assert.equal(io.now(), 0);
  });
}

test('stale or missing dist-tag times out without accepting a published version alone', async () => {
  const io = fakeRegistry([reply(metadata), reply({})]);
  await assert.rejects(verifyRegistry(expected, { io, timeoutMs: 10_000 }), /verification only; do not publish again/);
  assert.equal(io.now(), 10_000);
});

test('invalid dist-tag metadata fails immediately', async () => {
  const io = fakeRegistry([reply(metadata), reply({ latest: 123 })]);
  await assert.rejects(verifyRegistry(expected, { io }), /version string/);
  assert.equal(io.now(), 0);
});

test('wallclock budget is twenty minutes and bounds the total GET count', async () => {
  const io = fakeRegistry(Array.from({ length: 80 }, () => reply({}, 404)));
  await assert.rejects(verifyRegistry(expected, { io }), /deadline exceeded \(1200000 ms\)/);
  assert.equal(io.now(), 1_200_000);
  assert.equal(io.calls.length, 80);
});

test('no success or second request after a response consumes the deadline', async () => {
  const io = fakeRegistry([]);
  io.fetch = async () => { io.advance(1000); return reply(metadata); };
  await assert.rejects(verifyRegistry(expected, { io, timeoutMs: 1000 }), /deadline exceeded/);
  assert.equal(io.now(), 1000);
});

for (const phase of ['headers', 'body']) {
  test(`hung ${phase} is aborted with a bounded request timeout`, async () => {
    const io = fakeRegistry([]);
    let signal;
    io.fetch = async (_url, options) => {
      signal = options.signal;
      const never = new Promise(() => {});
      return phase === 'headers' ? never : { status: 200, text: () => never };
    };
    await assert.rejects(verifyRegistry(expected, { io, timeoutMs: 10, requestTimeoutMs: 5 }), /deadline exceeded/);
    assert.equal(signal.aborted, true);
    assert.equal(io.now(), 10);
  });
}

test('reads archive metadata and exact SHA512 without executing packaged scripts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'npm-verification-'));
  try {
    const packageRoot = join(directory, 'package');
    mkdirSync(packageRoot);
    const marker = join(directory, 'executed');
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: expected.name, version: '1.2.3-rc.1', scripts: { postinstall: 'exit 99' } }));
    writeFileSync(join(packageRoot, 'manifest.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
    const archive = join(directory, 'fixture.tgz');
    execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
    const result = inspectArchive(archive, 'v1.2.3-rc.1', expected.name);
    assert.equal(result.distTag, 'next');
    assert.equal(result.integrity, `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`);
    assert.equal(existsSync(marker), false);
    assert.throws(() => inspectArchive(archive, 'v1.2.3', expected.name), /name\/version/);
    assert.throws(() => inspectArchive(archive, 'v1.2.3-rc.1', '@else/package'), /name\/version/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runEvidence(repository = 'ty000/paperclip-council') {
  const intake = repository.endsWith('intake');
  const run = {
    id: 123, repository: { id: 1, full_name: repository }, head_repository: { id: 1, full_name: repository },
    path: '.github/workflows/release.yml', event: 'push', status: 'completed', conclusion: 'failure',
    head_branch: 'v1.2.3', head_sha: 'a'.repeat(40),
  };
  const names = intake ? ['Build, test and pack', 'PostgreSQL durability checks', 'Fallow introduced-findings gate'] : ['Verify release package'];
  const jobs = { total_count: names.length, jobs: names.map((name) => ({ name, run_id: 123, status: 'completed', conclusion: 'success' })) };
  const artifacts = { total_count: 1, artifacts: [{
    id: 456, name: intake ? 'npm-package' : 'npm-package-1.2.3', expired: false,
    workflow_run: { id: 123, head_branch: run.head_branch, head_sha: run.head_sha, repository_id: 1, head_repository_id: 1 },
  }] };
  return { repository, run, jobs, artifacts };
}

const validate = (evidence) => validateRunEvidence(evidence.repository, '123', evidence.run, evidence.jobs, evidence.artifacts);
for (const repository of ['ty000/paperclip-council', 'ty000/paperclip-linear-intake']) {
  test(`accepts a failed qualified release run for ${repository}, deriving its original version`, () => {
    assert.deepEqual(validate(runEvidence(repository)), { run_id: '123', release_tag: 'v1.2.3', head_sha: 'a'.repeat(40), artifact_id: '456' });
  });
}

for (const [label, mutate] of [
  ['other repository', (e) => { e.run.repository.full_name = 'else/repo'; }],
  ['fork', (e) => { e.run.head_repository.full_name = 'else/repo'; }],
  ['other run', (e) => { e.run.id = 987; }],
  ['other workflow', (e) => { e.run.path = '.github/workflows/ci.yml'; }],
  ['branch', (e) => { e.run.head_branch = 'main'; }],
  ['pull request', (e) => { e.run.event = 'pull_request'; }],
  ['unfinished run', (e) => { e.run.status = 'in_progress'; }],
  ['failed package', (e) => { e.jobs.jobs[0].conclusion = 'failure'; }],
  ['absent package', (e) => { e.jobs.jobs = []; e.jobs.total_count = 0; }],
  ['incomplete jobs', (e) => { e.jobs.total_count = 2; }],
  ['wrong job run', (e) => { e.jobs.jobs[0].run_id = 987; }],
  ['expired artifact', (e) => { e.artifacts.artifacts[0].expired = true; }],
  ['wrong artifact tag', (e) => { e.artifacts.artifacts[0].workflow_run.head_branch = 'v2.0.0'; }],
  ['wrong artifact commit', (e) => { e.artifacts.artifacts[0].workflow_run.head_sha = 'b'.repeat(40); }],
  ['wrong artifact repo', (e) => { e.artifacts.artifacts[0].workflow_run.repository_id = 999; }],
  ['wrong artifact run', (e) => { e.artifacts.artifacts[0].workflow_run.id = 999; }],
  ['wrong artifact name', (e) => { e.artifacts.artifacts[0].name = 'other'; }],
  ['ambiguous artifact', (e) => { e.artifacts.artifacts.push(e.artifacts.artifacts[0]); e.artifacts.total_count = 2; }],
]) {
  test(`rejects provenance with ${label}`, () => {
    const evidence = runEvidence();
    mutate(evidence);
    assert.throws(() => validate(evidence));
  });
}

for (const index of [1, 2]) {
  test(`Intake requires its additional release gate ${index}`, () => {
    const evidence = runEvidence('ty000/paperclip-linear-intake');
    evidence.jobs.jobs[index].conclusion = 'failure';
    assert.throws(() => validate(evidence), /qualification did not succeed/);
  });
}

test('rejects branch-shaped tags and unsafe run identifiers before reads', () => {
  assert.throws(() => releaseVersion('main'), /release tag/);
  const e = runEvidence();
  assert.throws(() => validateRunEvidence(e.repository, '../123', e.run, e.jobs, e.artifacts), /invalid run_id/);
});
