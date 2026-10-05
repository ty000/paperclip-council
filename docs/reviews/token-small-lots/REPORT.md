# Token-efficiency small lots report

## Scope and result

This local implementation completes the five approved bounded small lots from clean base
`51589d79393b93826433c94f9cb1d1585de3bb99` on branch
`codex/council-token-small-lots`:

| Lot | Backlog start | Local result |
| --- | --- | --- |
| S1 | OPT-01 + baseline OPT-16 | Finite response-usage audit and frozen source-prefix baseline |
| S2 | OPT-06 | Compact allowlisted observation and bounded change-event output |
| S3 | Beginning of OPT-02 | Change-driven mission observer with provider-free snapshot and explicit GET modes |
| S4 | OPT-04 + beginning of OPT-07 | Bounded packet projection from an existing durable checkpoint and exact subject |
| S5 | Beginning of OPT-09 | Exact candidate/bundle and external-cache transfer preflight |

The M/L lots and the complete optimization backlog remain outside this scope.
The implementation evidence below records the reviewed package. A subsequent,
separately verified local and recette installation is recorded at the end of
this report; repository presence alone is not deployment or runtime proof.

## Verification

- `.runtime/token-small-lots/pr38-canonical.log`: PASS for 49 operations
  tests, typecheck, 474 application tests, and build.
- `.runtime/token-small-lots/pr38-static.log`: PASS with no blocking finding.
  One inherited, nonblocking complexity finding remains at
  `scripts/ci/run-checks.mjs:44`.
- The observed Python runtime was 3.11.2; the utilities target Python 3.10 or
  newer and add no dependency.

The compact [evidence register](proof.json) binds source and evidence hashes for
the reviewed package without copying raw logs into the repository documentation.
It uses this utility's custom schema; it is not a canonical Proof Manifest V1.
Cross-review findings were corrected with regression tests: canonical mission
readiness/unknown states, preservation of additional mandate clauses, growth
during an implicit session read, contradictory session metadata, and compaction
reference counting independent of input order. PR #38 reviewers additionally
identified and corrected missing thread identity and omitted N3 synthesis
subject/status/verdict transitions. The final checks above include
these corrections. Python tests complement the JS/TS-only static audit.

The usage baseline in `.runtime/token-small-lots/pr38-usage-baseline.json` freezes
session `01a0f3fd-4008-7a60-98ed-b7ab68d5f444` at 136,844,077 bytes with source
prefix SHA-256
`bb49002cd92947844627e149f6f2b35efe7a98a9305cbb413393ee3160f04608`.
It reports 3,286 unique responses, 37 duplicate compaction references, zero
conflicts, and 446,205,730 total tokens: 444,331,062 input, 432,377,344 cached
input, 1,874,668 output, and 630,813 reasoning output. Cached input is a subset
of input and reasoning output is a subset of output. Thirty-nine internally
inconsistent cumulative fallback snapshots are reported separately and never
mixed into these response-delta totals.

The synthetic, provider-free replay in
`.runtime/token-small-lots/pr38-observer-replay.json` performed 101 reads,
suppressed 100 unchanged polls, and emitted one 2,368-byte event including its
newline. The 101 raw fixture snapshots totalled 50,089 bytes. The event size is
an observation of this replay and varies with its evidence path; it is not a
constant guarantee. These are serialized byte counts, not model tokens. The
replay does not measure token savings and did not activate a LIVE campaign or
notification integration.

## Evidence boundary

The observer projects explicit allowlisted canonical states and retains detailed
bounded evidence outside the event. Its raw snapshot fallback does not calculate
temporal freshness. The packet builder preserves essential
safety and identity fields and reports optional omissions. The transfer check
uses an empty isolated repository, and the usage audit reads explicit finite
files only. These controls make the local results reproducible; they do not
establish exactly-once delivery, rule out every possible information leak, or
prove provider/runtime behavior.

Adoption remains an operator decision: preflight the exact transfer first,
start one observer against explicit sources, then create packets or usage audits
when required. The detailed commands and stop conditions are in the
[operator guide](../../operations/TOKEN-EFFICIENCY.md).

## Recette installation follow-up, 2026-10-05

[PR #38](https://github.com/ty000/paperclip-council/pull/38) was merged as
`ef817493bf99606d324cac6ef572c23de839a9ab`. Four local command wrappers were
installed from that release. On explicit operator instruction, a self-contained
company skill was then imported through the native Paperclip API into
`council-local`, company `e-ty local`
(`587884dc-195c-4555-8db9-9f3d9541b373`).

The installation completed at **2026-10-05T16:22:14.545219Z**. Its
[receipt](/home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-token-operations-ef81749/installation-receipt.json)
has SHA-256 `74bcc5ea179b9657a5bc37bc062bc4b4301b4a2548ecfcb53f7a07d5d2624209`.
The [deployment report](/home/davy-lp/.local/share/paperclip-council/deployments/2026-10-05-token-operations-ef81749/RECIPE-INSTALLATION.md)
links the operation ledger, native readbacks, hashes and isolated mount proof.

| Layer | Observed result |
| --- | --- |
| Library | Skill `849ec34b-266c-435d-b1fe-8405946de284`, key `local/47824fb670/council-token-operations`, imported and read back |
| Agent configuration | Seven assignments; all prior selections preserved |
| Instructions | Seven hash-guarded additive updates, 513 bytes each; original text preserved and read back |
| Native adapter mount | Seven isolated profiles verified with `ensureCodexSkillsInjected`; seven package file hashes checked |
| Installed CLI | Four `--help` checks passed through the mounted package |
| Recette health at readback | Enabled/active, health OK; existing Council plugin and agent runtime settings preserved |
| Real model use and savings | Not observed; agents remained paused and no new Council run was launched |

The initial import source was outside the server's approved directory roots.
The same package was staged under the already approved company skill root and
imported through the same API. No policy or permission change was made.
The library references that retained local source and reports no native version
ID; verified hashes, rather than a native version pin, identify this package.

This follow-up updates documentation only. The original `proof.json` and test
logs remain evidence for the reviewed implementation, not hashes or test results
for these later documentary edits. The broader OPT items remain partial where
only an initial small lot was delivered. See the
[updated backlog](../../operations/TOKEN-OPTIMIZATION-BACKLOG.md) for the remaining
S/M candidates and the conditional XL program.
