# Paperclip Council L2 — Step A mission persistence review

Date: 2026-09-30 (Europe/Paris)

Runtime-tested candidate: `cdd989f0072676777840ab9fc701a9b84ca90dca` on `codex/council-l2`

Base: `bfa921000c0743aff17d2c1e48eff6bb9ca365cf` (`origin/main`, merged S1)

Host: isolated clean checkout of `/home/davy-lp/workspace/paperclip` at `61b3fd57a695614dc4a37e2303f426a34a9795cf`; SDK/shared `2026.916.1`

## Findings

- **[High, blocks L1 closure] The persisted mission is deliberately draft/inactive.** The real installed bridge proves that exact roster revisions are pinned and survive later roster revision, suspension, retirement and restart. It does not prove the implementation-plan criterion on an active mission because G4 still forbids activation/dispatch. L1 therefore remains **PARTIAL / keep-open**.
- **[High, blocks L2 closure] G4 remains unresolved.** No supported task/period reservation plus in-flight exposure contract was supplied in this run. The implementation exposes `runtime_budget_exposure: unsupported`, `execution: blocked` and no activation/dispatch command. Contribution plans, child-issue effects, integration and submission publication were not implemented. L2 therefore remains **PARTIAL / keep-open**.
- **[Medium, does not block Step A] G3 remains unresolved.** Canonical native-decision readback after an uncertain response is still unqualified. Step A creates no decision effect and does not retry one, so this gap is preserved rather than bypassed.
- **[Low] The replay retains pre-existing host warnings.** The pinned host emits the known plugin-schema/Vite/websocket warnings already reported by S1. They did not invalidate the mission storage path and were not remediated in this lot.

## Delivered boundary

The bounded **Step A mission-persistence slice passes locally**:

- additive `003_missions.sql` in the plugin-private namespace, preserving migrations `001` and `002`;
- one company-scoped mission per Paperclip root issue, with project, configured owner, mandate/limit declaration, exact team/council revision foreign keys, responsible lead/reviewer and control/readiness state;
- board-authenticated create/list/read and draft mandate-update routes;
- owner authority derived from `company.defaultResponsibleUserId`, including list/detail inspection guards, with company/project/root-issue checks;
- mission insertion conditional on both roster heads remaining active and on the exact selected revisions in one locking SQL statement, so concurrent revision/suspension/retirement either serializes after creation or refuses selection;
- idempotent creation receipts and CAS mandate updates; same command/same payload replays, conflicting identity/payload or stale concurrent updates are refused;
- minimal inspection distinguishes `recorded`, `compositionsPinned` and `executable: false`, with G3/G4 prerequisites visible;
- no external effect intent, child issue, wakeup, provider/model call, dispatch, activation, participant replacement or L3–L5 behavior.

This closes only the local Step A implementation slice. It does not close L1, L2, V1, G3 or G4.

## Runtime evidence

- Trace: `docs/reviews/l2/evidence/functional.json`
- Trace SHA-256: `a4319d560035dbd98bb5c2ded7048d7b1e731447cd385a7b3361950229d28cd2`
- Candidate source archive SHA-256: `3ef47e2bf381c48a9cad70ddc674e378cbf53da5a2d93eec65448bac10228e61`
- Built distribution SHA-256: `7dd843226d66d9726ddb88ced8b89e2fa8182ec34f526bfc913dd45bee84cde5`

The replay installed the exact clean candidate on a fresh authenticated/private Paperclip application and embedded PostgreSQL database. It passed owner/intruder mutation and list/detail read authorization, structured missing-roster refusals, idempotent create and identity conflict, replay after revision/retirement/restart, competing mission CAS with one winner, three create-versus-suspend contentions, deterministic create-before-suspend persistence and suspend-before-create refusal, pinned revision survival, refusal of retired-roster selection for a new mission, and complete inspection readback after plugin/application restart. It also reran the inherited S1/browser and earlier bounded decision paths. All 31 named results passed. All fixtures were synthetic, no model was invoked, credentials were omitted from evidence, and the isolated app/database/runtime were cleaned.

## Replay

```bash
COREPACK_HOME=/tmp/council-l2-corepack corepack pnpm install --offline --frozen-lockfile
COREPACK_HOME=/tmp/council-l2-corepack corepack pnpm typecheck
COREPACK_HOME=/tmp/council-l2-corepack corepack pnpm test
COREPACK_HOME=/tmp/council-l2-corepack corepack pnpm build
git diff --check

# Prepare an isolated clean Paperclip checkout at the pinned host revision and
# link only its existing node_modules directories, as in the S1 replay.
COREPACK_HOME=/tmp/council-l2-corepack \
COUNCIL_PACKAGE_EXPECTED_COMMIT=cdd989f0072676777840ab9fc701a9b84ca90dca \
PAPERCLIP_TEST_HOST_ROOT=/tmp/<isolated-host>/paperclip \
PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH=/home/davy-lp/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
COUNCIL_PACKAGE_EVIDENCE_PATH="$PWD/docs/reviews/l2/evidence/functional.json" \
corepack pnpm test:functional
```

Expected: typecheck/build succeed; 7 test files and 50 tests pass; functional output ends with `L2 STEP A MISSION PERSISTENCE VALIDATED`; all 31 named mission/package results are `PASS`; host/candidate cleanliness is true.

## Independent-review remediation

The first independent review rejected candidate `36b43076` on two Step A defects: mission creation checked active/current roster heads before a separate insert, leaving a lifecycle race, and board reads exposed mission aggregates to a non-owner company user. Candidate `4ee1930c` resolved both. The PR review loop then found that an identical create retry consulted mutable admission state before its persisted receipt, roster-domain errors escaped the mission API boundary, and a duplicate already in flight could still miss a receipt committed during mutable admission. Candidate `99680880` added initial and error-path identity readback. Pre-rebase candidate `b1132f59` made that identity readback a single deterministic database snapshot and preserved the original admission error when fallback storage lookup failed. Rebased candidate `cdd989f0` was replayed exactly against the pinned host after incorporating current `main`. Earlier failed or superseded runs remain diagnostic history and are not closure proof.

## Status handoff

| Item | Status | Reason / next gate |
| --- | --- | --- |
| Step A delivered | **PASS / local commit** | Mission persistence, exact revision pinning, inspection, auth, CAS and restart proof are present. |
| L1 remainder | **PARTIAL / keep-open** | Draft mission pinning is proven; active-mission pinning is not, because activation is blocked. |
| L2 | **PARTIAL / keep-open** | No dispatch, contribution graph, native child creation, reservations, integrated candidate or review submission. |
| G3 | **OPEN** | No canonical uncertain-decision readback contract or replay was added. |
| G4 | **OPEN / blocks activation** | No approved and runtime-qualified task/period/in-flight reservation contract was received. |
| Actual activation | **NON EXÉCUTÉE / unavailable** | There is intentionally no activation or dispatch route in this slice. |

The smallest next action is an explicit owner decision on G4 followed by technical qualification of the selected contract. Only then may the remaining L2 plan/effect/integration work begin. Stop before L3.

## Proof gate

[Proof Gate Output V1]
Date de reference: 2026-09-30 (Europe/Paris)
Proof ID: paperclip-council-l2-step-a-2026-09-30
Subject: Bounded local Step A mission persistence at candidate cdd989f0072676777840ab9fc701a9b84ca90dca
Status: pass
Summary: The exact clean candidate provides replayably verified private mission persistence, immutable roster-revision pinning, owner and scope guards, command identity/CAS, explicit G4 blocking and restart survival without activation or dispatch.
Categories: functional, quality, compliance, documentation, operations
Evidence Count: 5
Replay Procedure: docs/reviews/l2/REPORT.md#replay
Closure Decision: close-final
Closure Rationale: The bounded Step A slice has no remaining blocking criterion; broader L1/L2/G3/G4 claims remain explicitly open and are outside this closure.
Next Required Actions: Obtain and qualify an explicit G4 contract before activation/dispatch; then implement the remaining L2 contribution and integration behavior without entering L3.
Linked Manifest: docs/reviews/l2/proof-manifest.json
