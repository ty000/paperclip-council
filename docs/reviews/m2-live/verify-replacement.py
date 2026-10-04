#!/usr/bin/env python3
"""Read-only verification of this bounded observation and preserved evidence."""
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[3]
obs = json.loads((root / 'docs/reviews/m2-live/replacement-observation.json').read_text())
for item in obs['evidence']:
    data = (root / item['path']).read_bytes()
    assert len(data) == item['bytes'], item['path']
    assert hashlib.sha256(data).hexdigest() == item['sha256'], item['path']
for name, key in [('observation.json', 'files'), ('continuation-observation.json', 'evidence')]:
    for item in json.loads((Path(__file__).parent / name).read_text())[key]:
        assert hashlib.sha256((root / item['path']).read_bytes()).hexdigest() == item['sha256']
assert obs['runs'] == obs['settled'] == 18
assert obs['knownTokenUnits'] == 13863240 and obs['remainingExposure'] == 0
assert obs['nativeN2Status'] == 'reviewing' and obs['verdictApplied'] is False
assert obs['councilVerdict']['verdict'] == 'changes_requested'
assert obs['candidateCommit'] == obs['councilVerdict']['subject']['candidateCommit']
assert obs['applicationRefusal'] == 'correction_limit_exceeded' and obs['correctionsUsed'] == 1
assert obs['deliveryPR'] is None and obs['browserObservation'] is None
assert all(obs['cleanup']['portsClosed'].values()) and all(obs['cleanup']['ownedPathsAbsent'].values())
for run_id in obs['newRunIds']:
    record = json.loads((root / f'artifacts/ordinary-campaign-m2-replacement-run-{run_id}.json').read_text())
    assert record['run']['id'] == record['log']['runId'] == run_id
    assert record['run']['status'] == 'succeeded'
    assert len(record['log']['content'].encode()) == record['run']['logBytes']
    assert 'turn.completed' in record['log']['content']
print('PASS: 37 evidence hashes; 54 historical hashes; 18 settled runs; V2 rejected; owned cleanup')
