/** Self-contained command: works in a contributor repo without a Council checkout. */
export function contributionCommand(missionId: string, contributionId: string): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(missionId) || !uuid.test(contributionId)) throw new Error("Contribution command requires UUIDs");
  return `node --input-type=module <<'COUNCIL_RECORD_CONTRIBUTION'\n` + String.raw`
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  const payload = { missionId, command: 'record-contribution', commandId: randomUUID(), expectedVersion: inspection.version, contributionId, commit };
  // Keep the exact request identity in the run log before the sole mutation.
  console.log(JSON.stringify({ request: payload }));
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
