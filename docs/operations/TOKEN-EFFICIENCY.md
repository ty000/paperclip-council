# Token-efficiency operator guide

These standard-library Python utilities make selected Council operations bounded
and replayable. They are local tools: their presence does not install, activate,
deploy, or natively qualify them. An operator chooses every source and starts
every command; the tools do not discover inputs, credentials, or transfer limits.

The five initial lots were merged in PR #38 and separately installed on
`council-local` on 2026-10-05. See the dated
[delivery and recette evidence](../reviews/token-small-lots/REPORT.md#recette-installation-follow-up-2026-10-05)
and the [updated optimization backlog](TOKEN-OPTIMIZATION-BACKLOG.md).
This recorded deployment does not imply automatic use or measured token savings.

Use Python 3.10 or newer. The verified local run used Python 3.11.2. Paths and
identifiers in the examples are placeholders; replace every value under
`/absolute/path`, every `MISSION_ID`, and every SHA before running them.

## Local command installation

These tools are distributed from the reviewed Git commit; `package.json` does
not include them in the Council npm package. Install their unchanged source,
operations tests, and guide in a separate versioned directory, for example
`~/.local/share/paperclip-council/operations/releases/<merged-commit>`.
Keep that release when removing a development worktree.

The following commands can be exposed in `~/.local/bin` as thin wrappers that
execute `python3 <absolute-release>/scripts/operations/<script>` and forward
all arguments unchanged:

| Local command | Script |
| --- | --- |
| `council-usage-audit` | `usage_audit.py` |
| `council-watch` | `mission_watch.py` |
| `council-context-packet` | `context_packet.py` |
| `council-transfer-preflight` | `transfer_preflight.py` |
| `council-compact-output` | `compact_output.py` |
| `council-usage-compare` | `usage_compare.py` |

Before exposing commands, verify each installed file against the exact merged
commit and run `python3 -m unittest discover -s tests/operations -p 'test_*.py'`
from that release. Verify each installed command with `--help`, record the
commit, hashes, and results in an installation receipt, and preserve any
pre-existing command paths. Installation alone does not start an observer,
change a Paperclip instance, or schedule a provider run.

## Paperclip agent installation recorded on 2026-10-05

The deployment imported a self-contained `council-token-operations` company skill
and selected it for the seven Council agents. The native skill key is
`local/47824fb670/council-token-operations`; its five Python scripts match
reviewed commit `ef817493bf99606d324cac6ef572c23de839a9ab` byte for byte.
In that package the scripts live in `scripts/`, so resolve their paths relative
to the loaded `SKILL.md`; repository examples below use `scripts/operations/`.

Existing instructions were preserved with a short additive reference to the
skill. Native adapter injection was verified in seven isolated profiles, and
all four CLI entrypoints passed `--help`. The adapter reports `ephemeral` mode:
the selected skills are linked into the effective profile on the next authorized
run. No actual agent run was started to test loading or measure savings.

Keep the imported source directory referenced by the company library. Its native
version ID is null; the installation receipt records the verified file hashes.
A future managed-defaults reset must preserve or explicitly reapply the additive
instruction reference. Presence in the library and `desiredSkills` are distinct
from loading and use by a model.

Agent use remains within the assigned task. Prefer supplied snapshots for mission
observation; a board-only API requires board authority. Agents must never reuse
operator cookies. Usage audits require explicit authorization for each session
file. Installation does not authorize resume, wakeups or provider spending.

## Manual adoption sequence

1. Run `transfer_preflight.py` before handing off an exact Council candidate
   bundle.
2. Run one `mission_watch.py` process for a selected mission while work is in
   progress. Keep its state file private to that process.
3. Build a `context_packet.py` packet when another bounded run needs the durable
   checkpoint. Run `usage_audit.py` when response-level accounting is needed.
4. Project explicitly saved thread/inspection/log output with `compact_output.py`
   before returning it to model context. Compare full usage reports with
   `usage_compare.py` only when cohort and quality evidence is available.
5. Preserve the source inputs and evidence artifacts. Review nonzero exits and
   reported unknowns instead of retrying blindly.

This manual, provider-free sequence does not provide an exactly-once guarantee.
Allowlisted projections and secret-field checks reduce model context, but do not
prove that every sensitive value is excluded. No measured token reduction is claimed.

## Audit finite session usage

`usage_audit.py` reads only the absolute JSONL files named by repeated
`--session` arguments. It never searches a session directory. `--prefix-bytes`
freezes one selected file at an exact byte boundary and is valid only with one
session. Use a finished prefix for exact accounting; this is not an instantaneous
budget measurement for a session that is still active.
Choose a boundary after a complete JSONL record. Without an explicit prefix,
the opened file size bounds the read; a size change observed before closing
produces `source_changed_during_read` and `partial`, without chasing new data.

```sh
SESSION_JSONL=/absolute/path/to/selected-session.jsonl
REPORT_JSON=/absolute/path/to/new-usage-report.json
python3 scripts/operations/usage_audit.py --session "$SESSION_JSONL" \
  --prefix-bytes 123456 \
  --output "$REPORT_JSON"
```

Compact stdout contains status, source prefix byte counts and hashes, response
counts, conflicts, usage totals, and issue counts. The optional
`council-usage-audit.v1` report adds thread/turn totals, bounded issue locations,
and lower-confidence `token_count` snapshots.
The output path is created exclusively with private permissions; an existing
file, symlink, hardlink name, or selected input is refused.

Only unique `token_usage_record.usage` deltas keyed by thread, session, and
response are summed. Exact `compacted.latest_token_usage_record` references are
reported as duplicates. Conflicting identities are reported and excluded.
Cached input is already part of input, and reasoning output is already part of
output. Cumulative `token_count` events are never added together or mixed with
context-window sizes; only the latest valid snapshot per source is retained as
a separate fallback.

Exit `0` means authoritative response accounting is exact. Exit `1` means the
accounting is partial or unavailable, or an audit/output refusal occurred.
Argument parsing errors use the normal argparse exit `2`. Malformed and unknown
records remain visible in the report rather than becoming zero usage.

## Observe one selected mission

`mission_watch.py` accepts either a provider-free JSON snapshot or one explicit
mission GET URL. Snapshot mode cannot be combined with API options. The input
object is capped at 4 MiB and must contain the selected mission ID.
For example, a minimal offline snapshot has this shape (runs and admission
are optional; their absence is reported as `not_requested`):

```json
{
  "mission": {
    "missionId": "MISSION_ID",
    "aggregate": {"phase": "reviewing", "control": {"status": "active"}}
  }
}
```

```sh
SNAPSHOT_JSON=/absolute/path/to/replaceable-mission-snapshot.json
OBSERVER_STATE=/absolute/path/to/private-observer-state.json
EVIDENCE_DIR=/absolute/path/to/existing-evidence-directory
MISSION_ID=replace-with-exact-mission-id
python3 scripts/operations/mission_watch.py --snapshot "$SNAPSHOT_JSON" \
  --mission-id "$MISSION_ID" --state "$OBSERVER_STATE" \
  --evidence-dir "$EVIDENCE_DIR" \
  --wait-for-change
```

For API mode, supply every read endpoint explicitly. `--run-url` is repeatable
for at most 32 selected runs, and `--admission-url` is optional. The observer
does not derive either endpoint from the mission response. All URLs must share
one origin; remote URLs require HTTPS, redirects are refused, and HTTP is
accepted only for loopback hosts.

Provision the credential in the environment outside the command, then pass only
its variable name:

```sh
MISSION_URL=https://paperclip.example.invalid/api/explicit-mission-view
RUN_URL=https://paperclip.example.invalid/api/explicit-run-view
ADMISSION_URL=https://paperclip.example.invalid/api/explicit-admission-view
OBSERVER_STATE=/absolute/path/to/private-api-observer-state.json
EVIDENCE_DIR=/absolute/path/to/existing-evidence-directory
MISSION_ID=replace-with-exact-mission-id
# COUNCIL_OBSERVER_API_KEY must already exist in the process environment.
python3 scripts/operations/mission_watch.py --mission-url "$MISSION_URL" \
  --run-url "$RUN_URL" --admission-url "$ADMISSION_URL" \
  --api-key-env COUNCIL_OBSERVER_API_KEY --mission-id "$MISSION_ID" \
  --state "$OBSERVER_STATE" \
  --evidence-dir "$EVIDENCE_DIR" \
  --wait-for-change
```

Never put a credential value in an argument or URL. `--api-key-env` names the
environment variable; it is not the credential itself.

The durable state is bound to the exact source selection. Reuse it from one
observer process; concurrent writers are not coordinated. Content-addressed
private evidence uses the `council-observation.v1` allowlist: phase/control,
candidate/review identity, correction wake/application/settlement, opinion and
specialist outcomes, transmission usage state, publication readiness and native
readback freshness, contributions/tasks, selected runs, and admission status.
Raw logs and arbitrary response fields are outside the projection; unexpected
long or structured values become digests. A raw snapshot fallback preserves
reported canonical states but does not calculate temporal freshness itself.

With `--wait-for-change`, the first valid read establishes a silent baseline;
the process continues until a meaningful change. `--once` emits the selected
view immediately. Running token ticks and timestamps do not cause a change,
while terminal usage and unknown states remain meaningful. Exit `0` emits one
initial or changed event, exit `2` emits a bounded error, and exit `3` emits a
distinct timeout event with `changed: false`.

Supported bounds are 1–10,000 polls, 512–65,536 output bytes, positive polling
interval and polling timeout up to 3,600 seconds, and positive per-request timeout
up to 60 seconds. Defaults are 120 polls, 4,096 bytes, 5-second interval,
300-second polling timeout, and 10-second request timeout. The polling timeout is
checked between collections; a sequence of bounded GETs may extend wall time, so
it is not a strict wall-clock SLA.

## Project a durable context packet

`context_packet.py` reads one existing durable checkpoint and one exact subject
file. Both inputs remain unchanged. The subject object must contain exactly four
non-empty string fields:

```json
{
  "repoPath": "/absolute/path/to/repository",
  "baseSha": "0000000000000000000000000000000000000000",
  "candidateSha": "1111111111111111111111111111111111111111",
  "missionId": "MISSION_ID"
}
```

The SHAs are 40- or 64-character hexadecimal strings. They and the absolute
repository path are copied as `supplied_unverified`; the tool does not inspect
Git or grant authority.

```sh
DURABLE_STATE=/absolute/path/to/existing-durable-checkpoint.json
SUBJECT_JSON=/absolute/path/to/exact-subject.json
PACKET_JSON=/absolute/path/to/new-context-packet.json
python3 scripts/operations/context_packet.py --state "$DURABLE_STATE" \
  --subject "$SUBJECT_JSON" --max-bytes 32768 \
  --output "$PACKET_JSON"
```

The checkpoint requires `objective`, `current_gate`, `next_action`,
`next_checkpoint`, a `mandate` object, and the essential arrays
`stop_conditions`, `hard_constraints`, `budgets`, `decisions`, `unknowns`,
`open_risks`, `owners`, and `volatile_state`, plus optional-but-present arrays
`known_facts`, `evidence_collected`, and `files_touched`. Known secret/log field
names and recognized credential patterns are rejected.

The source mandate requires a non-empty `current` string and a
`superseded_instructions` array. The packet retains `current`, normalizes that
array to `supersededInstructions`, and preserves every other mandate key/value
under essential `sourceExtensions`. A source key also named `sourceExtensions`
remains nested there, so name collisions never discard a clause.

The state limit is 1 MiB, subject limit 64 KiB, arrays 1,000 items, nesting 20
levels, and `--max-bytes` must be 512 bytes–1 MiB.
The `council.context-packet.v1` output preserves all essential safety and
identity fields. It drops only optional tail items, recording counts, source
references, and included/omitted ranges. If essential data does not fit, the
command fails instead of truncating it. The output must be a new file distinct
from both inputs. Exit `0` writes the packet and its byte/content/semantic
digests; exit `2` reports a bounded construction or write error.

## Preflight an exact transfer bundle

`transfer_preflight.py` validates a clean Council worktree, exact base/candidate,
and a self-contained Git bundle without a provider call. Both refs are distinct
lowercase 40-character commit IDs. HEAD must be the candidate, the base its
ancestor, and the bundle must advertise matching `refs/heads/base` and
`refs/heads/candidate` commits.

```sh
COUNCIL_REPO=/absolute/path/to/clean-council-worktree
BUNDLE=/absolute/path/to/exact-candidate.bundle
CACHE_DIR=/absolute/path/to/existing-external-cache
REPORT_JSON=/absolute/path/outside-repository/new-transfer-report.json
BASE_SHA=0000000000000000000000000000000000000000
CANDIDATE_SHA=1111111111111111111111111111111111111111
MAX_ATTACHMENT_BYTES=104857600
python3 scripts/operations/transfer_preflight.py --repo "$COUNCIL_REPO" \
  --bundle "$BUNDLE" --base "$BASE_SHA" --candidate "$CANDIDATE_SHA" \
  --max-attachment-bytes "$MAX_ATTACHMENT_BYTES" \
  --cache-dir "$CACHE_DIR" --output "$REPORT_JSON"
```

At least one repeatable `--cache-dir` must exist, be writable, contain no symlink
component, and sit outside the repository. It receives an exclusive
write/read/delete probe.
The positive attachment limit is always operator-supplied. Git commands use
isolated configuration, file-only transport, disabled prompts/hooks, and a
15-second per-command timeout. The bundle is verified and fetched into a new
empty bare repository, then checked for exact identity, object completeness,
and ancestry.

Stdout is a `council-transfer-preflight.v1` report with `pass` or `blocked`
status and named checks. Optional `--output` creates a private new report outside
the source repository and bundle; existing destinations and symlink paths are
refused. Exit `0` means every check passed, exit `1` means blocked, and argparse
uses exit `2` for invalid command syntax.

## Operational boundary

The R1/R2 follow-up utilities below are additional local source tools. They are
not part of the earlier PR #38 installation receipt or its company skill.
Their validation and review are recorded in the
[R1/R2 report](../reviews/token-r1-r2/REPORT.md).

### Compact saved thread, inspection and log outputs (R1)

`compact_output.py` consumes one explicitly supplied local file. It makes no API
call, discovers no source and executes none of the input. Supported modes are:

- `thread`: a saved Codex `read_thread` object with a `turns` array;
- `inspection`: a saved JSON object or collection, such as a Paperclip inspection;
- `log`: one UTF-8 command log, with replacement markers for invalid text bytes.

```sh
python3 scripts/operations/compact_output.py \
  --mode thread --input /absolute/path/read-thread.json \
  --cursor 0 --page-size 20 --max-bytes 16384 \
  --output /absolute/path/new-thread-summary.json
```

The `council.compact-output.v1` JSON stdout and optional artifact have the same
bytes, capped at 16 KiB by default including the newline. The configurable output
range is 2 KiB–1 MiB; input defaults to 8 MiB and may be raised explicitly to
64 MiB. JSON nesting is capped at 32 levels; duplicate keys and nonfinite numbers
are refused. Page size is 1–100 (default 20).

The summary contains the source's absolute path, SHA-256 and byte length; every
item has a JSON pointer or one-based line locator. Full detail stays in the
original file: keep those bytes unchanged and verify its hash before using a
locator. A summary is a projection, not a replacement for archived evidence.

Local pagination uses the numeric `pagination.nextCursor` over the supplied
file. Upstream cursor/`hasMore` metadata describes other pages that were never
supplied; the tool does not fetch them. Contradictory metadata, invalid pagination
types or evidence of an upstream page produce `needs_inspection`. If the output
budget leaves no room for one item, `pageBlocked` is true and the local next
cursor is null; increase the explicit budget or inspect the source instead of
repeating the same page.

Structured errors and critical text patterns are scanned beyond the displayed
page, including nested tool results. Signal samples are bounded; omitted samples
remain counted and produce `needs_inspection`. Text matching is heuristic and
can flag quoted errors or test names. `bounded` describes the projection, never
successful execution or absence of every possible blocker. Redaction covers
known credential forms only; it does not certify that arbitrary text is public.

Exit `0` means the summary was produced, including a possible `needs_inspection`
status; callers must read that status. Exit `2` means invalid input or a failed
output operation. An output must be new and is created with mode `0600`; existing
destinations, symlinks and the input path are refused.

### Compare explicit usage reports (R2)

`usage_compare.py` accepts two **full** `council-usage-audit.v1` reports written
by `usage_audit.py --output`. Its compact stdout alone is not a report input.
The comparator never reads session directories or uses cumulative fallback
snapshots. Keep `usage_audit.py` beside `usage_compare.py`: it supplies the
authoritative issue-code contract. Issue items must reconcile with their code
counts, and an `exact` report carrying an authoritative issue is rejected. Each report is limited to 4 MiB and the comparison manifest to 64 KiB.

```sh
python3 scripts/operations/usage_compare.py \
  --before /absolute/path/before.report.json \
  --after /absolute/path/after.report.json \
  --comparison /absolute/path/comparison.json \
  --output /absolute/path/new-comparison.report.json
```

The comparison manifest has this shape. Replace every placeholder with factual
data; its statuses do not authorize inventing a successful quality check.

```json
{
  "schema_version": "council-usage-comparison-input.v1",
  "reports": {
    "before_sha256": "SHA256_OF_EXACT_BEFORE_REPORT_BYTES",
    "after_sha256": "SHA256_OF_EXACT_AFTER_REPORT_BYTES"
  },
  "cohort": {
    "before": {
      "scope_id": "same-workload-and-acceptance-criteria",
      "task_count": 2,
      "coverage_id": "same-accounting-coverage",
      "configuration_id": "same-comparison-controls",
      "data_ref": "/absolute/path/before-case-index.json"
    },
    "after": {
      "scope_id": "same-workload-and-acceptance-criteria",
      "task_count": 2,
      "coverage_id": "same-accounting-coverage",
      "configuration_id": "same-comparison-controls",
      "data_ref": "/absolute/path/after-case-index.json"
    },
    "evidence_refs": ["/absolute/path/cohort-review.json"]
  },
  "quality": {
    "before_status": "unknown",
    "after_status": "unknown",
    "evidence_refs": ["/absolute/path/quality-review.json"]
  }
}
```

Both cohorts must match on scope, task count, accounting coverage and fixed
configuration controls. Record the intended optimization and candidate identities
in the referenced case evidence; a changed model, effort or coverage cannot be
silently treated as equivalent. Data references can differ. References and
quality statuses are **operator assertions**, not independently verified by this
tool: it does not open those references or establish functional quality itself.
Report hashes bind the assertions to the exact reports being compared.

Only two exact reports with compatible metadata and both quality statuses `pass`
permit a conditional numerical comparison. Missing metadata, `partial` or
`unavailable` usage, different cohorts, stale hashes, quality `fail`/`unknown`,
or identical report bytes produce `inconclusive` without savings percentages.
Malformed or internally inconsistent reports are input errors, not zero usage.

The `council-usage-comparison.v1` result separates input without cache, cached
input, output, reasoning output, total and unique response count. Cached input
and reasoning remain subsets. Deltas use **after minus before**; reduction
percentages use **(before minus after) / before**, as four-decimal strings.
A zero baseline gives a null percentage for that metric. A mixed or increased
usage profile is reported separately from an optimization supported by operator
assertions. No price, complete parent/child accounting or provider saving is
inferred.

Exit `0` means a comparison is conclusive under those supplied assertions, not
necessarily an improvement. Exit `1` means inconclusive; exit `2` means invalid
input or failed output. Stdout is capped at 16 KiB, while `--output` optionally
writes the full report to a new private file. Existing files, symlink names and
input aliases are not overwritten. Neither this tool nor its tests establish
the real savings from deploying R1/R2.

## Evidence and adoption boundary

Keep sessions, checkpoints, repositories, and bundles immutable during each
read. A snapshot producer may atomically replace its file between observer polls;
each individual read remains bounded. Use new evidence/report/packet paths except
for the observer state file updated by its one owning process.
Treat digests, supplied identities, and provider-free replays as evidence of the
named local checks only. They do not prove model quality, delivery, installation,
runtime activation, native integration, or production readiness.
