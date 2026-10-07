# Council-owned waiting states

New ordinary missions pin `council-native-wake-v1` unless the owner explicitly
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
