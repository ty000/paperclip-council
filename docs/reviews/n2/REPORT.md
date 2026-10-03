# N2 — ordinary correction and confirmed acceptance

## Current checkpoint — 2026-10-03

**Complete native N2 lifecycle validated with deterministic model execution** on
Council source `fa8af3861c2f1b6e74a794289a9d3c1fa3e3734b` and the separate local
Paperclip core candidate `e5b4b1de306e0d898390fef02bdf8abffa43e814`. The installed
plugin traversed reviewer → changes requested → correction → distinct V2 →
acceptance through real API authorization, heartbeat finalization, costs, events,
locks and recovery. Exactly three runs succeeded, three native cost rows recorded
372 simulated tokens in total, all three reservations settled with zero remaining
exposure, no additional run appeared, and the owned runtime was removed.

Evidence: `artifacts/n2-native-lifecycle-fa8af3861c2f1b6e74a794289a9d3c1fa3e3734b.json`,
SHA-256 `8f90b60f9a1b47c8a6c0241aac9eabc70dba18c7a496c0aebbdeefca6fe0cdd5`.
`artifacts/n2-native-lifecycle-gates-fa8af38.json` records the bounded checks:
Council 233 tests/typecheck/build PASS, 181 targeted core tests PASS, and both
Fallow diff gates PASS. Core server typecheck remains non-green with diagnostics
byte-identical to the base; full core monorepo checks are not claimed.

The core change makes release and maintenance recovery respect
`wakeOnDemand=false`; it is a **local dependency not yet adopted, published,
merged or deployed**. N2 approval now uses its immutable verified submission and
rechecks its attachment binding; non-N2 legacy manifest checks remain intact.
The protocol remains operator-assisted: enable an admitted dispatch, observe its
exact run, then disable wakes. The deterministic model rendezvous covers that
state, not the timing race for an arbitrarily fast model. No provider was called,
no new LIVE campaign was executed, and no autonomous orchestration is claimed.

This checkpoint is a documentation-only update after `fa8af38`: executable code
is unchanged, and the proof remains bound to that source SHA without another
run. **All older status statements and proposed LIVE commands below are
historical. In particular, proposals using host `61b3fd57` are not ready to
relaunch:** that host lacks the required recovery fix. The original host pin and
historical campaign artifacts remain unchanged; adopting and qualifying the core
dependency and obtaining a new explicit LIVE authorization remain separate steps.

---

Updated: 2026-10-03 (Europe/Paris). Status: **provider-free synthetic N2 integration validated through accepted restart readback; the latest isolated LIVE campaign reached a prepared `changes_requested` verdict but exposed a terminal-run ordering defect and is not N2-qualified**.

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
  CAS/command receipts. Persist intent before each native mutation; never infer
  handoff or acceptance without exact native readback, and never retry an
  unknown effect through a replacement identity.
- Keep the native review transition under the authenticated owner/operator who
  invokes the public issue route. `start-review` and `start-resubmitted-review`
  now return a bounded `prepared` transition only after persisting the exact
  submission, baseline and reservation. The operator then applies the returned
  `PATCH /api/issues/:id {status: in_review}`; only the resulting pinned reviewer
  run can confirm the handoff. A reviewer credential never crosses the lead's
  active assignee/run lock.
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

The provider-free isolated prerequisite now finishes its three explicitly
labelled heartbeat fixtures only after both contributions, candidate publication
and all three N1 settlements. The ephemeral harness marks those exact rows
terminal, clears only their matching issue checkout/execution locks, and reads
back zero active slots, zero open locks and zero fixture exposure at the retained
`ready_for_review` snapshot. The harness then removes `n1FixtureMode` through the
public configuration route, creates a distinct native period with exact profile
dates, and uses that period to carry the same mission and candidate through
`start-review` → prepared and the authenticated operator PATCH. All wakeups stay
disabled. A separately labelled provider-free reviewer fixture then uses its
exact agent/run identity to call the public `inspect` and
`confirm-review-handoff` commands with the mission ID and Council route carried
in the issue context. That fixture is terminalized and its issue locks are
cleared after the readback reaches `reviewing`. The native reservation remains
reserved because the fixture has no provider usage and cannot settle a native
token ledger; the owned ephemeral database is removed at cleanup. This proves
that the same prepared mission/candidate can cross the public handoff boundary.
It does not prove a native reviewer, correction, V2, approval or LIVE
qualification.

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
assignee state. The `586608b` correction performed the authenticated, bounded
loopback PATCH through the qualified public issue API, validates HTTP/JSON size
and checks the returned exact stage and actors. Unit/runtime regression tests
exercise this public transition and the concurrent reviewer-confirmation race.
That source state is the third campaign subject described below, not successful
LIVE proof.

## Authorized campaign observation — `586608b`

A third campaign was explicitly authorized and executed exactly once on clean,
published commit `586608b475ecc8fe71acd1ff1ee8014e2d93d9ae`, with observed
`codex_local` / `gpt-5.6-sol` / `high` configuration for all four agents and the
fresh 12,000,000-unit period. It stopped without retry, with
`NON-CONCLUSIVE OR BLOCKED`, before any N2 reviewer run began.

The N1 portion succeeded again. Lead run
`b3e969da-6a60-44c5-9c20-757f8d4261f3`, Alpha run
`050bf524-f1e7-4d6f-adf3-9629f5645d90`, and Beta run
`a323c854-e00c-4087-b184-522b5ef7f5f7` consumed respectively `1,720,452`,
`385,204`, and `173,379` token units. All three reservations settled with zero
remaining exposure, for `2,279,035` known units. The verified N1 candidate was
commit `459fba589de931bf971fb9ed4c1a809d2367598b`, bundle SHA-256
`3578731b961ab9f226acc7ed16fe257a0cf843ae60009e89897c3dde5f29bc27`.

Council persisted submission `135cf128-4fe4-4282-97b7-80b1e96e3941` and
2,000,000-unit reservation `c6edcc43-944d-4ea1-aff1-3a8de1dc9eb5`. The
configured reviewer credential then attempted the public `in_review` PATCH
while the root issue remained `in_progress` and assigned to the Integration
Lead. Paperclip correctly returned HTTP 409 under its
`issue_write_assignee_run_lock`. Council recorded an unknown handoff and did
not dispatch a reviewer, correction, V2 or final review. The N2 reservation
remained unsettled with known 2,000,000-unit exposure; no replacement key or
retry was used.

The preserved JSON is
`artifacts/n2-live-586608b475ecc8fe71acd1ff1ee8014e2d93d9ae.json`, 2,291,108
bytes with SHA-256
`0635d78130c7e1bbc5f3aa6e32f14df5256e7a312aa26a1df2afe6e4e373e0be`.
The paired PNG is zero bytes with SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
and is not UI evidence.

The bounded correction removes reviewer-owned review entry. The board command
now persists and returns an operator-owned public transition descriptor; the
LIVE harness applies it with the existing human session and checks the native
reviewer, current participant and return assignee before awaiting the reviewer
run. Confirmation also closes the claimed handoff intent with that exact run.
This source correction is locally tested only and is not retroactive LIVE proof.

## Authorized campaign observation — `daa14fa`

The next explicitly authorized campaign ran exactly once on clean, published
commit `daa14fa1a4563bd16dff428045037edda81f00aa`. Its N1 lead, Alpha and Beta
runs succeeded and settled at `2,415,527` known token units in total with zero
remaining N1 exposure. The first N2 reviewer run then reached terminal
`succeeded`, but the mission remained in `review_handoff`: the reviewer never
confirmed the handoff and no decision receipt or verdict was recorded.

The concrete cause was the agent command router. Reviewer instructions required
`POST inspect`, but the worker sent every `inspect` command to the N1 handler.
That handler requires the original N1 lead/run on the root issue, so the pinned
N2 reviewer received HTTP 403. The harness then asserted
`correction_requested` before attempting reviewer settlement. Its late, final
assignment of `liveN2` evidence also meant the terminal reviewer proof and
settlement attempt were not represented as a coherent N2 failure snapshot.

The preserved JSON is
`artifacts/n2-live-daa14fa1a4563bd16dff428045037edda81f00aa.json`, 3,902,967
bytes with SHA-256
`249b37da8408c77e66a7292df413531913fb9e9298c367f8897abe95c2f2efa5`.
The reviewer reservation
`ceb7bac8-258e-4d6d-8d58-33a8d072f783` remains recorded as reserved for
2,000,000 units: usage is unknown and the corresponding exposure is retained.
No correction, V2, second review, acceptance or UI proof exists.

The bounded local correction routes `inspect` to N2 only when the root mission
already has N2 state. It authorizes only the pinned reviewer/current native run
during review handoff/reviewing, or the pinned Integration Lead/bound correction
run during correcting/resubmission preparation. N1 inspection is unchanged and
agents receive only the N2 submission/state needed for their command, never the
owner inspection surface. The provider-free scenario now performs reviewer and
lead inspection before and after their transitions and refuses an unrelated
actor. The LIVE harness records each terminal N2 run immediately, persists the
partial proof before cleanup, attempts applicable settlement before surfacing a
business assertion, retains unknown usage/exposure, and preserves the original
business error if settlement or readback also fails.

## Authorized isolated campaign observation — `d285f85`

The explicitly authorized isolated campaign ran exactly once on clean,
published commit `d285f8557e90b7b0ea9c9790f4584296120f969d`. It stopped before
any N2 reviewer, correction, or final-review run and before any provider call.
The initial prerequisite admission configuration mixed the native token sources
selected from the LIVE profile with `n1FixtureMode=ephemeral-local-sandbox`.
Council correctly rejected that envelope with HTTP 422
`fixture_source_required`; no retry or replacement campaign was attempted.

The preserved JSON is
`artifacts/n2-live-d285f8557e90b7b0ea9c9790f4584296120f969d.json`, 2,589,593
bytes with SHA-256
`d0c308239b2fccf7252f69a81fe2e79b1390da4cfb970499f0e0aaf70c2b8ddd`.
The paired PNG is zero bytes with SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
and is not UI evidence.

The bounded correction keeps N1 in its immutable fixture period and settles its
three reservations at zero before removing fixture mode. It then creates a
distinct native N2 period with exact profile dates and sources. Lead and reviewer
wakeups remain disabled during preparation; the isolated LIVE harness enables
only the reviewer immediately before each review transition and only the lead
immediately before the single correction. Native N2 settlement and readback use
the explicit native period, while the three N1 fixture reservations remain
separately readable and unchanged.

The installed mission UI and its restart readback deliberately render the
admission period attached to the N1 mission. In isolated mode this is the
settled `fixture:local-sandbox` period, so the screenshot proves the accepted
N2/V2 state and exact candidate identity but does not claim that the native N2
token envelope is displayed. Native review/correction consumption remains
validated separately through the explicit native-period admission API recorded
in `liveN2.admission`.

## Authorized isolated campaign observation — `46640fd`

The next isolated campaign was explicitly authorized and launched exactly once
on clean commit `46640fd48d660593e6d4cc4ad790414a052f3d14`. Its deterministic N1
prerequisite succeeded without a provider. The first native reviewer run
`4f1fee68-0f10-4ee6-9e43-70ffb4d83699` reached `succeeded` with observed provider
usage of `1,339,366` input plus `7,671` output units, `1,347,037` total. Council
could not settle that run: `review_usage_binding_missing` left its 2,000,000-unit
reservation open, with 4,000,000 units still available in the native envelope.

The reviewer received no exact mission ID. Its instructions contained the
literal `<mission-id>`, while the wake context exposed only root issue ID
`a62c176b-37eb-46bd-aa80-a2a52f434830`. The reviewer explicitly inferred that
`PAPERCLIP_TASK_ID` was the mission ID and called the Council `inspect` command
with that value. The exact response was HTTP 404
`{"error":"Mission not found","code":"mission_not_found"}`; the actual mission
ID was `c2963e5d-172f-4488-b3c2-d00b238b3603`. No
`confirm-review-handoff`, verdict, correction, V2, acceptance, receipt or UI
proof followed.

Because reviewer `wakeOnDemand` was disabled only after the terminal business
assertion, that assertion failure left the wake source active and a second run
`75fd029f-a426-491e-beca-d057d8dc2482` started. It was observed as unexpected;
its provider process had already exited when targeted shutdown was authorized,
and its provider usage is unknown rather than zero. The original evidence remains
`artifacts/n2-live-46640fd48d660593e6d4cc4ad790414a052f3d14.json`, SHA-256
`aa56e1e6c4b5047c448e029c4c7684013901d6ef401152a33a0304d3666ef555`.
The immutable diagnostic addendum is
`artifacts/n2-live-46640fd48d660593e6d4cc4ad790414a052f3d14.addendum.json`,
SHA-256 `7598aafbcd771de241db1b5efa041dcac9edda3f97e93d62bc9535a5268413c0`.
The paired PNG is empty and is not UI evidence.

The bounded local correction injects the exact mission ID and Council command
route into both the configured instructions and native issue context before the
review transition. The harness disables wake-on-demand immediately after each
expected reviewer or correction run is identified. Its final cleanup disables
both campaign agents, reads all runs created after the captured baseline,
cancels every owned nonterminal run through the public operator route, and
requires terminal readback before ephemeral database teardown. This is a local
correction only; it does not retroactively qualify the campaign.

## Authorized isolated campaign observation — `7847e64`

The next isolated campaign was explicitly authorized and executed exactly once
on clean commit `7847e648dd1ba8b06220e9790bbe22240b7888d8`. Its provider-free N1
prerequisite and exact N2 handoff succeeded. Reviewer run
`93257fed-37f8-48d8-b9c0-bb8e0176207c` received the exact mission and route,
confirmed the handoff, and submitted a durable `changes_requested` verdict for
the active V1 subject. Applying that verdict immediately reassigned the issue;
Paperclip then terminated the still-running reviewer as `cancelled` with
`Cancelled before issue reassignment`. The business verdict remained observed,
but authoritative run usage was unavailable, so the review reservation could
not settle. A second 2,000,000-unit correction reservation was also open; no
correction run, V2, final review, acceptance, or UI proof followed. Provider
usage for the cancelled reviewer remains unknown rather than zero.

The preserved JSON is
`artifacts/n2-live-7847e648dd1ba8b06220e9790bbe22240b7888d8.json`, SHA-256
`a741c684258f2cb44208e8028d592d364cff8bac190fd6e134c679567b0779bc`.
The paired `-accepted.png` is zero bytes, SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
and is not UI evidence. Cleanup observed only the expected reviewer run and no
owned nonterminal or extra provider process.

The bounded source correction now persists the reviewer's complete normalized
decision as a `prepared` effect intent with exact submission, agent, run,
operation and stable settlement identities. It does not apply a native issue
mutation while that run is active. The plugin subscribes to
`agent.run.finished`; only the exact successful reviewer event may trigger a
short bounded observation of authoritative usage, settlement of that exact
reservation, and application through the existing receipt-backed public issue
PATCH. Unknown usage leaves the decision prepared. Duplicate events relink to
the same admission command and decision receipt, while stale subjects or wrong
run/agent identities are ignored. This source correction is provider-free and
does not retroactively qualify `7847e64`; spontaneous host lifecycle delivery
remains a LIVE observation for a later separately authorized campaign.

## Provider-free synthetic integration

The bounded qualification now contains one nominal N2 scenario on the pinned,
authenticated, ephemeral Paperclip host. A fixture prepares only the initial
N1 contribution state; the installed plugin then verifies and publishes V1.
The remaining journey uses the real mission, issue, decision, admission,
attachment, document and persistence routes: initial review, native
`changes_requested`, one correction wake/run, materially changed and verified
V2, a fresh review, approval, all three N2 settlements, and accepted readback
after plugin/application restart.

Model work is replaced by explicit ephemeral deterministic run identities,
the process adapter (`/usr/bin/true`) for the correction wake, and zero-cost
fixture token events. The harness injects an explicitly labelled synthetic
`agent.run.finished` envelope through the real in-process Paperclip event bus
after persisting the terminal run and cost fixture. This verifies SDK transport
and the installed plugin handler, not spontaneous lifecycle emission or a
provider run. These fixtures do not write N2 states, decision receipts or
native transitions directly. Admission and settlement recompute against the
real Paperclip orchestration summary. The scenario additionally proves the
three campaign regressions: UUID effect IDs are admitted; the public issue
route produces `in_review` with the pinned reviewer/current participant and
Integration Lead return assignee; and reviewer-owned entry is refused with
HTTP 409 while the authenticated human/operator PATCH succeeds. It also proves
that the reviewer and correction lead obtain mission versions and submission
state through their own exact N2 identities before and after their commands,
that an unrelated actor is refused, and that a terminal reviewer run without a
verdict is preserved while settlement is attempted before cleanup.

`start-review` and `start-resubmitted-review` remain a human-assisted workflow:
the owner mission command returns the exact `PATCH /api/issues/:id` descriptor,
and a signed-in operator applies it through the ordinary public route. No
autonomous executor consumes `prepared` outside the harness in this lot.

Replay is `COREPACK_HOME=<isolated> corepack pnpm qualification:bounded` on a
clean committed head. The launcher writes a commit-qualified ignored JSON and
prints its SHA-256. The evidence contract accepts only
`N2 SYNTHETIC INTEGRATION VALIDATED`; this is separate from every `live-n2`
proof ID and cannot establish provider/model execution.

## Remaining LIVE-only dependency and exit criteria

Merged N1 produced two contributions, a verified integrated candidate and
settled N1 reservations. Its final browser capture timed out and the original
campaign artifact remains non-conclusive; the owner explicitly carried the
small locator correction and capture into the next authorized N2 campaign.
This branch changes the locator to select the exact mission through the UUID
lookup before asserting its state. That source correction is not runtime proof.

The synthetic integration exercises the corresponding interfaces, but the
following criteria remain open as model-backed observations until an explicitly
authorized campaign starts from a qualified N1 candidate and persists/reloads
the result:

1. observe the persisted public/native handoff to the eligible reviewer;
2. observe the V1 `changes_requested` effect and the single admitted correction
   run, including exact-run settlement;
3. verify and submit changed V2, then observe a fresh reviewer run;
4. observe acceptance actually applied to V2 through the durable receipt;
5. settle the admitted review runs and confirm `usage.complete=true`;
6. replay operator inspection after restart and capture the installed mission
   UI using the exact UUID locator.

The authorizations for `cbcb22c`, `0e5c814`, `586608b`, `daa14fa`, `d285f85`,
`46640fd` and `7847e64` were consumed and do not transfer to the next corrected SHA. Commit/publication
authority for this lot remains separate from LIVE authority. Once a clean local
correction commit passes the provider-free bounded qualification, it is
technically ready to be proposed for publication and a later fresh campaign;
local commit and PR publication are already authorized for the parent operator,
while any later provider campaign still requires a fresh exact-SHA authorization.
Until an authorized campaign succeeds, the
strongest verdict is **correctif local et intégration synthétique validés**,
never **N2 qualified**.

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
- **Scenario:** build and settle the deterministic N1 prerequisite without a
  provider, switch the same mission and candidate to its distinct native period,
  then submit V1 to one Generalist Reviewer, require one concrete correction
  from the Integration Lead, verify changed V2, run a fresh review and apply
  approval. Capture the same mission by exact UUID after restart/readback.
- **Agents:** only the Integration Lead correction run and two Generalist
  Reviewer runs use `codex_local/cli`; deterministic N1 contributors remain
  terminal fixtures. No specialist, N3 or automatic provisioning is added.
  Recommended launch selection remains
  `gpt-5.6-sol` / `high`; availability and effective settings must be observed
  at launch.
- **Envelope:** fresh identified period, `runReservationUnits=2_000_000`,
  `periodAllowanceUnits=6_000_000`, `maxConcurrent=2`, `maxRetries=0`,
  `maxCorrections=1`, initial known usage `0` and exposure `0` only with a
  fresh-company/period owner attestation. Exactly three native runs are budgeted:
  review V1, correction, review V2. The separate N1 fixture period remains
  settled at zero. Reservation is exposure, not a hard model cutoff.
- **Stop rules:** no provider retry; any extra run, stale candidate, wrong actor,
  unknown native effect, nonterminal/unattributable usage or exhausted envelope
  stops the campaign. A direct V1 approval remains supported generally but is
  not substituted for the required correction qualification scenario.

Exact guarded command, intentionally not executed without LIVE authorization:

```sh
COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED=1 \
COUNCIL_N2_ISOLATED_LIVE_CANDIDATE_SHA=<exact-published-sha> \
COUNCIL_N2_ISOLATED_LIVE_MODEL=gpt-5.6-sol \
COUNCIL_N2_ISOLATED_LIVE_EFFORT=high \
COUNCIL_N2_ISOLATED_LIVE_RUN_UNITS=2000000 \
COUNCIL_N2_ISOLATED_LIVE_PERIOD_UNITS=6000000 \
pnpm qualification:live:n2:isolated
```

The model/effort recommendation comes from the independent mapping dated
2026-09-05. Availability and effective runtime settings remain unverified until
launch and must be read back; no substitution is silent.
