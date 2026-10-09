# Resumed Codex usage diagnosis — issue #86

Observation: 2026-10-09. Council source `0.7.26`,
`91b4e583abf6e1b47796a4501f07e9953175c670`. Provider-free, read-only audit of
three saved Paperclip run snapshots and their one explicitly selected Codex
session. No instance, reservation, cost, budget, ledger or historical evidence
was modified; no credit, retry or provider run was authorized by this work.

## Finding and confidence

**Confirmed on these historical traces, high confidence:** two resumed runs
label session-cumulative counters `per_run`. The 52 unique response records
independently reconstruct the three turns, with zero duplicate/conflicting
responses or parse issues. Each turn is bound to exactly one terminal Paperclip
run by session identity and its complete start/end interval. The first run's
counter equals its response sum; each resumed counter equals all preceding and
current response sums. This is stronger evidence than subtracting arbitrary
terminal counters.

| Run prefix | Responses | Reported input | Reported cache (included in input) | Reported output | Response delta total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `1b2ff8b3` | 33 | 3,674,217 | 3,514,752 | 15,111 | 3,689,328 |
| `8eed0f68` | 12 | 5,950,726 | 5,741,056 | 24,068 | 2,285,466 |
| `bf54e305` | 7 | 7,512,773 | 7,288,576 | 28,657 | 1,566,636 |

Reported total **17,205,552** versus response total **7,541,430**; analytical
excess **9,664,122**. The latter is neither refunded budget nor monetary savings.
Response accounting: input **7,512,773**, of which cache **7,288,576**, uncached
input **224,197**, output **28,657**. Unknown selected runs: **0**. Codex
supervision/repair assistance: **not selected, unknown, separate scope**.
These three lead runs are not the complete mission or an autonomy benchmark.

## Identity, versions and mechanism

The session is `01a1184d-7cca-7ea2-9e15-17aeb9bcaf75`. Its saved metadata says
`cli_version=0.160.1`, `source=exec`, `originator=codex_exec`. Its 426 records
contain three `task_started`/`task_complete` pairs and 52 response usage records.
The saved terminal run snapshots report adapter `codex_local`, the same agent,
`freshSession=true` for the first run, then `sessionReused=true` and the same
before/after session. Raw counters equal reported counters in all three.

The [Codex 0.160.1 JSONL processor](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
constructs completed-turn usage from `usage.total`. The inspected Paperclip
source checkout at `61b3fd57a695614dc4a37e2303f426a34a9795cf`, adapter package `0.3.1`,
copies these values and returns `usageBasis: "per_run"` in
`packages/adapters/codex-local/src/server/parse.ts:77–101`. The heartbeat path
at `server/src/services/heartbeat.ts:11998–12006` bypasses session normalization
when that basis is declared. Source file hashes are in [evidence.json](evidence.json). The local
9 October Council installation receipt is
`~/.local/share/paperclip-council/deployments/2026-10-09-91b4e58/installation-check.json`
and its `PROOF.md`. A read-only `/api/health` observation on port 3210 returned
`status=ok`, `commit=null`; it does not independently pin deployed adapter
bytes. The checkout SHA and source hashes identify inspected source only. This
later installation receipt is not a historical binary pin for the 7 October runs.

The historical adapter executable/revision and each resumed CLI process's
binary hash were not pinned in run snapshots (`driverVersion=null`). Metadata
identifies the session-creating CLI, not a cryptographic proof of every resumed
binary. **This limits binary attribution, not the measured discrepancy:**
actual saved counters independently match the same session's response sums.
The mechanism remains present in inspected current host source; no claim is
made that a new deployment or a future version has been qualified or corrected.

## Compatible treatment and remaining limitation

This lot supplies an explicit operational limitation, not a new accounting
engine. Council's `exactRunUsageUnits` accepts the host's `per_run` label;
Council cannot establish the label's semantics from it alone. A terminal
resumed Codex counter must not be advertised as an independently qualified
per-run measurement or used to claim efficiency/autonomy improvements.
Historical settled units, exposure and reservations remain as recorded.

No runtime normalization is added: public run readback does not provide a
versioned, authoritative baseline contract, and an operator's local analysis
is not a settlement source. No second ledger or Paperclip/SDK change is added.
No continued native wake is silently converted into a new session: that would
change execution continuity and require separate qualification. The SDK wake
contract in use is not treated as accepting the host's internal
`forceFreshSession` field.

For a future **already authorized** lot, either establish and read back a fresh
session at each separately admitted run through a supported host lifecycle, or
qualify a host correction against known response deltas. If continuity requires
resumption, retain the host accounting for control and report response analysis
separately with this limitation. Never reset a session mid-run or credit a
budget to make a blocked campaign continue. A future correction is not proven
merely by changing `usageSource` to `session_delta`; Council's current exact
settlement contract rejects that source too.

## Reproduction and privacy

Use the source checkout's existing `usage_audit.py` and new
`resumed_usage_audit.py`. The latter delegates response deduplication to the
former and reads only the explicit selected files; no directory discovery,
network, prompt forwarding, credentials or provider calls. Output contains
usage, selected identities, hashes and classifications, never message/tool
content. Inspect any output before publication: selected IDs are still metadata.

Private source directory used here:
`~/.local/share/paperclip-council/missions/content-assistant-next-2026-10-07/private`.
The run snapshot names are
`supervision-20261008T085020-<full-run-id>-run.json`; the three full run IDs and
SHA256 hashes are in the committed evidence. Session source:
`~/.paperclip/instances/council-local/companies/587884dc-195c-4555-8db9-9f3d9541b373/codex-home/sessions/2026/10/07/rollout-2026-10-07T23-38-14-01a1184d-7cca-7ea2-9e15-17aeb9bcaf75.jsonl`.
Its complete selected prefix is 5,462,701 bytes, SHA256
`6382a17f7c376597599feeff8fffdcf73a79d8c030243e2030ffc3414e72d71d`.
The raw snapshots and session remain private and are not committed.

```sh
python3 scripts/operations/resumed_usage_audit.py \
  --session /absolute/path/to/selected-session.jsonl \
  --run /absolute/path/to/first-run.json \
  --run /absolute/path/to/resumed-run.json \
  --run /absolute/path/to/next-resumed-run.json \
  --output /absolute/path/to/new-report.json
python3 -m unittest discover -s tests/operations -p 'test_resumed_usage_audit.py'
```

Exact repeated run snapshots and duplicate response records do not add usage.
Conflicting snapshots or ambiguous turn bindings are refused. Missing terminal
usage, version, identity, complete turn interval or cumulative baseline is
non-conclusive; the aggregate is `null`, never fabricated zero. The report
exits 0 for a confirmed discrepancy or per-run match, 1 for non-conclusive or
refused input; inspect `conclusion`, since successful analysis is not a verdict
that the host is fixed. `per_run_confirmed` on future traces means only those
selected traces match, not that all host versions are corrected.

## Next comparable lot (still outstanding)

Run this read-only report on the next authorized comparable lot's selected
snapshots/session(s), keeping each session report separate. Preserve workload,
model/effort, quality evidence, retries and interventions with the existing
`usage_compare.py` cohort contract. Select supervision/repair sessions explicitly
into their own `usage_audit.py` report; absent assistance data stays unknown.
Distinguish native observed response consumption, host budget/control totals,
assistance and any hypotheses. A future real comparable-lot report remains to
be produced; this diagnostic and its replayable tooling do not invent a gain,
autonomy rate, billing price or completion of that acceptance criterion.
