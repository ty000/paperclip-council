# Council decision receipt validation

Date: 2026-09-30. Runtime candidate: `808b879c205881a7f199f3d44a75175951a5ff77`.
Executive documentation candidate: `a0c966ca9ddefe4a4562c33418e6d8753823c4e4`.
Later evidence-only commits do not change the tested runtime source.

| Check | Result and scope |
| --- | --- |
| Migration prewrite / acceptance gates | Pass, before writable implementation delegation; complete bounded receipt acceptance passes |
| `pnpm typecheck` | Pass, production source and unit/receipt harness types |
| `pnpm test` | 104/104 pass |
| `pnpm build` | Pass |
| `pnpm audit:static --base-ref 46669b3b77f760b0f481bb927d3ff3f53bf9b42c` | Pass, Fallow 3.23.0; explicit roots identify the existing UI entry and spawned/aliased test fixtures |
| `pnpm test:receipts` | Pass on the clean runtime candidate: real isolated PostgreSQL, host SQL validators, 20 duplicate contenders, key/content/target conflict, lost success/malformed response, actual process kill after send and restart, new-key hold, unauthorized/authorized human handling, late response and persistent browser UI |
| `pnpm test:functional` | Pass from exact clean candidate archive against unchanged host `61b3fd57a695614dc4a37e2303f426a34a9795cf`: loaded plugin/private migrations, authenticated native API, ordinary correction then approval; isolated fixtures and no models |
| Impeccable | Skipped: binary unavailable; no installation attempted. Browser receipt rendering, mobile overflow and owner/read-only controls were exercised separately |
| Independent review | No remaining blocking findings. LOCAL-DOC-01 found stale active readback requirements; exact passages were corrected and independently rechecked |

The PostgreSQL/browser fault proof uses synthetic HTTP and SDK UI transport.
The separate unchanged-host proof uses actual host routes and the plugin worker
bridge in an ephemeral authenticated instance, with synthetic actors/runs.
Neither proves real-agent decision quality, production installation/activation,
provider execution, attributable historical recovery, or complete L03. A usable
native PATCH response is an observation, not proof of a later run. HTTP errors
are conservatively held; pre-send authorization/candidate refusals cause no send.

Paperclip's primary checkout and the abandoned D-H worktree retain their prior
dirty inventories; no source/SDK/schema/permission change or upstream PR is
required by this delivery. The user's live instance was not changed. The
unchanged test host retained its clean tracked state. Historical audit findings
remain intact, including their historical links; the audit's pre-existing
`SPRINT-PLAN.md` excerpt link was not rewritten.

See [the compact L03 handoff](../../L03-RECEIPTS-HANDOFF.md) for reusable pieces,
introduced contracts and remaining L03 work. No additional feature was added
following the coordination stop/scope instruction.
