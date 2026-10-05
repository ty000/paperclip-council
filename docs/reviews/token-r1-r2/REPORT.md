# R1/R2 — bounded outputs and usage comparison

## Scope

User authorization: orchestrate the first two follow-up lots in the
[optimization backlog](../../operations/TOKEN-OPTIMIZATION-BACKLOG.md).
Base: `240c08a36bcf16a511bc807b5c2ebd23eab28d15` (PR #39), branch
`codex/token-output-comparison`. The pre-write Git base gate passed.

R1 owns one local Python utility for explicitly supplied thread snapshots,
inspection JSON and command logs. R2 owns one local Python utility comparing
two existing usage-audit reports with explicitly supplied comparison evidence.
The existing audit schema, Paperclip runtime, native permissions, models and
installed packages are outside this change. Neither tool starts a provider run.

The earlier authorized documentation update is carried forward on this branch.
Its dated recette claims apply to the five PR #38 lots, not these new utilities.

## Acceptance

| ID | Required observable behavior |
| --- | --- |
| R1-A1 | Total summary bytes, including Unicode encoding and newline, obey the configured cap; default 16 KiB |
| R1-A2 | Large saved tool outputs are projected, not echoed wholesale |
| R1-A3 | Errors/blockers outside the requested page remain signaled, or incompleteness is explicit |
| R1-A4 | Exact source digest, item/line locators and bounded pagination retain access to details |
| R1-A5 | Malformed/oversized input and unsafe output destinations are rejected |
| R2-A1 | Input without cache, cached input, output and model response counts are separated correctly |
| R2-A2 | Partial accounting or absent cohort/quality metadata yields an inconclusive comparison without savings percentages |
| R2-A3 | Incompatible workloads/configuration/coverage or stale report binding cannot support a comparison |
| R2-A4 | Functional regression cannot become a successful optimization claim |
| R2-A5 | Inconsistent reports and unsafe output destinations are rejected |
| R2-A6 | Zero baselines and same-report comparison have explicit finite semantics |

## Verification

**Complete for local implementation and review.** Both workers froze their
Python source and tests before each canonical check. Initial independent review
passed; publication review then found the R2 status/issue contradiction recorded
below. The correction is tested locally; the final exact-head review and CI
results are recorded on [PR #40](https://github.com/ty000/paperclip-council/pull/40).
The acceptance rows above are covered by the local tests, subject to the
adoption and assertion boundaries below.

Final command, executed from this worktree with isolated `COREPACK_HOME`:

```sh
COREPACK_HOME="$PWD/.runtime/token-r1-r2/corepack" node scripts/ci/run-checks.mjs
```

| Check | Final result |
| --- | --- |
| Operations | 78 tests passed, including 15 R1 and 14 R2 tests |
| Application suite | 632 passed, 1 skipped; 54 files passed |
| Typecheck | Passed |
| Build | Passed |
| Initial independent targeted replay | 26 R1/R2 tests passed before the publication correction |

The final canonical log is `.runtime/token-r1-r2/canonical-publication.log` in
`/home/davy-lp/.codex/worktrees/council-token-r1-r2/paperclip-council`.
The [evidence register](evidence.json) records exact file and log hashes.
No JavaScript/TypeScript implementation changed; the canonical checks verify
integration while the Python tests and independent review cover the new tools.
Earlier PR #38 validation counts remain historical and are not replaced by
these results on the newer PR #39 base.

## Review corrections

| Finding | Correction and revalidation |
| --- | --- |
| R1: root `hasMore=false` hid nested `page.hasMore=true` | Aggregate upstream hints; contradictory/invalid metadata yields `needs_inspection`. Dedicated regression passed. |
| R2: duplicate quality keys could override a failure; unused overflowing numbers were accepted | Reject duplicate JSON keys and recursively reject nonfinite numbers. Dedicated regressions passed. |
| R2 publication review: `exact` could coexist with an authoritative issue | Reconcile issue items with code counts and reject exact status carrying an authoritative issue, using the colocated audit contract. Three regressions cover the contradiction, count mismatch and legitimate warning-only reports. |

The initial review also checked nonscalar quality statuses, the JSON depth limit,
and stdout's byte cap including its newline before any optional output file is
created. The operator guide was checked against the reviewed behavior.

## Delivered behavior and limits

- R1 projects explicitly saved thread JSON, inspection JSON or logs, with a
  default total 16 KiB output cap, source hashes, locators and local pagination.
  Critical signals are scanned outside the displayed page; omissions and
  upstream incompleteness remain explicit. Text matching is heuristic and
  `bounded` does not certify absence of every possible blocker.
- R2 compares full `council-usage-audit.v1` artifacts, separating uncached input,
  cached input, output, reasoning, total and response counts. Missing/incompatible
  metadata or failed/unknown quality cannot produce savings percentages.
  Cohort and quality evidence are operator assertions bound to report hashes;
  the tool does not independently verify their referenced evidence.
- Smoke checks on existing saved inspection/log files produced bounded
  projections. The historical full audit report compared to itself correctly
  remains inconclusive. These checks validate local behavior, not an economy
  in model tokens. No fresh audit or provider campaign was run.

At the initial implementation checkpoint, source and documentation were ready
locally on `codex/token-output-comparison`, before commit, merge and installation.
The subsequent authorized publication and local installation must be established
by the PR state and a separate installation receipt tied to the merged commit.
Neither step integrates these helpers automatically into live tool clients. The previously installed five-lot release and its company
skill remain separate. R1 must run before a producer's output enters model
context to affect future input tokens; real adoption and before/after gains
still require their own evidence.
