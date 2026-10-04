#!/usr/bin/env python3
"""Verify retained M2 observations and local Git bundles; never starts a campaign."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
observation = json.loads((Path(__file__).with_name('observation.json')).read_text())
for item in observation['files']:
    data = (ROOT / item['path']).read_bytes()
    assert len(data) == item['bytes'], item['path']
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['path']
final = json.loads((ROOT / 'artifacts/ordinary-campaign-m2-final-paused.json').read_text())
runs = observation['runs']
assert len(runs) == len({r['runId'] for r in runs}) == 10
assert all(r['status'] == 'succeeded' and r['usageSource'] == 'per_run' for r in runs)
assert sum(r['units'] for r in runs) == 9_279_411
reservations = final['admission']['envelope']['reservations']
assert len(reservations) == 10
assert all(r['status'] == 'settled' and r['remainingExposure'] == {
    'units': 0, 'status': 'known', 'source': r['remainingExposure']['source']
} for r in reservations)
assert sum(r['lastKnownUsageUnits'] for r in reservations) == 9_279_411
assert final['A']['mission']['aggregate']['n2']['status'] == 'accepted'
assert final['A']['mission']['aggregate']['n2']['application']['state'] == 'observed'
assert not final['B']['mission']['aggregate'].get('n2')
assert not final['B']['mission']['aggregate']['n1'].get('candidate')
assert observation['recordedBackendBCommit'] != observation['actualBackendBCommit']
payload_hash = hashlib.sha256(json.dumps(observation['recordPayload'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
assert payload_hash == observation['recordPayloadHash']
before = json.loads((ROOT / 'artifacts/ordinary-campaign-m2-before-coordinator-transfer.json').read_text())
after = json.loads((ROOT / 'artifacts/ordinary-campaign-m2-after-coordinator-transfer.json').read_text())
for field in ['intentId', 'guardIssueId', 'reservationId', 'activationCommandId', 'startCommandId']:
    assert before['B']['mission']['aggregate']['n6'][field] == after['B']['mission']['aggregate']['n6'][field]
assert len(before['runs']) == len(after['runs']) == 5
assert not after['B']['mission']['aggregate'].get('n1')
started = json.loads((ROOT / 'artifacts/ordinary-campaign-m2-B-started-held.json').read_text())
n1 = started['B']['mission']['aggregate']['n1']
reservation = next(r for r in started['admission']['envelope']['reservations'] if r['reservationId'] == n1['activationReservationId'])
run = next(r for r in started['runs'] if r['id'] == n1['rootDispatchRunId'])
assert reservation['reservedAt'] < run['startedAt']
for name in ['pr', 'ref']:
    assert json.loads((ROOT / f'artifacts/ordinary-campaign-m2-final-{name}-readback.json').read_text()) == []
cleanup = observation['cleanup']
assert cleanup['launcherExitCode'] == 0 and cleanup['sessionState'] == 'stopped'
assert not any(cleanup[k] for k in ['runtimeExists', 'databaseExists', 'applicationPidExists', 'databasePidExists'])
assert cleanup['privateAuthFilesAbsent']
bundle = ROOT / 'artifacts/ordinary-campaign-m2-partial-B.bundle'
with tempfile.TemporaryDirectory(prefix='council-m2-evidence-git-') as directory:
    def git(*args, check=True):
        return subprocess.run(['git', '-C', directory, *args], check=check, capture_output=True, text=True)
    git('init', '--bare', '--quiet')
    git('fetch', '--quiet', str(bundle), 'refs/heads/codex/council-delivery-m2-coordination-cards:refs/heads/proof')
    git('cat-file', '-e', observation['actualBackendBCommit'] + '^{commit}')
    assert git('cat-file', '-e', observation['recordedBackendBCommit'] + '^{commit}', check=False).returncode != 0
    git('merge-base', '--is-ancestor', observation['acceptedACommit'], observation['actualBackendBCommit'])
    git('merge-base', '--is-ancestor', observation['actualBackendBCommit'], observation['frontendBCommit'])
print(f"PASS: {len(observation['files'])} artifact hashes; 10 succeeded/settled; 9279411 units; exposure 0; exact Git mismatch retained; cleanup observed. Campaign remains PARTIAL.")
