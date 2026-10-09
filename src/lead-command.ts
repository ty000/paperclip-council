export function leadCommandsFor(missionId: string, state: { candidate?: unknown; contributions: readonly { issueState: string }[] }) {
  if (state.candidate || state.contributions.length && state.contributions.every(slot => slot.issueState !== "planned")) return {};
  return { leadCommands: { protocol: "council-lead-commands-v1", shell: leadCommand(missionId),
    usage: "Use inspect first on the current lead task. Set COUNCIL_LEAD_OPERATION=plan; pinned hierarchy leaves need no input, otherwise COUNCIL_LEAD_INPUT is a JSON file with two business contributions (assigneeAgentId, title, ownedPaths). For materialize, set COUNCIL_LEAD_INPUT to the one-based participant index. Never invent command IDs/versions or replace a journaled uncertain intent. Execution documents are created after the plan, for contributors." } };
}

/** Executable native lead handoff. Business content is input; transport identity is generated and journaled. */
export function leadCommand(missionId: string) {
  return `node --input-type=module - "\${COUNCIL_LEAD_OPERATION:-inspect}" "\${COUNCIL_LEAD_INPUT:-}" <<'COUNCIL_LEAD_COMMAND'
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const missionId = ${JSON.stringify(missionId)};
let key;
try {
  const required = name => { const v = process.env[name]; if (!v) throw new Error('Missing ' + name); return v; };
  key = required('PAPERCLIP_API_KEY');
  const runId = required('PAPERCLIP_RUN_ID'), issueId = required('PAPERCLIP_TASK_ID');
  const operation = process.argv[2], input = process.argv[3];
  if (!['inspect', 'plan', 'materialize'].includes(operation)) throw new Error('Only inspect, plan or materialize is supported');
  const endpoint = new URL('/api/plugins/private.paperclip-council/api/issues/' + encodeURIComponent(issueId) + '/council/commands', required('PAPERCLIP_API_URL'));
  const post = async payload => {
    try {
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + key, 'X-Paperclip-Run-Id': runId }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error('refused');
      return await response.json();
    } catch { throw new Error('Original request refused or outcome unknown; inspect and retain its identity, never repeat with a new commandId'); }
  };
  const view = await post({ command: 'inspect', missionId });
  if (view.missionId !== missionId || !Number.isSafeInteger(view.version) || view.version < 1 || !Array.isArray(view.n1?.participants)) throw new Error('Invalid fresh inspection');
  if (operation === 'inspect') console.log(JSON.stringify({ missionId, version: view.version, n1: view.n1 }));
  else {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const leaves = view.n1.hierarchy?.leaves;
    if (leaves && view.n1.coordinationIssueId !== issueId) throw new Error('Use the original coordinator task');
    let slot;
    if (operation === 'materialize') {
      if (!/^[1-9][0-9]?$/.test(input ?? '')) throw new Error('Select the existing participant by its one-based inspection index');
      slot = view.n1.participants[Number(input) - 1];
      if (!slot) throw new Error('Participant unavailable');
    }
    const directory = resolve(git('rev-parse', '--git-path', 'council-lead-intents'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journal = join(directory, missionId + '-' + operation + (slot ? '-' + slot.contributionId : '') + '.json');
    const prior = await readFile(journal, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
    if (prior) {
      console.log(JSON.stringify({ retainedRequest: prior.request, observedVersion: view.version, participants: view.n1.participants }));
      throw new Error('An original intent exists; read back its receipt with the owner before any exact replay. No replacement command is sent');
    }
    let contributions, sourceBaseCommit;
    if (operation === 'plan') {
      if (view.n1.participants.length) throw new Error('Plan already exists; inspect it');
      if (leaves) contributions = leaves.map(({ contributionId, assigneeAgentId, title, ownedPaths }) => ({ contributionId, assigneeAgentId, title, ownedPaths }));
      else {
        const bytes = await readFile(input);
        if (bytes.length > 65536) throw new Error('Business plan exceeds bound');
        const business = JSON.parse(bytes);
        if (!Array.isArray(business.contributions) || business.contributions.length !== 2) throw new Error('Business plan must contain exactly two contributions');
        contributions = business.contributions.map(({ assigneeAgentId, title, ownedPaths }) => ({ contributionId: randomUUID(), assigneeAgentId, title, ownedPaths }));
      }
      if (view.n1.proofPolicy?.protocol === 'council-proof-close-v1') {
        sourceBaseCommit = git('rev-parse', '--verify', 'HEAD^{commit}');
        if (!/^[a-f0-9]{40}$/.test(sourceBaseCommit)) throw new Error('Full source base commit required');
      }
    } else if (slot.issueState !== 'planned') throw new Error('Materialization already claimed or confirmed; inspect the original receipt');
    const request = { missionId, command: operation, commandId: randomUUID(), expectedVersion: view.version,
      ...(contributions ? { contributions } : { contributionId: slot.contributionId }), ...(sourceBaseCommit ? { sourceBaseCommit } : {}) };
    await writeFile(journal, JSON.stringify({ request, issueId, runId }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ request }));
    if (sourceBaseCommit && git('rev-parse', '--verify', 'HEAD^{commit}') !== sourceBaseCommit) throw new Error('Source HEAD changed; retain the original intent');
    const result = await post(request), state = result.mission?.aggregate?.n1;
    if (!['applied', 'replayed'].includes(result.outcome) || result.mission?.missionId !== missionId || !Array.isArray(state?.contributions)) throw new Error('Transport succeeded without the expected business result; retain the intent');
    if (contributions) {
      const observed = state.contributions.map(({ contributionId, assigneeAgentId, title, ownedPaths }) => ({ contributionId, assigneeAgentId, title, ownedPaths }));
      if (JSON.stringify(observed) !== JSON.stringify(contributions) || sourceBaseCommit && state.sourceBaseCommit !== sourceBaseCommit) throw new Error('Recorded plan differs; retain the intent');
    } else if (!state.contributions.some(item => item.contributionId === slot.contributionId && item.issueState === 'confirmed')) throw new Error('Materialization not confirmed; retain the intent');
    console.log(JSON.stringify({ outcome: result.outcome, missionId, version: result.mission.version }));
  }
} catch (error) {
  console.error(key ? String(error.message).replaceAll(key, '[redacted]') : error.message);
  process.exitCode = 1;
}
COUNCIL_LEAD_COMMAND`;
}
