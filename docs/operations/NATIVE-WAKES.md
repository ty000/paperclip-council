# Council-owned waiting states

New ordinary missions pin `council-native-wake-v2` unless the owner explicitly
sets `nativeWakeGuardEnabled: false` before creation. Existing missions retain
their previous contract. Agent heartbeat/demand wake configuration is unchanged.

N1 records the exact contribution and author run before closing its mapped child
through `ctx.issues.update`. On the qualified Paperclip host this SDK mutation
does not perform the public issue route's implicit parent/assignment wake. The
lead still waits for terminal child usage before integrating. No completion is
inferred from an unreported child or unknown usage. A lost status response can be
reconciled by replaying the same committed report: readback avoids another status
mutation. Issue, project, parent and physical assignee must still match.

After Git verifies the candidate, N1 parks the root as `blocked`, before its lead
run finishes. It is waiting for Council review and terminal accounting, rather
than remaining `in_progress` with no execution path. Ordinary review requires
that waiting root and every prerequisite reservation settled. An authorized
correction explicitly restores `in_progress` before its existing admitted wake.
N2 specialists/Council/corrections and N5 publishers already use their existing
blocked waiting dispositions until terminal settlement and native readback.

Native wake paths examined on host `61b3fd57a695614dc4a37e2303f426a34a9795cf`:

| Path | Council handling |
| --- | --- |
| `ctx.issues.requestWakeup` | Existing durable claim, reservation and idempotency key; demand wakes remain enabled. |
| Public issue route child completion | Council completes its reported N1 children through the SDK, so this route does not add a parent wake. |
| Lead disposition repair after candidate publication | Verified candidate root is blocked before terminal lead completion. |
| N2/N3 report completion | Existing blocked issue and sequential terminal accounting. |
| N5 publication and post-publication correction | Existing admitted publisher and owner-authorized native resume; one cumulative correction. |
| Foreign/manual/recovery/periodic wake | Not an authorized Council launch. Tracking and durable accounting of these exceptions remains in issue #48. |

The installed deterministic cycle keeps demand wakes enabled, requires zero
operator child closes, and checks the exact expected run count and settlement.
It does not prove every possible external wake is prevented. Council does not
change Paperclip, the SDK, execution policies through unsupported fields or
agent-wide settings. An admission reservation is an accounting/launch guard,
**not a hard provider token ceiling**. Restart continuity and delayed settlement
are tracked separately in #49.

## Native run inventory and exception accounting

V2 snapshots only completed pre-mandate root run identities; active roots cannot
be silently adopted. Their historical costs remain the responsibility of the
explicit initial accounting source, rather than being declared free. Existing
V1 missions keep their waiting contract and are not retroactively upgraded.

Before preparation/wake claims, ordinary reconciliation and a publisher write
claim, Council reads the bounded native inventory of its root and mapped work,
review and publisher issues. An exact stored physical run binding must also have
its actual mission reservation. A claimed wake without a bound run remains
uncertain under the existing reservation; it cannot be classified as a foreign
run or repeated with another key. The optional `nativeRunLimit` is explicitly
configured and pinned at creation; no numerical run ceiling is invented when
it is absent. Old and replacement runs both consume that ceiling.

A foreign run is stored by immutable run/mission/issue/agent identity in the
existing admission document's `unadmittedRuns` ledger. This records an exception,
not a retrospective permission. Terminal `per_run` input plus output tokens
qualify its cost; cached input is part of input, not added twice. Cumulative,
absent, active or unqualified readback remains unknown and makes the accounted
total unknown. No reservation amount is substituted as an actual cost or exact
exposure cap. Only the host's exact pre-provider suppression evidence can qualify
a zero cost. Known cost growth is added once; a lower later read is rejected,
and a missing later read preserves the previous known units. Neither settlement
nor reconfiguration erases exception history.

An exception keeps the period blocked even after its terminal cost becomes known.
Owner command `reconcile-native-runs` can refresh this readback without a new
provider departure or effect key. Finished events observe foreign failures and
successes too. Period changes are refused for a mission's existing ledger.
The inventory is limited to 64 mapped issues and 256 runs per issue; invalid,
duplicate or oversized native inventories stop launches. This is a fail-closed
observation guard, not a global interceptor of external/manual/timer/provider
wakes. A wake can occur after a read; it is retained when next observed.

Qualification distinguishes the actual deterministic CLI cycle from a seeded
foreign heartbeat row. The latter proves installed native readback, durable
unknown cost across an actual worker restart and exact cost reconciliation once;
it is not proof of an external provider wake. Autonomous periodic observation,
late cost persistence and visible exception handling are delivered separately
in #49. Resolving an unadmitted run does not implicitly authorize another attempt.
