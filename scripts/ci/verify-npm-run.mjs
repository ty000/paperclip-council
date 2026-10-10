import { appendFileSync } from 'node:fs';
import { releaseVersion, runCli } from './verify-npm.mjs';

const releases = {
  'ty000/paperclip-linear-intake': { jobs: ['Build, test and pack', 'PostgreSQL durability checks', 'Fallow introduced-findings gate'], artifact: () => 'npm-package' },
  'ty000/paperclip-council': { jobs: ['Verify release package'], artifact: (version) => `npm-package-${version}` },
};

function assertRun(repository, runId, run) {
  const checks = [
    String(run.id) === runId, run.repository?.full_name === repository,
    run.head_repository?.full_name === repository, run.event === 'push', run.status === 'completed',
    run.path === '.github/workflows/release.yml', /^[0-9a-f]{40}$/.test(run.head_sha ?? ''),
  ];
  if (!checks.every(Boolean)) throw new Error('Run must be a completed release.yml tag push from this repository');
  return releaseVersion(run.head_branch);
}

function completeInventory(inventory, key) {
  const items = inventory[key];
  if (!Array.isArray(items) || inventory.total_count !== items.length) throw new Error(`Incomplete ${key} inventory`);
  return items;
}

function namedItem(items, name) {
  const matching = items.filter((item) => item.name === name);
  if (matching.length !== 1) throw new Error(`Expected exactly one qualified ${name}`);
  return matching[0];
}

function assertQualifiedJob(jobs, runId, name) {
  const job = namedItem(completeInventory(jobs, 'jobs'), name);
  const checks = [String(job.run_id) === runId, job.status === 'completed', job.conclusion === 'success'];
  if (!checks.every(Boolean)) throw new Error('Release package qualification did not succeed');
}

function matchesOrigin(origin, run) {
  const expected = {
    id: run.id, head_sha: run.head_sha, head_branch: run.head_branch,
    repository_id: run.repository.id, head_repository_id: run.head_repository.id,
  };
  return Object.entries(expected).every(([key, value]) => origin?.[key] === value);
}

function qualifiedArtifact(artifacts, name, run) {
  const artifact = namedItem(completeInventory(artifacts, 'artifacts'), name);
  const checks = [
    Number.isSafeInteger(artifact.id), artifact.id > 0, artifact.expired === false,
    matchesOrigin(artifact.workflow_run, run),
  ];
  if (!checks.every(Boolean)) throw new Error('Artifact is expired or its release provenance does not match');
  return artifact;
}

export function validateRunEvidence(repository, runId, run, jobs, artifacts) {
  const release = releases[repository];
  if (!release || !/^[1-9]\d{0,19}$/.test(runId ?? '')) throw new Error('Unsupported repository or invalid run_id');
  const version = assertRun(repository, runId, run);
  for (const name of release.jobs) assertQualifiedJob(jobs, runId, name);
  const artifact = qualifiedArtifact(artifacts, release.artifact(version), run);
  return { run_id: runId, release_tag: run.head_branch, head_sha: run.head_sha, artifact_id: String(artifact.id) };
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com${path}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub provenance read failed: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.RELEASE_RUN_ID;
  if (!releases[repository] || !/^[1-9]\d{0,19}$/.test(runId ?? '') || !process.env.GH_TOKEN) throw new Error('Repository, run_id and read-only GitHub token are required');
  const path = `/repos/${repository}/actions/runs/${runId}`;
  const run = await githubJson(path);
  assertRun(repository, runId, run);
  const jobs = await githubJson(`${path}/jobs?filter=latest&per_page=100`);
  const artifacts = await githubJson(`${path}/artifacts?per_page=100`);
  const result = validateRunEvidence(repository, runId, run, jobs, artifacts);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
  console.log(JSON.stringify(result));
}

runCli(import.meta.url, main);
