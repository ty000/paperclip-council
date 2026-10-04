# Installed ordinary Council — 2026-10-04

## Current qualification after the bounded audit correction

The initial statement “Fallow PASS” was too broad. **Functional qualification PASS; normalized wrapper PASS (exit 0); raw Fallow FAIL (exit 1).** The raw failure remains visible and is manually disposed below; the wrapper omits raw lists and reports 419 unclassified candidates. Its output alone cannot justify a clean static audit.

Current executed source: `be0d7d2fd6a52dac5bc3827a65200ee67988d25c`. One bounded pass extracted the ordinary receipt predicate and next-action projection into local helpers and replaced Boolean command chains with exact `includes` membership. No predicate, command ordering or effect contract changed. The three introduced critical product findings disappeared. Independent local review confirmed semantic equivalence; this is not a GitHub or external review.

Residual dispositions ([complete indexed record](static-audit-dispositions.json)):

- Twelve cycle findings each include a delayed `await import` in N2 command handling (current lines 924, 928 or 1386); no new top-level await/eager initialization loop. Initialization failure is a probable false positive, while bidirectional structural debt remains real and deferred.
- Eleven introduced duplication groups: eight harness/probe groups, three small product groups (G4 identity readers and two finished-event branches). These are retained maintenance debt; the historical proof remains immutable.
- Fourteen actual introduced complexity entries remain, while Fallow attribution says thirteen (before: sixteen vs fifteen). Both numbers are retained as a tool inconsistency. Product entries are moderate/high, including ordinary receipt CC14/cognitive 1. The sole remaining critical entry is the installed-harness polling callback at line 189, CC10/CRAP110 with estimated absent coverage despite its actual execution; manually nonblocking. No second cleanup pass or suppression was performed.

Full [raw before](static-audit-raw-before.json) and [raw after](static-audit-raw-after.json) both retain `verdict: fail`; [normalized after](static-audit-wrapper-after.json) retains `status: pass`. The bounded lot is accepted after manual disposition and functional evidence, **not** because the raw audit is clean.

Exactly one installed replay after this source change passed, exit 0: [be0d7d2 artifact](../../../artifacts/n2-ordinary-installed-be0d7d2.json), SHA-256 `1b281d15efaf54124dd12d48a81616fac39c8ab145a2c3cbf0c141f3c11cccb4`. Ten runs succeeded; seven ordinary API bindings, two running-report nonadmission observations, ten settled reservations/1500 tokens and cleanup all passed. [New readback checks](readback-checks-be0d7d2.json) verify the 37 source/build hashes and exact identity/settlement ordering. [Canonical checks](checks-remediation.log) passed typecheck/build and 362 tests. Canonical checks and raw-after/wrapper audits ran on the final source bytes immediately before `be0d7d2`; raw-before preserves the pre-remediation source at `246c9c1`. Installed qualification ran after `be0d7d2`. No executed source changed afterwards.

Commands: `node scripts/ci/run-checks.mjs` (exit 0); `node_modules/.bin/fallow audit --base 84d79cd7779de706e99f4bea1df45743cf3186cb --format json --quiet` (exit 1, telemetry disabled); `node scripts/ci/run-static-audit.mjs --base-ref 84d79cd7779de706e99f4bea1df45743cf3186cb` (exit 0); `node_modules/.bin/tsx tests/functional/ordinary-installed.ts artifacts/n2-ordinary-installed-be0d7d2.json` (exit 0). Prior artifacts and their original hashes below remain unchanged historical evidence.

## Prior installed checkpoint (567f1d3)


No blocking finding remains for this bounded product integration and provider-free installed proof. Independent source/result review found no material issue. Real model judgment, enabled tool gateway, N5 external publication, N6 and M1 completion are not qualified.

Source: `567f1d39709b402f42df79b2f5ffd8752d32d803`, branch `codex/council-ordinary-review`; base main `84d79cd7779de706e99f4bea1df45743cf3186cb`. The earlier feasibility proof at `b2a98587a2df517583a1610b05b7dc42d386efde` is unchanged. Paperclip qualification host `61b3fd57a695614dc4a37e2303f426a34a9795cf` remained tracked-clean. No existing installed runtime, provider, cloud, remote Git or Paperclip source was modified.

## Result and boundaries

[Installed evidence](../../../artifacts/n2-ordinary-installed-567f1d3.json), SHA-256 `d5a7d1729d5cc7e661c9338b16f7f30fd15cec443e2137c10d12390a07ba21a3`, records ten real `codex_local` CLI runs: three N1 prerequisite runs and seven N2/N3 runs. All succeeded, without reassignment cancellation, native review card, recovery run or dependency-triggered dispatch. The fixture replaces only the executable model/content/usage seam. The installed plugin owns authenticated commands, persisted mission state, admission, wake claims, finished events, public run readback and settlement.

Two relevant N3 specialists (product and quality) advise on V1; quality reports a blocking defect; the independent Council records a reasoned `changes_requested` synthesis. After Council terminal usage and its receipt, the controller admits one lead correction. It actually amends the single integration commit while preserving both contributions/base. V1 `41c5f5d116f2209e37ff96d063d71f0075d2ff99` becomes V2 `04d5b84c7c0b7a44059df863b5aaf463546d21b6`. Fresh N3 opinions and Council judgment approve V2; acceptance consumes its exact submission/mandate/synthesis identity.

All ten reservations settled once: 150 tokens per run (120 input including 20 cached, plus 30 output), 1500 total, zero remaining exposure. N2/N3 contributes 1050 tokens. Public `per_run` usage is not a monetary billing claim. [Readback checks](readback-checks.json) confirm all seven ordinary issue/agent/run bindings, reservation-before-run, terminal-before-settlement and next reservation after previous settlement. Replaying start-review and reconciliation adds no run or settlement. Unknown creation/wake outcomes and wrong/missing usage retain exposure in targeted tests.

Both Council reports were observed persisted while their runs were still `running`, with no receipt/settlement, acceptance or next dispatch. The plugin records `blocked` after a valid submission to express the real terminal-accounting/review wait; the active CLI finishes normally. Only then does the controller close tasks. Root is not reassigned; its correction instructions are appended before wake. Ordinary review tasks are parentless with no native execution policy/state: this qualifies the explicit installed dispatcher, not automatic dependency coordination.

CLI agents use the real authenticated API at `/api/plugins/private.paperclip-council/api/issues/:issueId/council/commands`; seven attributed bindings are captured. The separate tool gateway returned `403 deny_default` because this test company had no effective tool profile/grant/allow policy. This is a preserved configuration-specific refusal, not proof that CLI gateway support is intrinsically impossible. No policy bypass or host change was introduced.

The saved company run-list summaries are excerpts. The installed controller separately validates the full terminal JSON through `GET /api/heartbeat-runs/:runId`; its candidate-bound prepared reports and applied receipt references remain in mission state, backed by the existing durable receipt store. Receipt storage retains legacy names `native_observed` / `nativeObservation`, but ordinary provenance is `ordinary-task-terminal-readback-v1` targeting the heartbeat API, never a native completion review.

`acceptedN5Submission` consumes the exact V2 without an invented N3 transmission settlement. Publisher CLI identity is revalidated before admission, including preexisting authority; no publication/CI/gh operation is executed or qualified. Historical runner/legacy missions route by persisted state even if configuration changes. Activation and full generated agent contracts are documented in [ORDINARY-CLI-REVIEW](../../n3/ORDINARY-CLI-REVIEW.md).

N1 preparation is explicitly owner-assisted by the harness: it closes only terminal contributor tasks while lead demand wakes are disabled, then restores demand wakes before N2. N2/N3 requires no harness controller or manual closure. Opinion/verdict quality and usage values remain synthetic. Runtime/database cleanup succeeded and no fixture process remains.

## Checks and replay

All commands ran in the authorized checkout. The final canonical checks and audit ran on the final source bytes immediately before commit `567f1d3`; there was no source change between those gates and that commit. The installed proof ran after the commit and verifies 37 source/fixture/build hashes. The later report/evidence commit changes no executed code; no redundant full suite was run after it.

| Command | Result |
| --- | --- |
| `node scripts/ci/run-checks.mjs` | exit 0; typecheck, build, 362 tests / 34 files PASS; [log](checks.log) |
| `node scripts/ci/run-static-audit.mjs --base-ref 84d79cd7779de706e99f4bea1df45743cf3186cb` | exit 0; normalized wrapper PASS, raw Fallow FAIL (see amendment); [normalized JSON](static-audit.json) |
| `node_modules/.bin/tsx tests/functional/ordinary-installed.ts artifacts/n2-ordinary-installed-567f1d3.json` | exit 0; installed PASS, cleanup PASS |

Fallow registers the externally executed proof/harness fixtures as entrypoints; historical probe files were not edited. Inherited worker-export findings remain nonblocking; this normalized list was incomplete and did not dispose raw cycles, complexity or duplication (see amendment). A fresh replay must use a new artifact filename; see [manifest](proof-manifest.json).

Retained development evidence explains nominal corrections: development-1 failed Git's single-integration-commit contract; development-2 exposed root `issue_disposition_repair`; development-3 passed the API path; the `4cf8784` attempt failed the newly exercised tool gateway. The blocked `4cf8784` attempt returned exit 0 because host shutdown later overwrote `process.exitCode`; this is not a pass. The final harness exits explicitly after awaited cleanup, and its observed final exit is 0 with a passing outcome. Earlier failed artifacts remain immutable and are not closure evidence.

Repo alignment: aligned for the stated integration. Proof: pass. Closure allowed only for this bounded provider-free lot.

```text
[Proof Gate Output V1]
Date de reference: 2026-10-04 Europe/Paris
Proof ID: council-ordinary-installed-2026-10-04
Subject: Installed ordinary CLI N2/N3 and exact accepted candidate handoff
Status: pass
Summary: Ten successful CLI runs, seven product-controlled review/correction stages, settled usage, exact V2 acceptance
Categories: functional, quality, operations
Evidence Count: 7
Replay Procedure: proof-manifest.json replay steps
Closure Decision: close-final
Closure Rationale: Bounded functional integration plus manual disposition of raw audit failures; no raw-clean, model judgment, N5 publication, N6 or M1 claim
Next Required Actions: None within this lot
Linked Manifest: docs/reviews/n2-ordinary/proof-manifest.json
```
