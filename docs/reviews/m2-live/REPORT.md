# M2 real campaign — partial, stopped before B integration

**Material blocker:** the B backend run created `71b5f95ab7428feb24049f2204b97b12446cd528` but recorded `71b5f95145410736c691552b836df8f20df3880e`. The latter is a valid-looking SHA that does not identify an object in the preserved Git history. The known successful `record-contribution` effect is immutable and contributor/run-bound; the lead has no existing repair command. It stopped normally before creating an integration candidate, rather than substituting a receipt or starting another contributor.

The original authorization was one fresh M2 campaign, 16 nominal/25 maximum runs, 2M reserved per run, 50M cumulative units, zero retries and at most one real correction per mission. Exact controller `01dabaa83ce3912c89f639b352aa1fc91531741d`, unchanged host `61b3fd57a695614dc4a37e2303f426a34a9795cf`, ten prepared distinct identities with effective CLI `gpt-5.6-sol`/`medium`. The first wake was 2026-10-04T20:38:51Z; the original period ending 23:05:00.481Z was not reset. Preparatory `providerAuthorized:false` remains a historical snapshot; actual user authorization is recorded separately.

A (`a077f010-e4de-4ec2-9db2-e0eb8b45405b`) completed two real contributions and one integration commit: **`7959f68ce586b8e0a75d26b1e80490ac26e0cb06`**. Two independent specialists supported the exact subject; Council accepted it after a reasoned synthesis. Its ordinary receipt was applied only after terminal per-run accounting. The retained legacy storage names `native_observed`/`nativeObservation` do not mean a runner native completion review. The lead's canonical checks passed typecheck/build and 443 tests. The operator ran the unchanged CI static gate once against `01dabaa`: wrapper PASS/exit0, underlying raw exit1, one moderate `coordinationStatus` finding; this is not a raw-clean claim.

B (`43b96da1-11fe-4c46-8ec2-6415ac29dc8b`) was configured against A's real submission before acceptance. PM chose medium-priority release without a remaining facilitation question; no facilitator or successor model run was manufactured. Its rationale prematurely called A accepted, but the controller kept B waiting on `n5_accepted_candidate_required`. Owner transferred coordination to the successor at a quiescent boundary, preserving the same guard/intent/reservation/activation/start IDs and run count. After actual A acceptance and settlement, N6 verified the exact native attachment and N1 reserved then launched B once. B authenticated the download, verified bundle SHA-256 `85e6306656fb3844de3e04ee70410e3de5dfc823cfe337da0e0c01036be54823`, checked accepted HEAD/ancestry, and preserved the GitHub origin.

B's real panel commit is **`71b5f95ab7428feb24049f2204b97b12446cd528`**; its frontend commit is **`0be2ff1f67bb97f4319ee2de25b6a1a711cf4afc`**, descending from that panel and accepted A. Both children succeeded, were settled and then owner-closed. The lead diagnosed the recorded-reference mismatch and left native blocker comment `89249c4a-fcc8-4da2-b448-15646a6bb64b`. No B integration bundle, review, acceptance, publisher, GitHub branch or PR was created. No accepted B build/browser UI observation is claimed; frontendBrowserQa was prepared but not executed because that prerequisite was absent.

**Final accounting: 10 real runs succeeded, 10 reservations settled, 9,279,411 token units, zero remaining exposure; zero retries and zero corrections.** Usage comes from exact public CLI `per_run` records; cached input is not added twice. Two leads exceeded their 2M reservation individually; reservations were explicitly not provider hard caps and total usage stayed inside 50M. The subscription-included token ledger is not a monetary charge claim.

Owner assistance was explicit: start/hold lead, close only terminal+settled N1 children, reconcile lead/review/coordination after terminal readbacks, transfer coordinator without a model wake, invoke N6 recovery, then freeze/pause and clean up. Automatic event progression, autonomous PM judgment, facilitator effectiveness and complete M2 delivery are not established.

Evidence and 36 immutable local artifact hashes are indexed in [observation.json](observation.json). Complete public logs: `artifacts/ordinary-campaign-m2-run-readbacks/<runId>.json`, obtained by owner GET `/api/heartbeat-runs/<runId>` and `/api/heartbeat-runs/<runId>/log?offset=0&limitBytes=1000000` (continuation offsets supported). Envelopes contain host NDJSON `{ts,stream,chunk,seq}` and CLI events. Redaction elides the raw curl payload; the reconstructed exact payload in `ordinary-campaign-m2-reference-mismatch.json` hashes to native receipt `f6aff1773d56bbe7a65b10ce5d984dd057aa5cc8d8617f7fbb32a4feb2bb0ec2`. The agent first expanded abbreviated Git output `71b5f95` into the wrong full SHA in its message; this is the specific transport defect, not uncertain execution.

A and all real B Git objects are retained in `artifacts/ordinary-campaign-m2-A-accepted.bundle` and `artifacts/ordinary-campaign-m2-partial-B.bundle`. The private native backup under `artifacts/ordinary-campaign-m2-final-private/` contains DB, storage, instructions and the local encryption key with directory0700/files0600; provider-auth rows were zero, Codex/GitHub homes and owner credentials were excluded. No private backup contents are committed. A restoration of this M2 backup was not exercised. All ten agents were paused/wakes false before backup. The launcher exited0 at 21:14:14Z, and its owned application, PostgreSQL cluster, runtime and temporary owner-auth files were removed. Its preparation outcome label is not a campaign-success verdict.

Replay `python3 docs/reviews/m2-live/verify.py` checks retained hashes, terminal usage, delegation identities/order, Git ancestry and the absent erroneous object without a provider. The proof-manifest checker returns partial/closure not allowed (exit1), as intended. No product source changes or new product test suite were made by this operator. Next useful work is deterministic transport of Git identifiers plus an explicitly authorized recovery of this exact known record; do not replay accepted A or broaden this into a new campaign by default.

[Proof Gate Output V1]
Date de reference: 2026-10-04 Europe/Paris
Proof ID: council-m2-live-01dabaa-20261004
Subject: One real coordinated M2 campaign with accepted A and blocked B
Status: partial
Summary: A accepted, exact delegated handoff to B observed, B stopped on immutable recorded SHA mismatch; ten runs settled and cleanup complete.
Categories: functional, operations
Evidence Count: 3
Replay Procedure: python3 docs/reviews/m2-live/verify.py
Closure Decision: keep-open
Closure Rationale: B has no accepted integrated candidate, publication or accepted-build UI observation.
Next Required Actions: Bound deterministic Git-identifier transport and authorized same-record recovery, preserving accepted A and real B commits.
Linked Manifest: docs/reviews/m2-live/proof-manifest.json
