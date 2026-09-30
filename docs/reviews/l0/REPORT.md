# Paperclip Council L0 — verified foundation review

Date: 2026-09-30 (Europe/Paris)

Runtime-tested candidate: `7fcf5c7716c71905b60b2fbe2ac89955353a334a` on `codex/council-l0`

Implementation commit: `939c49ad4b170652f4b1adc1f85c87a8a7ab5082`

Base: `4cf7127880f4847a46cf1fdefa5acd5de5593206` (`origin/main`)

Host: `/home/davy-lp/workspace/paperclip` at `61b3fd57a695614dc4a37e2303f426a34a9795cf`

## Verdict

**L0 is PARTIAL / keep-open.** The mandatory real migration and competing-CAS proof passes, the exact candidate passes build/typecheck/unit tests, and G2 plus the addressed-human interaction mechanics of G4 pass through the installed plugin bridge. L0 is not a full PASS because the pinned host exposes no canonical SDK/API readback of `issue_execution_decisions` with actor/run/body/effect after an uncertain response, exposes no Council-wide atomic task/period budget reservation API, and the probe does not enforce the contractual owner/mandate/submission binding. Those gaps block the dependent L3 reconciliation claim and L2 hard aggregate-limit claim respectively; owner-bound continuation also remains unqualified.

This verdict does not qualify Council V1, durable activation, a full UI, multi-version compatibility, provider behavior, or external delivery.

## Findings first

1. **High — G3 canonical decision readback is unavailable.** The native PATCH persists a decision and effect atomically, and the harness observes `executionState`, comments, activity, and the underlying persisted actor/run. However, neither the public API nor the plugin SDK returns the canonical decision row by `lastDecisionId`. Correlation after a deliberately uncertain client response is therefore not formally self-sufficient. L3 decision reconciliation remains blocked pending a supported readback projection.
2. **High — G4 aggregate limit reservation is unavailable.** The SDK exposes cost summaries, budget incidents, wakeups and native agent controls, but no atomic Council task-plus-period reservation surface. The plugin namespace can CAS a Council-owned envelope, but that alone cannot prove the native runtime maximum exposure. L2 dispatch under a claimed hard aggregate cap remains blocked until the guarantee is narrowed or a supported reservation/enforcement contract exists.
3. **Medium — contractual owner identity/binding is not enforced.** The route accepts an `ownerUserId` supplied by the configured Council agent and the host proves that the addressed active human replied. It does not prove that this user is the configured mission owner or bind the interaction to a mandate/submission revision. The runtime result is therefore limited to addressed-human wait/response mechanics; owner-bound continuation remains blocked for later implementation.
4. **Medium — maintenance and UI are contract-inspected only.** UI slots/data/actions/streams and jobs/routines exist in the pinned host. No L0 UI or recurring maintenance behavior was implemented or executed, as required by the lot boundary.

## Changes bounded to L0

- Plugin version `0.1.2`; SDK/shared pins remain `2026.916.1` and Node remains `>=24.11.0`.
- One immutable migration creates `foundation_probes` inside the host-derived namespace.
- One diagnostic plugin route exercises namespace CAS, attachment-byte/Git-bundle verification, and addressed owner interaction readback.
- Candidate verification enforces a 32 MiB bound, recalculates SHA-256, writes only to a disposable directory, calls Git with argument arrays (no shell interpolation), verifies fixed bundle refs, checks both commit identities and proves base ancestry, then removes the directory.
- Existing decision route, manifest/current-candidate preflight and public-PATCH adapter remain in place.

## L0 matrix

| Lot | Evidence | Status |
| --- | --- | --- |
| L0-A — base/non-regression | Git base gate passed at `4cf7127`; candidate `7fcf5c7` was clean; `pnpm typecheck`, `pnpm test` (30/30), `pnpm build`; functional harness rebuilt the exact archived commit | PASS |
| L0-B — G1/persistence | Real plugin install/restart applied `001_foundation_probe.sql`; two concurrent authenticated plugin-route requests with expected version 0 produced exactly one 200 and one 409; both observed final version 1 and the same winner | PASS |
| L0-C — G2/G3/G4 seams | G2 byte/digest/bundle/base ancestry PASS; native decision flow and ordinary readback PASS but uncertain-response canonical readback blocked; addressed fixture-human pending/response mechanics PASS but contractual owner binding and aggregate budget reservation blocked | FAIL |
| L0-D — delivery/review | Replay commands and local runtime trace exist; proof manifest validates; independent findings-first review completed and its medium owner-binding finding is incorporated below | PASS |

## Gate detail

| Gate | Result | Dependent work |
| --- | --- | --- |
| G1 | PASS for pinned host/package contract, migration, runtime SQL CAS row count, route actor/company context; UI and maintenance contracts inspected but not executed | The persistence-dependent part of L1 can start on the pinned host; no broader compatibility claim |
| G2 | PASS for a self-contained Git bundle: company-scoped attachment bytes, bounded read, recomputed digest, isolated Git repository, exact base/head and ancestry | L3 may use this narrow bundle profile; thin bundles and arbitrary artifact types remain unsupported |
| G3 | PARTIAL / BLOCKED for uncertain-response reconciliation because canonical decision actor/run/body/effect readback is absent from supported API/SDK | Do not implement or claim L3 applied acceptance recovery until the readback contract exists or the product guarantee is explicitly narrowed |
| G4 | PARTIAL: addressed `human_only` pending state, attributed fixture-human response and readback PASS; configured-owner/mandate/submission binding, Council-wide task/period reservation and native maximum-exposure proof BLOCKED | Do not claim owner-bound continuation or enable L2 dispatch under a claimed hard aggregate cap; UI/maintenance execution remains for later lots |

## Replay and evidence

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
COUNCIL_PACKAGE_EXPECTED_COMMIT=7fcf5c7716c71905b60b2fbe2ac89955353a334a \
  PAPERCLIP_TEST_HOST_ROOT=/home/davy-lp/workspace/paperclip \
  pnpm test:functional
```

The runtime trace is `artifacts/functional.json` (git-ignored by design), SHA-256 `ef6b7f9f880a472477a16a8d9437fb447ef8b2a8183c6b0e35a78661515eaa08`. It records an isolated authenticated/private instance, fresh embedded PostgreSQL, native secret storage, real plugin install/restart, no model calls, synthetic setup actors, PASS results, and cleanup of only the created app/database/runtime resources. The first G2 attempt failed because the harness upload route and the plugin bridge used different local-storage roots; the harness was corrected to configure both to the same isolated provider, the candidate was recommitted, and the successful exact-candidate run above replaced that failed attempt as closure evidence.

## Reports and next action

- Deferred: full mission aggregates, rosters, UI, orchestration, opinion aggregation, learning/memory, multi-version hardening, provider calls and durable activation.
- Smallest G3 unblocker: add a supported company-scoped read surface for the native execution decision named by `executionState.lastDecisionId`, including actor/run/body and applied effect projection, then replay an intentionally uncertain response.
- Smallest G4 limit unblocker: define and qualify the supported atomic task/period reservation plus native in-flight exposure contract, or explicitly narrow the product guarantee before L2 dispatch.
- Smallest owner-continuation unblocker: resolve the configured mission owner from authoritative persisted state and bind the interaction to the exact mandate/submission revision before treating its response as a Council owner decision.
- Stop here: L1–L6 were not implemented.

## Independent final review

The independent findings-first review of runtime candidate `7fcf5c7` found no additional blocker in the SQL migration/CAS, decision-route authentication, G2 issue-attachment binding/isolation, artifact hash or exact-candidate replay. It raised one medium claim-alignment finding: the probe demonstrates an addressed fixture-human response, not contractual owner identity or mandate/submission binding. This report and proof manifest incorporate that limit. The review agreed that `PARTIAL / keep-open` is the defensible verdict.
