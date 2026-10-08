# Native contribution settlement wait — 2026-10-08

Council 0.7.21 fixes the waiting state between a verified contribution report and its terminal settlement. Previously the delivered child became `blocked` with only completed product dependencies. Paperclip could therefore start `issue_blockers_resolved`, followed by disposition recovery, outside Council admission.

The plugin now persists the creation claim of one unassigned operational settlement task, correlates that original task, and observes its dependency before setting the child to `blocked`. This task requests no human decision or model run. Existing proof and exact terminal cost gates still own child closure. Council observes the child `done`, removes only its technical dependency, closes the settlement task, then records `proof.closedAt`. Product dependency snapshots remain unchanged. Unknown effects retain their original identities.

Validation:

- Canonical operations, TypeScript, build and Vitest checks: passed; 1,050 tests passed, one existing skipped test.
- Focused review by an independent Codex agent: no material finding; hierarchy and wait suites 114/114 passed.
- Fallow 3.23.0 diff gate: passed, no blocking finding. New native test entry points are declared; modified disposition logic is split into its contribution and candidate paths.
- `pnpm qualification:native:contribution-wait` exercises the real Paperclip issue, dependency and recovery services against ephemeral PostgreSQL. It reproduces one intercepted wake before the fix, then zero wake requests while settlement is pending and after closure, with one fixture heartbeat, no new heartbeat and no cost event. The scheduling callback is intercepted before any dispatch; this is provider-free integration proof, not a LIVE campaign.

Replay requires `PAPERCLIP_TEST_HOST_ROOT` and `COUNCIL_CONTRIBUTION_WAIT_HOST_COMMIT` explicitly identifying a local Paperclip source checkout with dependencies installed. The launcher records host/candidate hashes and host dirty state, confirms they remain unchanged, and cleans its owned database/runtime. The qualified host is `61b3fd57a695614dc4a37e2303f426a34a9795cf`; pre-existing host lockfile/untracked changes were preserved. Evidence is generated under `artifacts/contribution-wait-native-*.json` and is not source-controlled.

No Paperclip core, migration, dependency, agent configuration, native exception ledger or historical reservation is changed. The earlier PEZ-669 mission remains suspended with its unknown canceled-run cost. Davy selected assisted Codex/IMF integration and reviews on its two existing commits, rather than claiming an autonomous native continuation. This fix does not authorize or implement an exception-ledger override.
