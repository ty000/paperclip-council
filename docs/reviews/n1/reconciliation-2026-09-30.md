# N1 reconciliation with merged decision receipts

Date: 2026-09-30. Base: `main` merge `9ae33f13968be4d8d5d20dc511deb2215c552ab0` (PR #14). Scope: N1 PR #15 only. The L03 checkout is read-only and remains a separate, unfinished candidate.

## Migration and verdict contract

PR #14's `004_decision_receipts.sql` remains byte-for-byte unchanged at SHA-256 `12b6c589b6b3222f6ac5da6ea9e697cd006e8225cd4d58bafc222f6315b3501e`. The original N1 admission SQL is unchanged at SHA-256 `d559a942d2f7b58eca05f4e697137ba4c6bf75f9f46fce9bdb3a40a6eac35ce7`, now named `005_admission.sql`. The earlier [admission prewrite](admission-prewrite.md) documents the 001–003 baseline before the original N1 implementation; it is historical evidence, not a claim that 004 was absent on this new base. The host migration registry keys migrations by plugin and filename and rejects checksum drift. Fresh installed qualification must apply 001–005; no durable instance is migrated here.

The worker keeps the receipt API and bridge from PR #14 alongside N1 admission and mission routes. The existing verdict endpoint still calls `executeCouncilDecision` after approval preflight. The installed correction and approval requests retain stable, distinct `operationId` values. PR #14's claim-before-send, replay, conflicting-content refusal and indeterminate issue hold remain separate from N1 admission: N1 does not create or apply a verdict.

## L03 boundary for joint reconciliation

The separately maintained L03 checkout documents a governance migration also numbered 005, a Council 0.5.0 package, and result application through the same receipt path with `receiptRef` as `operationId`. N1 now uses the 005 filename and 0.5.0 version for its own additive admission. These namespace/version collisions require a joint decision after L03's checkpoint; this PR neither imports L03 governance code nor claims compatibility with it. The plugin migration registry uses full filenames, so the different proposed filenames are distinct registry keys, but two independently named 005 migrations would obscure release order.

Other joint decisions remain open: N1 owner `start-lead` and L03 reviewer `decide-approach: proceed` both describe root wakeup authority; N1 company/period usage reservations and L03 mission counters/consultation grants need one accounting contract; and N1's integrated bundle identity has no qualified bridge to L03's exact result, evidence, native manifest and verdict receipt identity. No L03 compatibility test is claimed here.

## Independent review and corrections

The independent source review of the first reconciled candidate found four material defects. The follow-up candidate retains a reservation on mission CAS loss because a winning request may have adopted it; unknown usage retains the last accounted cumulative amount; a stale publish command is rejected before failed-verification persistence; and child dispatch returns structured admission refusals. Focused regressions and the installed shared-reservation replay cover these corrections. A conservative reservation may remain stranded after a genuine losing CAS until explicit reconciliation; the safe release ownership contract remains an N1/G4 follow-up.

## Proof boundary

Re-run `node scripts/ci/run-checks.mjs`, `pnpm audit:static --base-ref origin/main`, `pnpm test:receipts` with the pinned read-only host and browser cache, and `pnpm qualification:bounded` on the exact committed candidate. The first three respectively cover package checks, changed-file audit, and PR #14's isolated receipt protections. The installed replay covers combined migrations, authenticated native verdict calls, and N1 fixture guards. Only its generated trace can establish its result for a particular commit. Passing these checks leaves N1 partial: G4 trusted measurement, real dispatch, two attributed contributions, integrated candidate and L03 compatibility remain open.
