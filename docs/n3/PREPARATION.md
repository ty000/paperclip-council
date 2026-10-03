# N3 integration checkpoint

N3 consumes merged N2 `b90913e9291b942d9aca89f3786bc3e64165b52a` (PR #18).
The pure preparation `c39c1a6ab735b1343b43d1498be4b9660756e51e` and its static
proof remain historical preparation evidence. Native integration is opt-in on
the existing owner `start-review` command using `n3Slots` (2–7 explicitly selected,
independent, available native agents). Missions without it retain N2 behavior.

The immutable subject maps N2 submission ID, candidate commit, `sha256` to bundle
SHA-256, evidence revision and mandate hash. JSON rounds persist through the
existing mission CAS and command receipts. No migration or core change is used.
Original opinions, author/run attribution and dissent remain in each round.

## Native sequence

1. The admitted source lead verifies V1 or corrected V2 and creates an unassigned
   child accounting blocker. It terminates natively blocked. No reviewer card is
   created yet. The child blocker also prevents an all-children-completed wake.
2. Terminal source accounting precedes specialist admission. Every selected
   specialist receives a native child issue, individual reservation and one
   wake. Authenticated commands bind company, mission, child, slot, subject and
   active run. An opinion is required; child completion alone is insufficient.
3. Each terminal specialist usage is settled from its public native run before
   the next continuation. A missing opinion or unknown usage stops progression.
4. Once all selected opinions and usage are present, a short lead transmission
   and the final reviewer are individually reserved (maximum two concurrent
   reservations). The accounting blocker is retired, then one lead wake occurs.
5. The lead attests the ready round and ends with native review attention. This
   produces the genuine card/outbox for the sole final reviewer. That reviewer
   records a synthesis disposing of every material objection before deciding.
   Favorable specialist opinions do not prevent an independent correction or
   waiting judgment, justified in the bounded rationale; waiting names its next
   actor. Public outcome/verdict enums are validated before any persistence.
6. N2 retains rejection/correction/approval receipts and one-correction bounds.
   V2 receives a fresh N3 round. Its final transmission is the source of its
   own native card. Waiting synthesis requires a named next actor and cannot
   apply a native verdict.

The representative cycle has ten native runs: two source leads, four specialists,
two final transmissions and two final reviewers. The two extra transmissions are
explicitly admitted and settled. There is no model wait, recursive Council,
new scheduler or flat cycle budget. Claimed effects with an unknown response
remain blocked for owner reconciliation rather than issuing replacement wakes.

## Validation and boundaries

Canonical checks: `node scripts/ci/run-checks.mjs`. Static audit uses Fallow
3.23.0 against the merged base above. Native qualification:

```sh
COUNCIL_N3_NATIVE_LIFECYCLE=1 \
PAPERCLIP_TEST_HOST_ROOT=<clean-host-61b3fd> \
COUNCIL_N2_NATIVE_HOST_COMMIT=61b3fd57a695614dc4a37e2303f426a34a9795cf \
COREPACK_HOME=<isolated-corepack-home> \
node scripts/qualification/run-n2-native-lifecycle.mjs
```

The shared N2 harness preserves its four-run regression mode. N3 mode uses
Product and Quality: Quality raises the V1 correction-marker objection, the
final reviewer upholds it, and both specialists inspect corrected V2 before
approval. Only NativeSessionBackend is substituted. N1 preparation is a fixture;
N3 runs, authentication, plugin/CAS, scheduler/finalizer, cost rows and events
must be native. Simulated model content/usage does not qualify provider quality
or N4, production activation, LIVE behavior, or recovery after ambiguous effects.
