# M1 real mission — blocked before correction

The real mission produced candidate `49e92ffb91a5baf8c50d78518ce99e109aa6c0f7`, but **M1 remains incomplete**. The ordinary controller rejected the Council terminal report with HTTP409 `ordinary_report_missing`. No correction, accepted candidate, GitHub branch/PR, installed accepted build or browser observation followed. No model retry was attempted.

The Council agent obeyed the final-report contract. Its complete final message in the public run log is structurally identical to the prepared, candidate-bound report. The host persisted an oversized 68,809-byte result as `truncated:true`, `truncationReason:oversized_result_json`, leaving `resultJson.summary` at 500 characters, inside the rationale string. The consumer cannot parse that truncated JSON. This is a concrete terminal-readback boundary failure, not a fabricated model verdict or an agent that forgot its report.

Development and Quality independently requested correction for a real V1 defect: a closed/non-open PR has the correct danger status but an actionable reference incorrectly labeled `open`. Council synthesized that objection into `changes_requested`; it has **not been applied** to N2. `correctionsUsed` remains 0, N2 remains `reviewing`, and there is no acceptance receipt. The lead's canonical checks and Development's independent repeat reported typecheck/build and 394 tests passing; those tests did not catch this label contradiction.

Execution used merged source `dd6e4a388bb13ef432daa7071ceeb47d5a895a3b`, readonly host `61b3fd57a695614dc4a37e2303f426a34a9795cf`, and seven distinct configured `codex_local` CLI agents on `gpt-5.6-sol` / `medium`. User authorization covered this single real mission, up to 12 runs, 2M reserved per run, 24M period allowance, one cumulative correction and no retries. Preparation flags remained false because preparation itself launches nothing; subsequent owner activation was authorized explicitly.

| Role | Run | Result | Settled tokens |
| --- | --- | --- | ---: |
| Lead | a3cb3adf-4c43-48c4-b524-85c7e4ba9713 | succeeded | 1,754,203 |
| Backend | 8903a13d-d7eb-46f5-8069-69542917a730 | succeeded | 542,451 |
| Frontend | 6afa0096-5fd6-4e00-86f2-d0b12e65175c | succeeded | 786,682 |
| Development | 6e0d2689-fcf9-4a80-a1ac-9bd733839040 | succeeded | 490,268 |
| Quality | 3a9b5cb4-41c4-4ee7-9bba-5309a5c14ad7 | succeeded | 319,298 |
| Council | c0f999dd-16b2-4fbe-bbd9-9633b242699c | succeeded | 338,657 |

All six reservations settled: **4,231,559 tokens**, input plus output with cached input counted once. Monetary cost is `unpriced` / `subscription_included`, not a measured zero-dollar cost. No unknown usage or residual reservation exposure remains; no surprise run occurred. Publisher did not run.

Owner assistance was explicit: activate/start once, hold lead demand wakes, close each N1 child only after actual terminal status and settlement, settle lead, bind N5 to the refined plan revision, restore lead demand wakes, start review, and call deterministic reconciliation after specialist terminalization. The installed plugin created/admitted each review stage. The owner never implemented UI, substituted opinions, applied a verdict manually or repaired the live consumer.

The session was frozen with all seven agents paused and demand wakes false. Before cleanup, a complete native DB backup was taken with the pinned host's existing JavaScript backup engine; storage, native logs and managed instructions were archived privately. Codex homes/provider auth and GitHub credentials were excluded; `adapter_auth_sessions` was empty. Backup directory is mode0700 and files0600, locally Git-excluded. The fresh instance encryption key is kept only in that private archive. **Restoration was not tested**; stored paths and authentication need controlled reconciliation before a future authorized continuation. Cleanup then completed with launcher exit0, `session.state=stopped` and `ownedRuntimeRemoved=true`. That exit describes session lifecycle, not a successful delivery campaign.

Evidence and bounded replay:

- [observation.json](observation.json) contains exact identities, six real usages/reservations, N3 opinions, prepared/full/truncated Council report, cleanup and hashes of 141 local request/readback artifacts.
- `artifacts/ordinary-campaign-m1-v1.bundle` preserves the actual V1 and its two contribution commits; SHA256 `1b748e961fa7b2f1a489b424eca3b4c5af5a1ff6bf75765037bf3fd7f1b0ccb6`. `git bundle verify` exit0.
- Session: `artifacts/ordinary-campaign-session-dd6e4a388bb13ef432daa7071ceeb47d5a895a3b.json`; launcher log: `artifacts/ordinary-campaign-session-dd6e4a3.log`.
- Exact public Council log: `artifacts/ordinary-campaign-m1-readbacks/20261004T174023.765062Z-final-log-c0f999dd-16b2-4fbe-bbd9-9633b242699c.json`, SHA256 `7a8ba9aa3d9b686ad127ae4ea86a28e31746690edfdc44bbda5373e3bd2f7f6c`. Read with authenticated `GET /api/heartbeat-runs/c0f999dd-16b2-4fbe-bbd9-9633b242699c/log` using the private owner curl config. The saved request/response envelope contains `response.content`: 30 NDJSON rows of `{ts,stream,chunk,seq}` (171,462 characters). Stdout chunks contain CLI JSON events; the final `item.completed` agent message is the exact report, followed by `turn.completed`. The deleted URL was `http://127.0.0.1:38459`; offline files remain readable.
- Private backup inventory: `artifacts/ordinary-campaign-m1-private/backup-manifest.json`. These local artifacts are intentionally not published in Git.
- `python3 docs/reviews/m1-live/verify-observation.py` exit0 verifies the recorded failure and settled accounting, without a provider or runtime. The proof-manifest validator returns `partial`, closure not allowed.

Invocation used `PAPERCLIP_TEST_HOST_ROOT="$PWD/.paperclip/qualification/paperclip" node scripts/qualification/run-ordinary-campaign.mjs session .paperclip/qualification/ordinary-campaign-profile.json`. Owner requests and results are recorded individually; stop used the same launcher's `stop` subcommand with the exact session evidence path. No new source changes, static campaign, provider probe or second qualification were performed by the operator.

Next step: repair and qualify the consumer's handling of exact, attributed complete reports when public summary is truncated, then qualify native-state restoration before any explicitly authorized continuation. Preserve the six valid runs, actual V1, settled budget and unused single correction. N6 and M1 publication/UI claims remain open.

[Proof Gate Output V1]
Date de reference: 2026-10-04 Europe/Paris
Proof ID: council-m1-live-dd6e4a3-20261004
Subject: One real ordinary-cli-v1 Delivery UI mission through Council terminal readback
Status: partial
Summary: Real candidate and six settled runs preserved; truncated terminal report blocks verdict application and delivery.
Categories: functional, operations
Evidence Count: 3
Replay Procedure: python3 docs/reviews/m1-live/verify-observation.py; git bundle verify artifacts/ordinary-campaign-m1-v1.bundle
Closure Decision: keep-open
Closure Rationale: No applied verdict, accepted candidate, publication or accepted-build browser observation.
Next Required Actions: Qualify terminal-report recovery and paused native-state restoration before authorized continuation.
Linked Manifest: docs/reviews/m1-live/proof-manifest.json
