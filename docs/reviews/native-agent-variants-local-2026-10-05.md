# Native variants — local implementation review

Date: 2026-10-05. Base: `ef817493bf99606d324cac6ef572c23de839a9ab`.
Branch: `codex/council-native-variants`.

## Verdict and scope

The shipped V1 is implemented and locally qualified. An independent review
confirmed no remaining blocking finding after correction of role-aware admission,
exact physical bindings, public-history attribution, archive retention and N5
pre-wake recovery. This verdict covers the supplied mapping, which declares no
fallback alternatives. Automatic provider-unavailability fallback is not available
in this V1: configuration state is insufficient evidence to substitute a model.

No Paperclip/SDK source was changed. No active instance was installed, provisioned
or configured; no model/provider run was launched. Availability, mounted skills,
actual CLI parameters and native concurrency remain separate qualification work.

## Acceptance evidence

| ID | Local result | Evidence and scope |
| --- | --- | --- |
| V01 | PASS | `model-catalogue.spec.ts`: seven families, approved profiles, invalid config, exact embedded charter hashes |
| V02 | PASS, simulated | `model-variants.spec.ts`: managed setup/readback, missing resources, approval, drift, no reset/wake, read-only inventory |
| V03 | PASS, simulated | N1 physical lead/contributor flow; N2 physical verdict through receipt/application; N5/N6 integration guards; each dispatcher passes its required charter role |
| V04 | PASS | `mission-variant-eligibility.spec.ts`, `model-runtime.spec.ts`, `n2-variant-authority.spec.ts`: incompatible roster/role/run refused, logical independence retained |
| V05 | PASS for shipped policy | Pinned revisions, replay, CAS loser, shared ascent, active/unknown refusal. Declared fallback format is validated, but configuration/approval absence never triggers substitution |
| V06 | PASS with explicit gaps | `model-history.spec.ts`: attributed public artifacts, pagination, integrity/index, privacy exclusions; runtime test preserves publication recovery then removes archive from aggregate |
| V07 | PASS, simulated | `model-estimates.spec.ts`: comparable averages/nulls/deduplication; browser fixture: 21 controls, four nonempty screenshots, GET only |
| V08 | PASS locally | Full repository checks and independent final review; legacy fixtures still pass; code writes confined to Council |

The repository check runner passed **49 Python tests**, **591 TypeScript tests in
52 files**, source/test typecheck and build. Fallow `3.23.0` diff gate passed with
zero introduced blocking findings. The independent reviewer additionally replayed
**36 tests** focused on role-aware creation and launch guards. No measured claim
about provider cost, response quality or native execution follows from these tests.

N1 and N2 tests exercise the real selection/identity/receipt logic with simulated
native calls. N5/N6 integration tests mock the common model-runtime helper and
check dispatcher ordering/identity; the helper has its own failure-path suite.
Browser evidence renders the real component against isolated API fixtures and
is explicitly labelled `nativeRuntime: false`; its fallback row is a rendering
scenario only.

## Evidence and replay

The immutable local evidence directory is:

`/home/davy-lp/run-artifacts/council-native-variants-final-2026-10-05`

It contains check logs, parsed static audit, source-file SHA-256 inventory, copied
browser output/screenshots, independent-review record, and the canonical proof
manifest/output. The source inventory binds the executed candidate independently
of later documentation-only commits. Commands and prerequisites are documented
in [NATIVE-AGENT-VARIANTS.md](../NATIVE-AGENT-VARIANTS.md#replayable-local-checks).

Follow-up is conditional on separate authorization for active-instance setup and
native qualification. Before enabling any fallback alternative, establish a
verifiable pre-execution availability signal and qualify that path. Before
shipping another template revision, retain the old declarations/keys for engaged
tasks. Neither follow-up is performed by this local implementation lot.
