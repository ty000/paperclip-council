# Fixed milestone campaign — installed qualification

This scenario installs both built plugins in a disposable, native Paperclip host.
It uses the real event bus, scheduled jobs, database journals, issues, admission,
run binding, settlement and completion. It leaves the recette instance unchanged.

Linear HTTP responses, GitHub responses and CLI model output are deterministic
fixtures. Git commits and the two serial integrations are real, in a private test
repository. A fixture reviewer checks pinned documents and both integrated files;
its semantic judgment remains simulated. This is not real Linear, GitHub or model
provider qualification.

## Replay

Build Council and the intake checkout first. Use the prepared, tracked-clean
Paperclip host at `61b3fd57a695614dc4a37e2303f426a34a9795cf` and set both exact paths:

```sh
PAPERCLIP_TEST_HOST_ROOT=/absolute/path/to/prepared/paperclip \
LINEAR_INTAKE_TEST_REPOSITORY=/absolute/path/to/built/paperclip-linear-intake \
corepack pnpm qualification:native:linear-campaign
```

The launcher refuses live flags and bounds the process group to forty-five minutes.
The campaign observation is bounded to thirty-five minutes to accommodate the native
one-minute scheduler and two serial review/integration sequences. Its isolated mandate
allows forty-five minutes within the original one-hour test accounting period.
The nominal fixture authorizes eight runs per delivery (three N1, three review,
two publication/integration), then one global review: exactly seventeen runs and
2,550 synthetic token units at 150 per run. The original 20,000-unit period and
1,000-unit reservations remain unchanged; legacy Todo retains its three-run limit.
The host strips provider keys and uses private storage and embedded PostgreSQL.
Do not rebuild or edit either package, its lockfile, or the qualification fixtures
during the run. The report records source/build digests before and after, exact
Git commits and the read-only host revision.

## Acceptance checks

- A duplicate webhook produces one request and the complete five-task import:
  campaign ticket, milestone parent, two code leaves and historical cancelled work.
  No mission or run starts before full native readback and the enabled mandate.
- The control root runs no implementation and publishes no redundant PR. The plan
  is published and acknowledged before the first delivery departs.
- Each leaf has a distinct mission and PR, one publication and one merge. The
  second starts after the first is proof-closed and uses its integrated base.
- One independent global reviewer covers the pinned PRD/TAD, milestone, source
  nodes and explicit criteria. Its terminal report and stored document agree.
- Descriptions, parentage and dependencies in Linear remain unchanged. Comments
  and statuses are read back; the campaign ticket is the final terminal write.
- Native parents close after their children and the Linear acknowledgement. Every
  reservation is settled in the same original admission period.
- The terminal campaign releases its exclusive repository occupation after native
  reconciliation, so a later campaign is not held by completed work.

The companion `qualification:native:linear-intake` exercises legacy Todo import,
source hold, worker restart under the original identity, early Board refusal,
dependency order and settled N1. It stops before N2 on purpose.

## Explicit recovery and terminal publication permission

A source mismatch, incompatible human status or unavailable source/publication
persists a hold with a bounded diagnostic. A later healthy read cannot clear it.
Intake keeps reporting a retained source diagnostic even when the current source
is available, so a lost initial unavailable response cannot hide the hold.
The operator restores the pinned source and uses `resume-linear-campaign`; its
mission CAS records `resumeVersion` and invalidates the old observation/challenge;
a fresh reply is required before another departure. Intake uses this resume marker to
retain its own source hold across old challenges and process restarts. The marker
alone grants no write permission and resets no budget, source or effect identity.

The fixed campaign exchange requires `council-terminal-publication-claim-v1`
and the three capabilities `fixed-source`, `publication-readback`, and
`terminal-publication-claim`. Existing fixed campaigns without the protocol marker
remain held; upgrading a package does not silently adopt or authorize their pending
publications. The legacy Todo continuity exchange retains its previous contract.

Recording the global closure intent does not authorize Linear writes. Intake first
requests the exact intent/hash claim in its existing continuity response. Council
rechecks source, project authority, integrated results and the approved proof before
one mission CAS grants permission for the complete terminal publication. The next
existing continuity request carries that persisted grant. Lost messages reuse the
same grant and local claimed effects remain readback-only, never blindly resent.

Before this claim, pause is allowed while publishing; cancellation withdraws the
unclaimed closure intent without inventing a success acknowledgement. A stale
`running` challenge without the grant cannot publish the terminal result. Once the
claim wins, a competing pause/cancellation is refused until its original effects
are reconciled: the campaign cannot produce both success and cancellation. An
automatic source/publication hold after the claim still permits explicit resume
under the same grant, source and budget after verification. There is no timeout
that releases an uncertain terminal effect.

These recovery controls have targeted source tests. The installed audit receipt
below additionally qualifies the nominal terminal permission exchange. It does
not turn the recovery scenarios into installed tests or authorize recette activation.

## Continuity cadence and manual refresh

For a fixed campaign, an unchanged running request is not emitted again while
its response remains fresh. A request with no response still repeats its durable
hint after thirty seconds. A paused or cancelled campaign with no pending Linear
publication performs no automatic source-only refresh; pending or uncertain
publication intents retain their identity and reconcile at most once every five
minutes. A changed outbox, control, resume marker or terminal claim may request an
immediate observation, without bypassing publication, departure, merge or closure
gates.

The current company and mission owner may use `reconcile-linear-continuity` on
the native Board to require one fresh observation, including before an explicit
resume. This manual refresh reuses the durable challenge until its normal expiry
and retains the thirty-second hint guard. It bypasses only the automatic fixed
campaign backoff, grants no effect permission and does not replace or weaken
source freshness and readback.

## Cancellation and occupied-intake recovery

Fixed campaign cancellation leaves integrated commits and historical technical
task statuses intact. Product nodes must be terminal; every original member run,
effect and reservation must be reconciled before the repository can be released.
A technical review or publication task marked `done` or `blocked` does not itself
retain occupation once its exact run and costs are settled. Unknown effects,
unaccounted runs and remaining exposure still prevent release.

The cancellation publication carries `cancellationSummary` with schema
`council-linear-cancellation-summary-v1`: `retainedDeliveries` identifies member
mission, native issue, source issue, observed PR URL, integrated commit and
`verified`; `remainingWork` lists unfinished and unstarted source leaves;
`openPullRequests` lists exact observed URLs for manual cleanup. A merged result
whose checks failed remains retained with `verified: false` and remains unfinished.
No PR closure or success is inferred. Cancellation before plan publication uses
the original prepared intake mapping rather than omitting unstarted work.

An intake held by repository occupation requires the explicit owner
`resume-repository-intake` command described in [project mandates](PROJECT-MANDATES.md).
The existing job does not restart it merely because occupation disappears or its
question was published. These recovery boundaries are covered by source tests;
the installed receipts below remain attached to their original candidates.

## Evidence

Reports live under `.runtime/lot4/native-*/campaign-proof.json` (campaign) and
`proof.json` (legacy). They include intermediate states, source calls, retained
intents, native runs, costs and cleanup results. Only a terminal successful report
with `packageBytesUnchanged: true` and successful cleanup qualifies its exact pair.
Pending or failed reports retain their original result and are never rewritten as
successful evidence. Real gateway reads/writes and the recette pilot remain L6.

### Audit corrections — 9 October 2026, 22:20 UTC

The [installed audit receipt](linear-v1-audit-native.json) qualifies Council
`60905259ef43af2edbafd2d2588abd991dd60db0` (`0.7.41`) with intake
`3bae49255651fddc37e0c66b016ea73e8940d660` (`0.6.1`) on the unchanged host
`61b3fd57a695614dc4a37e2303f426a34a9795cf`. All eight acceptance checks pass:
seventeen successful native runs, two serial Git integrations, eleven global
coverage rows, exact terminal claim then acknowledgement, child-before-parent
native closure, empty repository registry and seventeen settled reservations
in the original period (2,550 fixture token units).

Server and database stopped successfully; tracked host files and the recorded
package source/build bytes remained unchanged. The receipt binds the retained
raw report by SHA-256 and rechecks every recorded source/build file after cleanup.
Later intake commits through `b0280d02` change only documentation and the CI gate,
its tests and configuration; they do not change the qualified runtime files.
This evidence commit likewise adds only documentation. The source regression
suite contains 1,407 passing Council tests and one skipped test; typecheck, build
and the static gate pass.

This is an isolated installed qualification. Linear and GitHub responses,
model judgments and token usage remain fixtures. Source divergence, restart,
cancellation races and occupied-intake recovery have targeted source/PostgreSQL
evidence; the nominal installed run does not claim to exercise all those faults.
Real Q-LR/Q-LW, authorized recette installation/configuration, provider execution
and the public HTTPS webhook remain outside this receipt.

### Historical qualified candidates — 9 October 2026

| Scenario | Council commit | Intake commit | Receipt |
| --- | --- | --- | --- |
| Complete fixed campaign | `ee6535a4f8eff7b7e8b820567bf5f1249707f8ed` | `c194d776df5e966a649d15de149f11f314aee492` | [Installed campaign](linear-v1-campaign-native.json) |
| Legacy Todo through settled N1 | `d25fff931262d90641badf433f2eabc08becc94b` | `c194d776df5e966a649d15de149f11f314aee492` | [Installed Todo](linear-v1-todo-native.json) |

Both scenarios used the read-only Paperclip host `61b3fd57a695614dc4a37e2303f426a34a9795cf`.
The complete campaign passed with seventeen successful native runs, two distinct
PR fixtures merged through real private Git, an explicit integrated predecessor,
eleven global coverage rows, terminal Linear readback, child-before-parent native
closure and an empty repository occupation registry. All seventeen reservations
settled in the original period, accounting for 2,550 fixture token units. The final
native observations were reconciled, package bytes remained unchanged and cleanup
confirmed both server and database stopped without changing tracked host files.

The Todo receipt belongs to its earlier exact candidate; it is not a claim that
the later campaign candidate reran Todo. The campaign's model verdict and token
usage are synthetic, so they demonstrate neither real model quality nor provider
cost. Failed qualification attempts retain their original reports under `.runtime`;
the receipts identify the successful raw reports by SHA-256. L6 real gateway
qualification and recette activation remain outstanding.

## Bounded follow-up — 10 October 2026

The follow-up candidate is Council 0.7.42, based on `3dc8387b…`, paired with
intake 0.6.2 based on `a6559d1d…`. These corrections do not inherit an installed
qualification from the earlier 0.7.41/0.6.1 receipt. No runtime installation,
configuration or activation is performed by this lot.

Before any first campaign plan, R01 also requires an initial admission source
attestation. A retained preparation cannot bypass it. After owner resumption,
the challenge must have been requested after that decision; a previously
positive response cannot be reused. Once the plan is persisted, expected
Started/progression states use ongoing continuity instead of replaying Todo
eligibility.

R05 binds the occupied-intake owner's decision to the first plan publication
and its existing readback gate. The question, author, answer and consequences
remain in Paperclip. No new transport, orchestration state machine or accounting
period is introduced. The full source suite passes 1,431 tests (one skipped), with 127 Python
operations tests. The composed driver test covers retained preparation, source
withdrawal, fresh admission, restart and lost plan ACK. Independent source review
found no remaining P0/P1/P2 in the bounded lot; published CI supplies final
commit-bound checks. These are source/fixture results, not a new installed run.

Two exceptional paths are explicitly outside this small V1:

- R03: individual pause/cancel before a mission exists with fixed campaign
  continuity. A repository-occupied request stays held until explicit owner
  resumption; leaving it held is not an individual cancellation. Global intake
  or mandate suspension is not evidence of such a cancellation.
- R04: resuming the same fixed campaign after a failed integration. Existing
  independent recovery-mission requirements do not bypass the original
  repository occupation. Preserve the hold and evidence; an external repair or
  revert alone cannot resume it. Cancellation still requires safe reconciliation.

The supported pause/resume/cancel controls after campaign fixation remain
unchanged. The earlier installed receipt remains useful for its nominal path,
not as proof that these exceptional cases are implemented.
