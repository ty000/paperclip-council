"""Read-only verification of recorded M1 evidence; never invokes a model or runtime."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
p = json.loads((root / 'docs/reviews/m1-live/observation.json').read_text())
assert len(p['runs']) == len(p['reservations']) == 6
assert all(r['status'] == 'succeeded' and r['usageSource'] == 'per_run' for r in p['runs'])
assert all(r['status'] == 'settled' and r['remainingExposure'] == 0 for r in p['reservations'])
assert sum(r['inputTokens'] + r['outputTokens'] for r in p['runs']) == p['totalTokens'] == 4_231_559
assert sum(r['units'] for r in p['reservations']) == p['totalTokens']
t = p['terminalReportProof']
assert len(t['truncatedSummary']) == 500
try:
    json.loads(t['truncatedSummary'])
except json.JSONDecodeError:
    pass
else:
    raise AssertionError('Expected observed truncation to break the JSON report')
assert json.loads(t['completeFinalAgentMessage']) == p['councilReport']
assert p['correctionsUsed'] == 0 and not p['verdictApplied'] and p['pr'] is None
assert p['cleanup']['launcherExitCode'] == 0 and p['cleanup']['sessionState'] == 'stopped'
assert p['cleanup']['launcherCleanup']['ownedRuntimeRemoved']
assert hashlib.sha256((root / p['gitBundle']['path']).read_bytes()).hexdigest() == p['gitBundle']['sha256']
for evidence in p['rawEvidence']:
    assert hashlib.sha256((root / evidence['path']).read_bytes()).hexdigest() == evidence['sha256']
print('PASS: preserved observation is consistent; campaign remains BLOCKED, not delivery PASS.')
