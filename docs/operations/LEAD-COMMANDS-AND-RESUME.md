# Lead commands, pre-plan resume and native departures

Lot #71, Council 0.7.24, October 9, 2026. Builds on the
[native project setup](NATIVE-PROJECT-SETUP.md) lot. No new scheduler, SDK change,
operator credential inside Council or Linear write is introduced.

## Lead handoff

Authenticated `inspect` on the admitted lead task exposes
`n1.leadCommands` while planning/materialization remains necessary. It contains
the executable shell block and usage, available to both new and historical missions.
New coordinator descriptions identify this pre-plan source; contributor execution
documents exist only after materialization. Existing creation intents retain their
original instruction protocol for exact readback; confirmed historical descriptions
are not rewritten. The generated block requires the native run's API URL, key,
run ID and task ID and uses the existing issue-scoped Council command API.

- `inspect`: fresh read, no journal or mutation.
- `plan`: set `COUNCIL_LEAD_OPERATION=plan`. Hierarchy leaves come directly from
  fresh inspection in pinned dependency order. Without a hierarchy, supply
  `COUNCIL_LEAD_INPUT` as a JSON file with exactly two business contributions:
  `assigneeAgentId`, `title`, `ownedPaths`. Code generates contribution UUIDs.
  Council still validates ownership, paths and independent actors.
- `materialize`: set `COUNCIL_LEAD_OPERATION=materialize` and
  `COUNCIL_LEAD_INPUT` to the participant's one-based index from inspection.
  Code takes its existing contribution ID, generates a command UUID and uses the
  fresh version. Do not substitute a new target or create another child.

For proof-close missions, plan pins the actual full Git HEAD as `sourceBaseCommit`.
Each mutation first exclusively writes an exact request to
`.git/council-lead-intents`, using Git's actual git-dir path, mode 0600.
A refusal, timeout, response loss or business-state mismatch retains that intent.
A second invocation sends only inspect, prints the original request and stops;
owner reconciliation must establish the exact receipt before an authorized exact
replay. This deliberately does not implement automatic retries. A successful HTTP
response must contain the expected mission and exact plan or confirmed materialization.
Credentials are not logged. Dispatch and publication keep their existing APIs and
admission; this helper grants neither departure nor publication rights.

## Same-mission pre-plan recovery

The existing `prepare-n1-resume` now also accepts zero planned contributions for
an existing hierarchy. Requirements remain: original confirmed coordinator and
owner, active executing mission, no candidate/review/delivery, blocked unlocked
coordinator, known settled prior lead costs and zero exposure, complete known native
run inventory, every original leaf without a run/lock, suspended continuity,
unexpired original mandate/deadline and enough original run/token budget.

Empty state with a recorded plan receipt or plan journal is inconsistent and rejected.
Partial plans, claimed child effects, unknown runs/costs and any started leaf remain
blocked. The owner explicitly supplies `authorizeOneResume`,
`authorizeContinuityResume`, `previousOwnerUserId`, reason, UUID and current version.
The durable grant preserves source hierarchy, mission/root/coordinator identities,
old reservations and usage, journal, previous grants, mandate and deadline.
Preparing/replaying it performs no wake or reservation. The existing scheduled job
later consumes that grant once through the normal reservation and native wake gates.

## Phase/departure matrix

| Phase | Departure owner and eligible actor | Required gate | Native wakes and waits |
| --- | --- | --- | --- |
| New task | Existing Council intake/job; pinned lead | Project revision, hierarchy/source, G4 activation | One admitted coordinator/root demand wake; no polling |
| Plan/materialize | Current bound lead/run | Fresh version, exact immutable plan, command receipt | No wake from these commands; preserve native blockers |
| Child execution | Existing lead or delegated hierarchy controller; pinned contributor | Predecessor proof/settlement, current ownership, G4 reservation, run/deadline bound | Exactly one claimed demand wake; unknown dispatch requires readback |
| Waiting/terminal settlement | Existing controller; no model actor | Native run/usage inventory, known exposure | Read-only backstop and controlled task disposition; no dependency-triggered extra run |
| Review/correction | Existing ordinary review controller; specialist/final Council/lead | Exact subject, independent reviewer, token reservation and cumulative correction bound | Admit only the expected next native task; administrative review task completion suppresses implicit wakes |
| Pre-plan recovery | Explicit owner grant then existing job; original lead | Settled original costs, idle leaves, known inventory, suspended unexpired continuity | Grant/replay performs no wake; one reserved resumed run retains history |
| Unknown/blocked/deadline exhausted | Owner decides after reconciliation | No speculative replacement identity or reset | No automatic departure |

Native billed monetary budgets remain separate from token/run/correction/deadline
bounds. Safe cooperative pause and continuous control belong to #73.

## Qualification

Transport tests execute the delivered shell block against a local HTTP seam and real
Git, including response loss, wrong business result, refusal, repeat and claimed effects.
N1 tests cover pre-plan resume plus existing unknown-cost/run/deadline/ownership gates.

```sh
COUNCIL_NATIVE_SETUP=1 COUNCIL_PROJECT_INTAKE=1 COUNCIL_CONTINUITY=1 \
  COUNCIL_ORDINARY_DELIVERY=1 COUNCIL_HIERARCHY_COUNT=1 \
  COUNCIL_PREPLAN_RESUME=1 COUNCIL_LEAD_COMMAND_BLOCK=1 \
  pnpm exec tsx tests/functional/ordinary-installed.ts
```

The native installed qualification terminates one lead before plan, reconciles its
150 fixture tokens, explicitly authorizes same-mission recovery, then executes the
generated block through real authenticated plugin APIs. Exactly seven runs and 1050
fixture tokens are expected, within the pinned seven-run ceiling. Separate native
contribution-wait qualification exercises dependencies/recovery with wake enqueue
intercepted before provider dispatch. Model/GitHub seams are deterministic; live
production installation, effective external grants and model judgment are separate.
