# N1 — two contributors and an integrated candidate

Updated: 2026-10-01 (Europe/Paris). Scope: Council package on the pinned, ephemeral Paperclip host. The source candidate now contains the installed native path needed for the observable N1 exit. N1 is complete for a particular commit only when the create-only `artifacts/n1-live-<commit>.json`, generated from that clean commit, reports `N1 OBSERVABLE RESULT VALIDATED` and the exact JSON and screenshot digests are published in a durable review record. Local ignored files, source checks and the historical fixture replay do not substitute for that record.

## Supported operating profile

Council supports one intentionally narrow native profile, configured per company as `paperclip-orchestration-tokens-v1`:

- one identified company, project, mission and period;
- one Integration Lead plus two contributors; contributors run sequentially while the lead remains active;
- fixed limits `maxConcurrent=2`, `maxRetries=0`, `maxCorrections=0`;
- explicit token allowance, per-run reservation, initial known usage, initial exposure and accounting provenance supplied by `n1OperatingProfile`;
- launch refusal when Paperclip reports an invocation block, open budget incident or prior run on the target issue;
- settlement only from the exact terminal run returned by `issues.summaries.getOrchestration`; for the pinned Codex CLI path, `inputTokens` already includes `cachedInputTokens`, so consumption is `inputTokens + outputTokens` while cached input remains a separately preserved diagnostic counter;
- zero monetary cost labelled `unpriced`, and zero reported tokens treated as unavailable rather than zero consumption.

The owner accepted this profile as an N1-only bounded pilot on October 1, 2026. This is an admission control, not a provider billing engine, a general qualification of DEC-G4-01, permanent provider authorization or an absolute future-cost ceiling. Allowance, reservations, usage and exposure in the admission envelope are token-denominated. Initial usage and exposure are never inferred: the profile requires both amounts plus a source identifying their company/period readback or bounded fresh-period attestation. Configured `known/0` therefore means the named source establishes no prior token usage/exposure for that period, not zero monetary exposure. Monetary cost remains separately `unpriced` when unavailable. The configured reservation is token exposure, while terminal tokens are observed consumption. The pre-existing atomic reservation CAS, persistent unsettled state and no-blind-retry rules remain unchanged. The native operating profile required no additional migration beyond the additive `005_admission.sql` already included in this increment.

## N1 acceptance map

| Criterion | Implemented gate | Exact-candidate runtime proof |
| --- | --- | --- |
| N1-A1 activation and identity | Mission pins exact active team/Council revisions and root ownership before activation. Native `start-lead` stores the Paperclip wakeup run ID, then the harness disables further on-demand lead wakeups; fixture binding remains test-only. | `liveN1.mission`, `liveN1.leadRunBarrier`, and the exact-one lead run readback in the commit-qualified live evidence JSON. |
| N1-A2 G4 admission | Canonical profile validation, one reservation per launch, two active runs at most, no retry/correction, host budget/invocation checks, sequential child settlement and terminal token accounting. | `liveN1.admission` has exactly three settled reservations and positive run-derived usage; all three native run IDs are recorded. |
| N1-A3 native effects | Lead and contributor commands require the mapped authenticated run and native checkout. Child creation remains claim-before-effect and correlated; uncertain results stop without retry. | Installed trace shows native root wake, two native child issues, two child wakeups and exact run-to-contribution binding. |
| N1-A4 contributions and integration | Two distinct contributors, disjoint owned paths, attributed single-parent commits and a separate integration commit are required. | `liveN1.mission.mission.aggregate.n1.contributions` and the verified candidate bundle. |
| N1-A5 publication | Publication requires both terminal usage settlements and the checked Git bundle. Failed verification records `integration_check_failed` without a candidate. | Journal contains the single forced invalid integration; the later candidate has `outcome=verified` and `publicationEligible=true`. |
| N1-A6 inspection | The mission UI shows phase, next action, participants, child/run state, commits, candidate, measurement status/source, usage, remaining exposure and blocker. | `artifacts/n1-live-<commit>-ready-for-review.png` plus the installed browser result in the commit-qualified JSON evidence; these paths identify the required proof shape, not a concluded live result. |
| N1-A7 replayability | The live launcher requires a clean committed candidate, exact pinned Paperclip host, explicit provider authorization, exact model/effort and explicit positive run/period token bounds. | Candidate SHA, host SHA, native IDs, results, cleanup and generated evidence path are recorded by the launcher. |

The reviewer is provisioned and pinned but is not woken. N1 stops at `ready_for_review`; N2 owns review/correction/acceptance, and N5 owns Council-driven PR publication.

## Authorized runtime observation — 2026-10-01

The authorized campaign on clean commit `5d70ce1b7f43356dd47e5002284b1fa398bc863c` did not reach the N1 exit. Its hash-recorded local artifact is `artifacts/n1-live.json`, SHA-256 `29dd843ee7de171c841cded74d9b8ea9184da94d5ef0dbcf3175e8a24a38715d`, with outcome `NON-CONCLUSIVE OR BLOCKED`; this ignored workspace file is not an immutable archive.

- The root Integration Lead was dispatched through native Paperclip run `0e6e6b3a-6e98-49a7-b2af-b194bbcf4b19`.
- Contributor Alpha was dispatched, created the requested file, then could not commit because Codex workspace-write protects `.git`. Contributor Beta was not dispatched and no candidate was published.
- Blocker handling attempted unsupported `status=blocked` PATCHes. The root summary then contained an additional run, `e7361623-b652-4f4b-b816-f7172d7d5a2c`; this is consistent with the pinned host's native behavior of waking an assigned agent when an issue comment is created, but the torn-down runtime no longer permits direct readback of the triggering comment.
- G4 correctly refused lead settlement with `g4_run_identity_unqualified` because the root orchestration summary contained both run IDs. No usage was guessed or settled against the wrong run.
- The lingering second run was interrupted after the ephemeral database had shut down and could no longer persist output. There was no provider retry or correction run.

The triggering action for the extra historical lead run cannot be reconstructed exactly after teardown. The pinned host already suppresses ordinary self-comment wakeups, so the old artifact is insufficient to attribute the run to one specific API call. The correction therefore does not depend on that attribution: after `start-lead` returns the expected native run ID, the harness immediately patches the lead heartbeat policy to `wakeOnDemand=false`; the live evidence contract then requires a final native readback containing that run ID and no other lead run.

Candidate `c8aeba62da406130593e73f81161d5caac6480b3` kept both sandbox layers active and gave only the lead and two contributors one additional Codex writable root: the live repository's own `.git` directory. Its single authorized campaign preserved `artifacts/n1-live-c8aeba62da406130593e73f81161d5caac6480b3.json` with SHA-256 `f3fb2c3346563306c649fc2eb24d123d2151b33b9a99627c46f6bf45c2eb7138` and outcome `NON-CONCLUSIVE OR BLOCKED`. Native lead run `8aba4dc2-72dd-48ee-95ff-5badfd513838` failed before Codex started because the pinned Paperclip `filesystemScope=workspace` Bubblewrap command created `/bin` as a `/usr/bin` symlink and then attempted to bind-mount the host `/bin` onto it. No contributor ran, no usage was settled and no candidate was published. Cleanup removed the owned runtime without error; the commit-qualified screenshot remained empty and is not UI evidence.

The operator then selected the Council-only alternative: delivery agents omit the outer Paperclip filesystem scope and invoke Codex with explicit `workspace-write`, workspace network access for authenticated Paperclip API calls, `dangerouslyBypassApprovalsAndSandbox=false`, and only the campaign repository's `.git` as an additional writable root. This avoids the host Bubblewrap incompatibility without changing Paperclip core. It intentionally gives the Codex process the host-read visibility of the native Codex workspace sandbox; host writes remain limited by Codex to the workspace plus that same repository-local `.git`. A local model-free sandbox probe demonstrated that default workspace-write refuses `.git/index.lock`, while the same profile plus that exact nested `.git` root can commit. Unit/contract tests enforce the adapter configuration, exact-one lead-run readback and evidence rejection on any added lead run. These are implementation and local proof; only a newly authorized native campaign can establish the runtime result.

Candidate `3a842b924384a29044e8f073945b68389f3c238b` used that Council-only sandbox alternative in one authorized campaign. The preserved artifact `artifacts/n1-live-3a842b924384a29044e8f073945b68389f3c238b.json`, SHA-256 `0f3c2282ca2d9a75ab0000bd5896047bdcd0593986afd621d0a076da137a6b41`, reports `NON-CONCLUSIVE OR BLOCKED`. Lead run `e35d620d-d15d-4837-b6b7-8a1dd90c8079` and Alpha run `b50c0a38-eb7c-40c5-a4c9-67c80453d09e` both succeeded; Alpha recorded commit `9b5207dd687533399371a681ae4397b86470f41c`, proving that the narrow Git write correction works. G4 nevertheless settled Alpha at `1,177,291` units, exhausted the `180,000` period allowance and refused Beta dispatch. The campaign stopped with the mission still `executing`, no candidate, no screenshot and no retry. The lead reservation stayed open because the harness asserted `integrating` before sending `reconcile-lead-usage`.

That campaign exposed two local qualification defects now corrected for the pinned Codex CLI profile. OpenAI usage semantics make cached input a subset of input tokens, so G4 no longer adds it a second time. The harness now writes partial `liveN1` evidence as soon as the lead is requested and preserves an allowlisted accounting projection for each observed terminal run: normalized and raw input/cache/output counters plus the usage source.

Candidate `f1c89da275eb34cb573995da9f7d6756c53d4c39` used the corrected accounting and the proposed `2,000,000`-per-run, `6,000,000`-period envelope in one authorized campaign. The preserved JSON artifact has SHA-256 `bf678d2be5d129dff515a4bade7b8bbb8b1f01a426a4111d0c77b3093f1489cd` and outcome `NON-CONCLUSIVE OR BLOCKED`; its commit-qualified PNG is empty and is not UI evidence. Lead run `f37a56f1-196e-4d70-816c-3b1a34f1389b` succeeded and settled at `705,352` tokens (`698,217` input plus `7,135` output, with `648,320` cached input retained only as detail). Alpha run `caa04202-74c4-4c3e-b271-5a8a87cf16b1` also succeeded with `262,735` observed tokens (`260,472` input plus `2,263` output, with `227,456` cached), but its reservation remained open. Alpha sent an incomplete `{"command":"inspect"}` body and received HTTP 400, no contribution commit was recorded, Beta was not dispatched, and the mission remained active in `executing`. The envelope remained admissible with `3,294,648` units available including Alpha's reservation. There was no retry.

The follow-up local correction makes every generated contributor and lead instruction show the exact inspect body including `missionId`. A terminal child run is now reconciled immediately and independently of contribution success; settlement neither records a commit nor authorizes the next dispatch. The owner-side recovery command derives usage from the same exact terminal native run and reservation as the agent command. The harness captures the pre-lead-reconciliation phase, settles every observed terminal child and the lead, then requires the captured phase to be `integrating` and the resulting phase to be `ready_for_review`. Model-free tests cover both a complete two-child settlement path and a terminal child without a contribution, for which usage settles while the mission stays incomplete and no later child dispatch occurs.

The observed `2,000,000`-per-run and `6,000,000`-period envelope was not the blocker: it remained admissible after the lead and Alpha runs. Reservation remains admission exposure rather than a hard model cutoff; any new provider campaign still requires a fresh authorization naming its amounts.

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
sha256sum artifacts/n1-live-<commit>.json artifacts/n1-live-<commit>-ready-for-review.png
```

The launcher refuses a dirty/uncommitted candidate, missing Codex auth, an unprepared host, a model/effort substitution or an insufficient allowance. Its default evidence target is commit-qualified as `artifacts/n1-live-<commit>.json`, and it refuses any pre-existing configured or default target before host preparation or provider launch rather than overwriting evidence. It creates only an owned ephemeral Paperclip instance and repository, uses native board APIs for the live company/project/agents/issues, installs this exact package, runs one lead and two contributors, closes further lead wakeups after the expected run is returned, captures browser evidence, and removes its owned runtime after shutdown. It never wakes the reviewer or creates a PR through Council.

## Council/Paperclip contract

Read-only inspection of pinned Paperclip `61b3fd57a695614dc4a37e2303f426a34a9795cf` established that SDK `2026.916.1` exposes `ctx.issues.summaries.getOrchestration`. The summary includes exact issue runs, terminal state/timestamps, aggregated token counts and cost cents, open budget incidents and invocation blocks. Paperclip owns those native observations and the run lifecycle. Council owns profile validation, admission/reservation policy, mission correlation, settlement, candidate verification, tests and delivery evidence. No Paperclip source was modified.

## Receipts suite diagnosis

The isolated receipts test had a genuine harness race unrelated to decision-receipt semantics: it opened an ephemeral TCP port, closed the probe, and only then asked PostgreSQL to bind the released port. A concurrent process could claim that port. The harness now uses the unique owned temporary directory as a PostgreSQL Unix-socket directory, removing the probe-and-release window. Missing `PAPERCLIP_TEST_HOST_ROOT` or Playwright browser configuration are deterministic launch-precondition failures, not this flake. Qualification requires the pinned read-only host and repo-owned browser cache. After the change, one direct validation and ten further complete local repetitions were observed to pass all nine receipt checks; those repetition outputs were not archived as durable evidence.

## Remaining limits and decision rule

- Subscription-backed runs can be token-observed but monetarily `unpriced`; Council does not fabricate a currency value.
- If Paperclip returns a terminal run with no tokens, G4 stays unsettled and blocks publication.
- A lost child-create or wake response remains an explicit unknown requiring manual reconciliation; there is no automatic general recovery engine.
- Admission and mission rows are separate plugin-private CAS operations. A genuine crash after reservation can conservatively strand capacity until explicit reconciliation.
- Git import is bounded in layers by bundle size, command time, object counts and sizes, and repository-local Git memory settings; it is not hard OS/cgroup isolation and does not impose independent RSS, CPU or I/O ceilings.
- This increment does not qualify N2, N3, N4, N5, N6, Executive L03 or full V1 availability.

Verdict is evidence-dependent: `complete` only for the exact commit whose live artifact has the required outcome and all named results `PASS`; otherwise `partial / keep-open`. Mergeability and merge status remain separate.
