# N2 — ordinary correction and confirmed acceptance

Updated: 2026-10-02 (Europe/Paris). Status: **second authorized campaign stopped at the native N2 handoff; public-transition correction prepared; fresh LIVE authorization required / not N2-qualified**.

## Exact base and scope

The N2 worktree was rebased from historical candidate `a7760eb4a7088377fe447611a7176144d8a6baab`
onto `origin/main` at `d4d4a6032a96b6bd1e9c5cb6b9b754b05f08f28b`, which includes merged N1 PR #19
and documentary decisions PR #20. Only the three N2 commits were replayed;
obsolete N1 branch implementations were not restored. The authoritative exact
candidate is the published head of draft PR #18 after its base is retargeted to
`main`; PR readback records the SHA because a tracked report cannot truthfully
self-embed the hash of the commit that contains it.

This increment implements the N2 mission/native adapter and inspection delta.
It does not merge or activate Council, modify
Paperclip core, resume Executive, or add N3-N6 behavior.

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
- Accept an initially conforming V1 directly; a correction is not manufactured
  merely to satisfy the qualification scenario.
- Admit at most one ordinary correction by the pinned Integration Lead. The
  correction reservation is durable before the `changes_requested` effect.
  The initial reviewer run must then be terminal and settled before the owner
  captures the finalized native run baseline and explicitly wakes the lead.
  V2
  must be independently verified for the same company/root issue and immutable
  mandate, preserve the reviewed base commit, and change both candidate commit
  and bundle digest. Its usage baseline must retain the exact correction run.
- Create a fresh second review round for V2. Corrected-candidate approval needs
  a usable `native_observed` receipt tied to the exact second reviewer run.
- Persist `start-review`, handoff confirmation, decision application,
  correction wake/run binding, V2 preparation, second-review start and usage settlement through mission
  CAS/command receipts. Persist intent before each native mutation; a lost or
  mismatched response becomes `unknown` and is not retried.
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
- refusal of duplicate/reused reviewer runs and changed V2 subject, base or
  mandate;
- durable unknown handoff and indeterminate decision blocking;
- exact actor/run/operation/receipt binding for changes requested;
- correction-run attribution and changed V2 identity;
- direct V1 acceptance and fresh V2 review/acceptance after a usable observed
  native response;
- the persisted owner → native review → reviewer → correction → settled
  correction → verified V2 → second native-review command path;
- legacy G4 default zero, explicit one-correction profile, envelope matching,
  sequential token-delta attribution and extra-run/nonpositive-delta refusal;
- TypeScript source/test compilation and UI bundle compilation.

The repository also contains `qualification:live:n2`, a real guarded launcher
for the six-run journey. Its evidence contract accepts only the complete result:
three settled N1 runs; initial independent review and native
`changes_requested`; a separately settled lead correction; changed V2; fresh
approval run; six settled reservations; accepted restart readback; and the
commit-qualified installed UI PNG. The launcher is implementation, not proof
that such a provider campaign has succeeded.

## Authorized campaign observation — `cbcb22c`

One campaign was explicitly authorized and executed on exact clean published
commit `cbcb22cf1c5b040f4f5abdadc13c05be4b58f735`. It stopped once, without
retry, with `NON-CONCLUSIVE OR BLOCKED` before any N2 reviewer run began.

The N1 portion succeeded: lead run
`850a321c-ea26-4920-9b65-efaa9e6cdcac`, Alpha run
`3b13b45d-c70e-4ae8-8aa8-9895eec93f85`, and Beta run
`2d54ddac-dc88-4453-9789-5adc32360afc` all reached `succeeded`; their three
reservations settled at respectively `1,000,166`, `203,927`, and `335,948`
token units with zero remaining exposure. N1 stopped at `ready_for_review`.

The owner `start-review` command was then refused before native reviewer wakeup:
Council supplied `n2-review:<submission-uuid>` as the admission `effectId`, but
the existing admission contract requires a UUID. The preserved evidence is
`artifacts/n2-live-cbcb22cf1c5b040f4f5abdadc13c05be4b58f735.json`, SHA-256
`af7bcba7b0856fe74894c14e7a74abd910482e88690eeae414326d7a898b90e4`.
The paired PNG is intentionally empty (SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`)
and is not UI evidence. Cleanup completed for the owned application and fresh
database.

The correction uses the already-stable UUIDs directly: submission ID for each
review reservation and decision operation ID for the correction reservation.
Focused runtime tests now assert those exact values. This is a source fix, not
a retroactive qualification of the failed campaign.

## Authorized campaign observation — `0e5c814`

A second campaign was explicitly authorized and executed once on exact clean,
published commit `0e5c81468239d2fa697eafc3bb5acee323c68840` with the observed
`gpt-5.6-sol` / `high` configuration and the fresh six-run envelope. It also
stopped without retry, with `NON-CONCLUSIVE OR BLOCKED`, before any N2 reviewer
run began.

The N1 portion again succeeded and settled with zero remaining exposure: lead
run `e71fa454-3b71-411b-a87e-495ede4f7d55` used `1,048,832` units, Alpha run
`49ac1466-31b8-4612-bac1-afac0e87bac8` used `231,817`, and Beta run
`86931aed-8c13-4d08-bcde-b6f3e3337565` used `406,814`. Known usage was
therefore `1,687,463` units. The exact N1 candidate reached
`ready_for_review` at commit `92e4590dae3157536de228797d5a71839dbe0c1a`.

The corrected UUID admission succeeded for submission
`6cd89395-39fc-468f-b49d-948e0191cd94` and reservation
`803bc104-2003-4542-9a77-15edcd1db8b9`. The native transition then returned a
mismatched stage/actor readback, so Council durably recorded
`native_review_handoff_unknown`, left the 2,000,000-unit review reservation
unsettled with known exposure, and refused to wake or bind a reviewer. No V1
verdict, correction, V2, approval, restart acceptance or UI proof exists.

The preserved JSON is
`artifacts/n2-live-0e5c81468239d2fa697eafc3bb5acee323c68840.json`, SHA-256
`ee946d282a38743ac794086b0b81458e9dad626aaf50e1f271b545fb36caa0b6`.
The paired PNG is again zero bytes with SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
and is not UI evidence.

Diagnosis showed that the plugin SDK `ctx.issues.update` path persists the
status directly but does not execute the public issue route's execution-policy
transition, so it cannot create the required current reviewer and return
assignee state. The source correction now performs the authenticated, bounded
loopback PATCH through the qualified public issue API, validates HTTP/JSON size
and checks the returned exact stage and actors. Unit/runtime regression tests
exercise this public transition and the concurrent reviewer-confirmation race.
This new source state has not received provider authorization and is not LIVE
proof.

## Open native dependency and exit criteria

Merged N1 produced two contributions, a verified integrated candidate and
settled N1 reservations. Its final browser capture timed out and the original
campaign artifact remains non-conclusive; the owner explicitly carried the
small locator correction and capture into the next authorized N2 campaign.
This branch changes the locator to select the exact mission through the UUID
lookup before asserting its state. That source correction is not runtime proof.

The following N2 criteria remain open until an explicitly authorized campaign
starts from a qualified N1 candidate and persists/reloads the result:

1. observe the persisted public/native handoff to the eligible reviewer;
2. observe the V1 `changes_requested` effect and the single admitted correction
   run, including exact-run settlement;
3. verify and submit changed V2, then observe a fresh reviewer run;
4. observe acceptance actually applied to V2 through the durable receipt;
5. settle the admitted review runs and confirm `usage.complete=true`;
6. replay operator inspection after restart and capture the installed mission
   UI using the exact UUID locator.

The authorizations for both `cbcb22c` and `0e5c814` were consumed and do not
transfer to the next corrected SHA. Commit/publication authority for this lot remains
separate from LIVE authority. Once draft PR #18 readback identifies the new
clean head on `main` and the local bounded qualification passes on that same
head, the remaining launch gate is a fresh explicit authorization for one N2
provider campaign with the named agents and fresh token envelope. Until that
campaign succeeds, the strongest verdict is **ready to request another corrected N2
campaign**, never **N2 qualified**.

## N3 interface checkpoint

The contract is bound to the exact published PR #18 head recorded by PR
readback. N3 may develop its opinion adapter while an N2 review is in progress:
it consumes the active immutable submission identity (`missionId`,
`rootIssueId`, submission ID/ordinal, candidate commit and bundle digest,
evidence revision and mandate hash), and emits attributed opinions for that
same review subject. Opinions are review inputs; they are not an acceptance
claim and do not have to wait for an accepted mission.

The final N3 synthesis may additionally consume reviewer actor/run, review
round, verdict, decision receipt/application state and settled usage. The
reusable code boundary is `N2State` with `N2Submission` and `N2ReviewRound`.
N3 must not infer acceptance from an opinion, contribution, local test, PR
state or unobserved native effect, and only the designated Council reviewer may
issue the final verdict and native application.

This checkpoint deliberately adds no generic review API, scheduler, specialist
engine or N3 behavior. The PR description carries the exact SHA association
after publication without creating a self-referential documentation commit.
N3 receives this interface summary plus the immutable submission identity;
accepted runtime evidence is added later if and when N2 qualifies.

## Proposed bounded campaign request

- **Instance:** one fresh ephemeral Paperclip qualification instance at pinned
  host `61b3fd57a695614dc4a37e2303f426a34a9795cf`; no installed-state reuse.
- **Scenario:** produce the N1 candidate with the existing Integration Lead and
  two sequential contributors, then submit V1 to one distinct Generalist
  Reviewer, require one concrete regression correction from the Integration
  Lead, verify changed V2, run a fresh review and apply approval. Capture the
  same mission by exact UUID in the installed UI after restart/readback.
- **Agents:** one Integration Lead, Contributor Alpha, Contributor Beta and one
  distinct Generalist Reviewer, all `codex_local/cli`; no specialist, N3 or
  automatic provisioning is added. Recommended launch selection remains
  `gpt-5.6-sol` / `high`; availability and effective settings must be observed
  at launch.
- **Envelope:** fresh identified period, `runReservationUnits=2_000_000`,
  `periodAllowanceUnits=12_000_000`, `maxConcurrent=2`, `maxRetries=0`,
  `maxCorrections=1`, initial known usage `0` and exposure `0` only with a
  fresh-company/period owner attestation. Six runs are budgeted: lead, two
  contributors, review V1, correction, review V2. Reservation is exposure, not
  a hard model cutoff.
- **Stop rules:** no provider retry; any extra run, stale candidate, wrong actor,
  unknown native effect, nonterminal/unattributable usage or exhausted envelope
  stops the campaign. A direct V1 approval remains supported generally but is
  not substituted for the required correction qualification scenario.

Exact guarded command, intentionally not executed without LIVE authorization:

```sh
COUNCIL_N2_LIVE_AUTHORIZED=1 \
COUNCIL_N2_LIVE_MODEL=gpt-5.6-sol \
COUNCIL_N2_LIVE_EFFORT=high \
COUNCIL_N2_LIVE_RUN_UNITS=2000000 \
COUNCIL_N2_LIVE_PERIOD_UNITS=12000000 \
pnpm qualification:live:n2
```

The model/effort recommendation comes from the independent mapping dated
2026-09-05. Availability and effective runtime settings remain unverified until
launch and must be read back; no substitution is silent.
