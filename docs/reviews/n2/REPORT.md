# N2 — ordinary correction and confirmed acceptance

Updated: 2026-10-01 (Europe/Paris). Status: **development partial / native qualification blocked**.

## Exact base and scope

The N2 branch was created in its own durable worktree from published N1 commit
`9bedaa81d873d755ec679e174c70279118d8deef` on `codex/council-n1`. The N1
worktree, branch, PR #15, artifacts and qualification instance were not
modified. A final synchronization against the published N1 branch is required
before the complete N2 checks and PR handoff.

This increment implements only the N2 domain and inspection delta. It does not
redo N1, run a provider campaign, merge or activate Council, modify Paperclip,
resume Executive, or add N3-N6 behavior.

`migration_prewrite: not-applicable`. The existing mission aggregate JSONB,
command journal, admission records and `decision_receipts` table can hold this
bounded state without a schema migration. No migration or applied Paperclip
data is changed.

## Implemented contract

- Snapshot the exact verified N1 attachment, byte size, SHA-256, base/candidate
  commits and mandate hash into immutable V1 submission identity.
- Reject a final reviewer who is the Integration Lead, a recorded contributor,
  or absent from the pinned Council.
- Confirm handoff only from an observed `in_review` stage, exact reviewer and
  return actor, and exactly one new reviewer run relative to a persisted native
  run baseline. A lost/ambiguous handoff becomes durable `unknown` and cannot
  be confirmed or retried through this state machine.
- Bind each verdict to the active submission, pinned reviewer, confirmed run,
  stable operation and existing durable decision receipt. An indeterminate or
  unusable native observation becomes `application_unknown`, never acceptance.
- Admit exactly one ordinary correction by the pinned Integration Lead. V2
  must be independently verified and change both commit and bundle digest. Its
  usage baseline must retain the exact correction run.
- Create a fresh second review round for V2. Approval is accepted only for V2,
  after the single correction, with a usable `native_observed` receipt tied to
  the exact second reviewer run.
- Expose the current candidate, reviewer eligibility, round/handoff/verdict,
  correction, native application, blocker and next action through the existing
  owner-only Council mission inspection page.

## G4 adaptation

The legacy and default native profile stays at `maxCorrections=0`. An N2
campaign must explicitly configure `maxCorrections=1`; any other value is
rejected. The existing envelope assertion now checks this value.

Paperclip currently reports issue-level aggregate tokens when several
sequential runs share an issue. Council therefore records a baseline of exact
run IDs and aggregate tokens, then attributes only the positive delta when the
next expected run is the sole addition and is terminal. An unexpected run,
duplicate ID, nonterminal run or nonpositive delta fails closed. This helper is
locally tested; it has not been exercised against an authorized native N2
campaign.

## Evidence obtained

Local deterministic checks cover:

- verified-candidate and one-correction entry guards;
- reviewer independence and exact native handoff/run matching;
- durable unknown handoff and indeterminate decision blocking;
- exact actor/run/operation/receipt binding for changes requested;
- correction-run attribution and changed V2 identity;
- fresh V2 review and acceptance only after a usable observed native response;
- legacy G4 default zero, explicit one-correction profile, envelope matching,
  sequential token-delta attribution and extra-run/nonpositive-delta refusal;
- TypeScript source/test compilation and UI bundle compilation.

These are local implementation proofs, not proof of a Paperclip-native journey.

## Open native dependency and exit criteria

N1 remains unqualified on this base. Its report records a non-conclusive native
campaign with no verified integrated candidate, so no legitimate N2 campaign
input exists yet. PR #15 being merged would not itself satisfy this dependency.

The following N2 criteria remain open until an explicitly authorized campaign
starts from a qualified N1 candidate and persists/reloads the result:

1. perform and observe the public/native handoff to the eligible reviewer;
2. persist each N2 transition through the mission CAS/command path;
3. observe the V1 `changes_requested` native effect and bounded correction run;
4. verify and submit V2, then wake a fresh reviewer run;
5. observe acceptance actually applied to V2 through the existing receipt;
6. replay operator inspection after restart in the installed Paperclip UI.

No N2 provider authorization is present. The N1 campaign authority and its PR
review-loop bound do not transfer. The next useful action is to integrate the
final published N1 correction, finish the native N2 adapter/persistence wiring,
and prepare a bounded campaign request rather than calling local tests N2
completion.
