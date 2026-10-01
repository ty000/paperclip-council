# N1 — two contributors and an integrated candidate

Updated: 2026-10-01 (Europe/Paris). Scope: Council package on the pinned, ephemeral Paperclip host. The source candidate now contains the installed native path needed for the observable N1 exit. N1 is complete for a particular commit only when `artifacts/n1-live.json`, generated from that clean commit, reports `N1 OBSERVABLE RESULT VALIDATED`; source checks or the historical fixture replay do not substitute for that result.

## Supported operating profile

Council supports one intentionally narrow native profile, configured per company as `paperclip-orchestration-tokens-v1`:

- one identified company, project, mission and period;
- one Integration Lead plus two contributors; contributors run sequentially while the lead remains active;
- fixed limits `maxConcurrent=2`, `maxRetries=0`, `maxCorrections=0`;
- explicit token allowance and per-run reservation estimate supplied by `n1OperatingProfile`;
- launch refusal when Paperclip reports an invocation block, open budget incident or prior run on the target issue;
- settlement only from the exact terminal run returned by `issues.summaries.getOrchestration`, using input, cached-input and output tokens;
- zero monetary cost labelled `unpriced`, and zero reported tokens treated as unavailable rather than zero consumption.

This is an admission control, not a provider billing engine or an absolute future-cost ceiling. The configured reservation is exposure, while terminal tokens are observed consumption. The pre-existing atomic reservation CAS, persistent unsettled state and no-blind-retry rules remain unchanged. No schema or migration change was needed.

## N1 acceptance map

| Criterion | Implemented gate | Exact-candidate runtime proof |
| --- | --- | --- |
| N1-A1 activation and identity | Mission pins exact active team/Council revisions and root ownership before activation. Native `start-lead` stores the Paperclip wakeup run ID; fixture binding remains test-only. | `liveN1.mission`, roster setup steps and lead run in `artifacts/n1-live.json`. |
| N1-A2 G4 admission | Canonical profile validation, one reservation per launch, two active runs at most, no retry/correction, host budget/invocation checks, sequential child settlement and terminal token accounting. | `liveN1.admission` has exactly three settled reservations and positive run-derived usage; all three native run IDs are recorded. |
| N1-A3 native effects | Lead and contributor commands require the mapped authenticated run and native checkout. Child creation remains claim-before-effect and correlated; uncertain results stop without retry. | Installed trace shows native root wake, two native child issues, two child wakeups and exact run-to-contribution binding. |
| N1-A4 contributions and integration | Two distinct contributors, disjoint owned paths, attributed single-parent commits and a separate integration commit are required. | `liveN1.mission.mission.aggregate.n1.contributions` and the verified candidate bundle. |
| N1-A5 publication | Publication requires both terminal usage settlements and the checked Git bundle. Failed verification records `integration_check_failed` without a candidate. | Journal contains the single forced invalid integration; the later candidate has `outcome=verified` and `publicationEligible=true`. |
| N1-A6 inspection | The mission UI shows phase, next action, participants, child/run state, commits, candidate, measurement status/source, usage, remaining exposure and blocker. | `artifacts/n1-live-ready-for-review.png` plus the installed browser result in the JSON evidence. |
| N1-A7 replayability | The live launcher requires a clean committed candidate, exact pinned Paperclip host, explicit provider authorization, exact model/effort and explicit positive run/period token bounds. | Candidate SHA, host SHA, native IDs, results, cleanup and generated evidence path are recorded by the launcher. |

The reviewer is provisioned and pinned but is not woken. N1 stops at `ready_for_review`; N2 owns review/correction/acceptance, and N5 owns Council-driven PR publication.

## Replay

The historical no-provider safe-boundary proof remains canonical at `qualification/proof-manifest.json` and is replayed with `pnpm qualification:bounded`. It proves fixture guards only.

The native proof is deliberately a separate authorized command:

```bash
COUNCIL_N1_LIVE_AUTHORIZED=1 \
COUNCIL_N1_LIVE_MODEL=gpt-5.6-sol \
COUNCIL_N1_LIVE_EFFORT=high \
COUNCIL_N1_LIVE_RUN_UNITS=<positive-reservation> \
COUNCIL_N1_LIVE_PERIOD_UNITS=<at-least-three-times-reservation> \
corepack pnpm qualification:live:n1
```

The launcher refuses a dirty/uncommitted candidate, missing Codex auth, an unprepared host, a model/effort substitution or an insufficient allowance. It creates only an owned ephemeral Paperclip instance and repository, uses native board APIs for the live company/project/agents/issues, installs this exact package, runs one lead and two contributors, captures browser evidence, and removes its owned runtime after shutdown. It never wakes the reviewer or creates a PR through Council.

## Council/Paperclip contract

Read-only inspection of pinned Paperclip `61b3fd57a695614dc4a37e2303f426a34a9795cf` established that SDK `2026.916.1` exposes `ctx.issues.summaries.getOrchestration`. The summary includes exact issue runs, terminal state/timestamps, aggregated token counts and cost cents, open budget incidents and invocation blocks. Paperclip owns those native observations and the run lifecycle. Council owns profile validation, admission/reservation policy, mission correlation, settlement, candidate verification, tests and delivery evidence. No Paperclip source was modified.

## Receipts suite diagnosis

The isolated receipts test had a genuine harness race unrelated to decision-receipt semantics: it opened an ephemeral TCP port, closed the probe, and only then asked PostgreSQL to bind the released port. A concurrent process could claim that port. The harness now uses the unique owned temporary directory as a PostgreSQL Unix-socket directory, removing the probe-and-release window. Missing `PAPERCLIP_TEST_HOST_ROOT` or Playwright browser configuration are deterministic launch-precondition failures, not this flake. Qualification requires the pinned read-only host and repo-owned browser cache. After the change, one direct validation and ten further complete repetitions passed all nine receipt checks.

## Remaining limits and decision rule

- Subscription-backed runs can be token-observed but monetarily `unpriced`; Council does not fabricate a currency value.
- If Paperclip returns a terminal run with no tokens, G4 stays unsettled and blocks publication.
- A lost child-create or wake response remains an explicit unknown requiring manual reconciliation; there is no automatic general recovery engine.
- Admission and mission rows are separate plugin-private CAS operations. A genuine crash after reservation can conservatively strand capacity until explicit reconciliation.
- This increment does not qualify N2, N3, N4, N5, N6, Executive L03 or full V1 availability.

Verdict is evidence-dependent: `complete` only for the exact commit whose live artifact has the required outcome and all named results `PASS`; otherwise `partial / keep-open`. Mergeability and merge status remain separate.
