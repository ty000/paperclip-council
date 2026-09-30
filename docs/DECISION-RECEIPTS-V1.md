# V1 decision receipts: accepted scope replacement

Date: 2026-09-30. Authority: the user's priority rescope replaces mandatory D-H
host changes and automatic recovery of ambiguous native outcomes for V1.
Use existing Paperclip APIs only. Preserve uncertainty, hold dependent work,
and allow authenticated human acknowledgement or abandonment without inventing
native success. This supersedes the earlier host implementation authorization.

The previous host experiment remains uncommitted in
`/home/davy-lp/workspace/paperclip-decision-readback`, branch
`codex/decision-readback`, base `61b3fd57a695614dc4a37e2303f426a34a9795cf`.
It is suspended, unreviewed and not a dependency of this implementation. Its
tracked shared types/exports and routes, untracked readback service/tests and
two documentation files are preserved. The last expanded integration run had
7 passing tests and one failing duplicate-cycle fixture; global build/typecheck
were blocked by missing Cargo and the full test run was interrupted by this
rescope. No host commit, PR, installation or deployment was made. No claim of
completed D-H survives this decision. The original host checkout and instance
remain untouched. No new host source changes or database access workaround is
permitted in the plugin.

## Bounded acceptance contract

- RC1: Keep the configured Council actor/run and current candidate/authorization
  checks. Use only the existing public issue PATCH; no privileged SDK fallback.
- RC2: Persist operation identity, exact target/content and server-derived actor/run
  before possible send. Claim one attempt atomically with private additive storage.
- RC3: Same operation/content returns its stored observation without a second send;
  same identity with different content conflicts. Concurrent claims have one sender.
- RC4: Lost, malformed or ambiguous response and interruption retain a durable
  indeterminate observation. Restart never resets a possibly sent attempt.
- RC5: Unresolved work blocks other verdict operations for the same company/issue,
  even with a new operation ID or altered content. No blind retry or key bypass.
- RC6: Preserve native response/status/references actually observed, distinguishing
  local intent, possible send, usable native response and downstream execution.
  HTTP errors are not automatically proof of no effect. No exactly-once claim.
- RC7: Owner-only acknowledgement/abandonment is authenticated and audited separately;
  neither changes native observation nor clears an uncertain issue barrier.
- RC8: The existing Council page shows issue, operation, verdict, observations,
  blocking reason, owner action and persistent human disposition. Normal usable
  responses require no routine human intervention.
- RC9: Align active Executive/Council prescriptions (A5, Q6, D-H and dependencies),
  retain the dated audit, and preserve independent L03 requirements.

Evidence: targeted tests, real isolated PostgreSQL concurrency/restart checks,
synthetic network faults, operator rendering/interaction checks, build/typecheck,
static audit and independent review. Qualifying a running host or real agents is
not claimed. No model calls, existing instance mutation, host publication or
deployment. Council/Executive local commits and PRs are authorized; no merge.

## Parent boundaries

L03-A1 permissions and binding, A2 distinct approach direction/revision, A3 exact
subject/evidence, A4 bounded correction, A6 shared persistent limits, A7 distinct
attributed opinions, and A8 operator visibility remain mandatory. A5/Q6 now allow
explicit uncertainty and human intervention without automatic native recovery.
This lot supplies the existing verdict path's receipts and hold, not all L03,
D-LIMIT, Executive runtime, opinion orchestration or external-path enforcement.

Migration prewrite is required at
`docs/contracts/council-decision-receipts-migration.json`. Storage is private,
additive, preserves prior migrations and records, and needs no backfill or host
migration. Deploying code without its private migration must fail closed before
send. Rollback means retaining receipts and disabling the new code path, never
downgrading to an old blind-send worker or deleting an indeterminate receipt.
