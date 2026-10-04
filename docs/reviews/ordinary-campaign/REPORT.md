# Ordinary Delivery campaign preparation

**PASS for provider-free preparation and retained operator session/stop.** No Delivery UI implementation, provider execution, actual subprocess authentication, GitHub publication or N6 result is claimed. Seven distinct CLI role configurations and instructions are installed/read back; configuration is not model execution.

Source `bbde20f6ea481b0416c5223c1b3a3bb50c975791`, base `35252e66071526d41e935ef8fddb51281a73586f`, host `61b3fd57a695614dc4a37e2303f426a34a9795cf`. The new `pnpm qualification:ordinary prepare|session|stop` entry reuses the existing owned-runtime/package/bootstrap lifecycle. The historical N45 launcher stays runner-based and unported; its shared preparation helper selects an explicit ordinary protocol for this new entry.

The actionable [operator recipe](../../n5/ORDINARY-CAMPAIGN.md) retains seven disabled agents and real IDs in session mode, plus owner API payloads and private fresh-owner access. The plugin packagePath is the actual mission Git workspace, whose committed lockfile dependencies and build are already prepared. Same-path upgrade/reload is observed before any run, enabling the future accepted UI build to be installed in this same instance. No source checkout dependency symlink or manually copied Codex/GitHub authentication is used. Owner secrets are mode0600, omitted from evidence and removed on stop.

The proposal is 7 nominal / 12 maximum planned runs, 2M reservation per run / 24M allowance, zero retries and one cumulative correction. This is not a provider hard cap or authorization. Model/effort is configured as gpt-5.6-sol/medium, availability unobserved. Future authorization must identify exact source/host/model/budget and allowed create/update target; M1 requires actual accepted-build browser observations, and N6 remains separate.

## Evidence and findings

- `21f6f80` prepare exited0 and ran the canonical typecheck, **375 tests** and build inside the exact mission workspace: [checks](canonical-checks-21f6f80.log). Its artifact [prepare](../../../artifacts/ordinary-campaign-prepare-21f6f80bd7bb882cdb796b48824f2060e6e09f5b.json), SHA256 `5fa8c3166b0968c45e92fdcdaef20a93752dd8005e9aca3ccaab64f84213c9ca`, is **partial preparation evidence**, because the runtime log revealed two configured companies for a single-tenant worker despite the initial success label. It does not establish a usable loaded campaign by itself.
- `bbde20f` corrects only that bootstrap seam: the generic fixture company is never configured for ordinary mode, and preparation asserts exactly one configured campaign company before upgrade. Its session exercises the same corrected preparation followed by retained-instance readback and explicit stop. [Session artifact](../../../artifacts/ordinary-campaign-session-bbde20f6ea481b0416c5223c1b3a3bb50c975791.json), SHA256 `4f5d05a57e7349129431c402d85ee16d3d1b5777c9405d760c1dba9496c69c6b`: exit0, same-packagePath build/upgrade, one configured company, seven CLI agents with demand/timer wakes disabled, zero runs/wakes at preparation and zero final session runs, owned DB/runtime cleanup complete. [Authenticated owner readback](session-readback.json) independently confirms the retained session is usable, secrets are0600 and absent after stop. No second canonical suite or N5 TTL campaign was run for this bootstrap-only correction.
- Final raw Fallow reports **WARN/exit0**, with two nonblocking harness duplication groups and zero introduced dead-code/complexity findings; the normalized wrapper reports **PASS/exit0**, on exact `bbde20f` against `35252e6`; [raw](static-audit-raw.json), [wrapper](static-audit-wrapper.json). The initial audit blocked on the expanded preparation helper. One local remediation separated protocol/actors/workspace/tool-profile selection and replaced its ternaries with explicit ordinary/legacy returns. Initial/extraction/precommit raw and wrapper results remain preserved. This is not a general cleanup.
- The owner payload now requires `READ_CURRENT_PLAN_REVISION`, preserving the prepared UUID separately; zero counters are explicitly `AtPreparation`, with later session runs separate. Backend/frontend instructions explicitly supersede historical active-run closure advice. Source N5 publisher instructions specify exact old-V1 leases for amended V2. The [bare Git proof](git-publication-preflight.json), SHA256 `97a55ce170c5c4a9de45c7e5eac5461a08f34c660d48e8be26bd5c6b07f0ba76`, was copied unchanged from the parent's delivery-orchestration review; its source is historical `76cd747`, and it proves local push/lease semantics only.

The independent local reviewer found no remaining material source/session finding. Authenticated operator transport and same-path reload are observed; model tool access and GitHub effect rights from a future sandbox are not. `test-environment` is excluded because it calls a provider. N1 contributor close/settlement, public owner resume and later snapshot refresh remain explicit assistance. The actual Delivery panel is left for the real mission, and its final UI must be observed from the accepted build, not the initial package.

```text
[Proof Gate Output V1]
Date de reference: 2026-10-04 Europe/Paris
Proof ID: ordinary-campaign-preparation-bbde20f
Subject: Provider-free seven-role ordinary preparation, retained session and owned stop
Status: pass
Summary: Same-workspace install/upgrade, one configured company, seven disabled CLI agents, authenticated owner readback and zero-run cleanup
Categories: functional, quality, operations
Evidence Count: 4
Replay Procedure: proof-manifest.json evidence commands and docs/n5/ORDINARY-CAMPAIGN.md
Closure Decision: close-final
Closure Rationale: Preparation and session lifecycle are replayable; provider execution, publication, produced UI and N6 remain unqualified
Next Required Actions: Obtain concrete campaign authorization before waking agents or publishing
Linked Manifest: docs/reviews/ordinary-campaign/proof-manifest.json
```
