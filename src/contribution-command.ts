/** Self-contained command: works in a contributor repo without a Council checkout. */
export function contributionCommand(missionId: string, contributionId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(missionId) || !uuid.test(contributionId)) throw new Error("Contribution command requires UUIDs");
  return `node --input-type=module <<'COUNCIL_RECORD_CONTRIBUTION'\n` + String.raw`
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const missionId = ${JSON.stringify(missionId)};
const contributionId = ${JSON.stringify(contributionId)};
const required = (name) => {
  if (!process.env[name]) throw new Error('Missing ' + name);
  return process.env[name];
};
try {
  const key = required('PAPERCLIP_API_KEY');
  const runId = required('PAPERCLIP_RUN_ID');
  const issueId = required('PAPERCLIP_TASK_ID');
  const endpoint = new URL('/api/plugins/private.paperclip-council/api/issues/' + encodeURIComponent(issueId) + '/council/commands', required('PAPERCLIP_API_URL'));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('diff', '--quiet');
  git('diff', '--cached', '--quiet');
  const commit = git('rev-parse', '--verify', 'HEAD^{commit}');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Expected a full Git SHA-1');
  const post = async (body) => {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Paperclip-Run-Id': runId },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      console.log(JSON.stringify({ httpStatus: response.status, body: text.replaceAll(key, '[REDACTED]') }));
      if (response.status !== 200) throw new Error('Council refused command');
      return JSON.parse(text);
    } catch {
      throw new Error('Request incomplete or refused; stop. If effect is uncertain, retain the printed payload and commandId; do not rerun or replace the key.');
    }
  };
  const inspection = await post({ command: 'inspect', missionId });
  if (inspection.missionId !== missionId || !Number.isSafeInteger(inspection.version) || inspection.version < 1) {
    throw new Error('Invalid mission inspection');
  }
  const slot = inspection.n1?.participants?.find((entry) => entry.contributionId === contributionId);
  if (!slot || slot.childIssueId !== issueId || slot.commit) throw new Error('Contribution unavailable or already recorded; inspect the existing receipt');
  if (git('rev-parse', '--verify', 'HEAD^{commit}') !== commit) throw new Error('HEAD changed during inspection');
  let proof;
  let journal;
  if (inspection.n1.proofPolicy?.protocol === 'council-proof-close-v1') {
    const participants = inspection.n1.participants, index = participants.findIndex(entry => entry.contributionId === contributionId);
    const previous = participants[index - 1];
    const segmentRootCommit = index === 0 ? inspection.n1.sourceBaseCommit : previous?.commit;
    if (!/^[a-f0-9]{40}$/.test(segmentRootCommit ?? '') || (index > 0 && !previous?.proof?.closedAt)) throw new Error('Pinned predecessor proof required');
    const directory = resolve(git('rev-parse', '--git-path', 'council-proof-intents'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    journal = join(directory, contributionId + '.json');
    // An uncertain attachment or report may never be retried with a replacement identity.
    await writeFile(journal, JSON.stringify({ missionId, contributionId, issueId, runId, commit, segmentRootCommit, state: 'upload-claimed' }), { flag: 'wx', mode: 0o600 });
    const prefix = 'refs/council/proof/' + contributionId + '/';
    git('update-ref', prefix + 'base', segmentRootCommit);
    git('update-ref', prefix + 'candidate', commit);
    const bundle = join(directory, contributionId + '.bundle');
    git('bundle', 'create', bundle, prefix + 'base', prefix + 'candidate');
    const bytes = await readFile(bundle);
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error('Child bundle exceeds bound');
    const form = new FormData(); form.append('file', new Blob([bytes]), 'contribution.bundle');
    const upload = new URL('/api/companies/' + encodeURIComponent(required('PAPERCLIP_COMPANY_ID')) + '/issues/' + encodeURIComponent(issueId) + '/attachments', required('PAPERCLIP_API_URL'));
    let attachment;
    try {
      const response = await fetch(upload, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: 'Bearer ' + key, 'X-Paperclip-Run-Id': runId }, body: form });
      if (!response.ok) throw new Error('Attachment refused');
      attachment = await response.json();
    } catch { throw new Error('Original child attachment effect refused or unknown; retain its local journal, never repeat upload'); }
    if (!/^[a-f0-9-]{36}$/i.test(attachment?.id ?? '')) throw new Error('Attachment identity unavailable; retain journal');
    proof = { attachmentId: attachment.id, expectedSha256: createHash('sha256').update(bytes).digest('hex'), segmentRootCommit };
    const fresh = await post({ command: 'inspect', missionId });
    if (fresh.missionId !== missionId || !Number.isSafeInteger(fresh.version)) throw new Error('Fresh inspection unavailable');
    inspection.version = fresh.version;
  }
  if (git('rev-parse', '--verify', 'HEAD^{commit}') !== commit) throw new Error('HEAD changed before report');
  const payload = { missionId, command: 'record-contribution', commandId: randomUUID(), expectedVersion: inspection.version, contributionId, commit, ...(proof ? { proof } : {}) };
  // Keep the exact request identity in the run log before the sole mutation.
  console.log(JSON.stringify({ request: payload }));
  if (journal) await writeFile(journal, JSON.stringify({ state: 'report-claimed', request: payload, runId, issueId }), { mode: 0o600 });
  const result = await post(payload);
  const recorded = result.mission?.aggregate?.n1?.contributions?.find((entry) => entry.contributionId === contributionId);
  if (recorded?.commit !== commit) throw new Error('Recorded commit differs; stop for readback, never substitute a reference');
  console.log(JSON.stringify({ outcome: result.outcome, contributionId, commit }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
` + "COUNCIL_RECORD_CONTRIBUTION";
}
