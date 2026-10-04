# Ordinary CLI Council review

Select `n2RuntimeProfile: "ordinary-cli-v1"` in the installed Council company configuration, alongside the existing Council secret and token operating profile. The lead, selected specialists and final Council reviewer must be available `codex_local` agents with explicit `adapterConfig.engine: "cli"`. This setting applies when starting a new review; already-created native/legacy missions keep their persisted protocol.

From an activated N1 mission with a verified `ready_for_review` candidate, an idle root still assigned to its lead, and every prerequisite reservation settled, the owner calls:

```json
{"command":"start-review","companyId":"<company UUID>","commandId":"<fresh UUID>","expectedVersion":18,"submissionId":"<fresh UUID>","n3Slots":[{"slotId":"<fresh UUID>","perspective":"product","specialistAgentId":"<agent UUID>","required":true,"question":"Does this exact candidate meet the mandate?"},{"slotId":"<fresh UUID>","perspective":"quality","specialistAgentId":"<agent UUID>","required":true,"question":"Are the behavior and tests sufficient?"}]}
```

The example version `18` is illustrative: read the current mission and use its actual `version`. Generate UUIDs for the placeholders.

POST to `/api/plugins/:installedPluginId/api/companies/:companyId/missions/:missionId/commands`. Choose the relevant two-to-seven N3 perspectives before the round; no mandatory committee or extra transmission task is introduced. Existing N3 attribution, independence, subject and objection contracts apply.

The installed controller creates parentless specialist and Council tasks sequentially. Each launch follows a persisted creation claim, confirmed issue identity, existing CAS admission reservation and persisted wake claim. Issue dependencies do not launch the next stage. An unknown create/wake retains its claim and exposure; do not replace the key or issue. The owner may call `reconcile-ordinary-n2` on the same command route to resume public readback, but cannot override an unknown effect.

Generated task descriptions contain the full authenticated tool/API payloads, UUID/replay rules and role instructions. `ordinary-inspect` returns the same instructions, exact task, N2 candidate and N3 review. Specialists submit `n3-opinion`; only the pinned Council reviewer submits `ordinary-verdict` with reasoned synthesis and exhaustive material-objection dispositions. Council must finish with the exact returned `finishReport` JSON. Do not call the legacy decision route, native transmission commands or completion-card APIs.

After a valid submission, Council records the task as `blocked`: it is waiting for that still-active run's terminal usage and subsequent review. This ordinary disposition prevents Paperclip's legacy `issue_disposition_repair`; it does not close or cancel the run. `agent.run.finished` invokes the installed controller. It reads the exact public heartbeat identity (`id/companyId/agentId/contextSnapshot.issueId`), CLI terminal summary and positive `per_run` usage, then uses the existing admission settlement. Cached input is already included in input tokens. Missing usage retains exposure; `done` or a report alone cannot accept or admit a correction.

A changes-requested judgment permits one admitted correction on the root, still owned by its lead. Before waking it, the plugin appends correction instructions. Preserve base and both attributed contribution commits; amend the single integration commit to a distinct V2 SHA, create a self-contained bundle with `refs/heads/base` and `refs/heads/candidate`, upload it to the root, and call `prepare-resubmission` with its digest and materially corrected attributed paths. Finish normally. After terminal settlement, fresh N3 opinions and a new Council judgment review V2. Only the confirmed candidate-bound Council report plus settled usage yields acceptance.

Ordinary receipts use provenance `ordinary-task-terminal-readback-v1` and the public heartbeat URL. The historical storage names `native_observed` / `nativeObservation` are retained; they do not mean a native completion review occurred. Accepted candidates feed the existing N5 preflight without an invented transmission settlement. CLI publisher readback is supported, but this lot qualifies N5 handoff only; external publication is not executed or qualified. This is not N6/M1 closure or evidence of real model judgment.

Provider-free installed replay, using a deterministic executable only at the Codex CLI seam:

```sh
pnpm build
node_modules/.bin/tsx tests/functional/ordinary-installed.ts artifacts/n2-ordinary-installed-<unique-name>.json
```

The host must match the pinned qualification checkout. The harness creates and removes its own runtime/database, prepares N1 through real APIs and three CLI runs, then observes seven product-controlled N2/N3 runs. N1 preparation explicitly closes terminal contributor tasks with the lead's demand wakes temporarily disabled. N2 requires no harness controller or manual closure. The fixture emits synthetic opinions, verdicts and token usage; it proves integration contracts, not reasoning quality or provider billing.
