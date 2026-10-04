# M2 targeted reference transport and recovery preparation

The M2 contributor expanded abbreviated Git output into a different full SHA; the successful immutable receipt then prevented B integration. This change supplies an executable contribution command that reads Git and sends JSON directly, and a bounded owner `recover-integration` command for the retained B work. Paperclip core, dependencies, migrations, native records and the historical M2 proof are unchanged.

`recover-integration` preserves original command receipts, author/run attribution, the accepted A dependency and G4 accounting. It verifies the supplied native-issue bundle with the existing integration verifier, including the missing old reference, and records an explicit owner correction/integration at `ready_for_review`. It cannot approve, wake, retry, settle or publish. It refuses active/extra original runs, unsettled exposure, wrong owner/version/reference/base and an existing candidate/review/delivery. See [procedure and limits](../../n6/M2-RECOVERY.md).

Validation: canonical typecheck/build and 449 tests pass. Seven executable-transport tests use a real temporary Git repo and local HTTP server; five owner-route tests cover preservation/replay and material refusals. The Git suite verifies the absent reference and rejects replacement of an object present in the bundle. Fallow 3.23.0 diff gate passes without introduced blocking findings; inherited/raw complexity findings remain, so this is not a raw-clean claim. One independent focused review identified a contradictory historical UUID instruction; it was removed rather than layered with another instruction. No broad review/remediation loop was launched.

`pnpm qualification:prepare:m2-recovery` rehearses the public owner handler using the actual immutable M2 Git bundle/native readbacks and an in-memory SDK fixture. It verifies 15 Git checks, preservation of receipts/N6/attribution, one CAS followed by exact replay with no second write, and unchanged historical hashes. It produces:

- Prepared integration commit: `654048e902709893cdb3ae22e5715b0d0782a276`.
- Accepted A/base: `7959f68ce586b8e0a75d26b1e80490ac26e0cb06`.
- Original real B commits: `71b5f95ab7428feb24049f2204b97b12446cd528` and `0be2ff1f67bb97f4319ee2de25b6a1a711cf4afc`.
- Bundle: `artifacts/m2-recovery-654048e902709893cdb3ae22e5715b0d0782a276.bundle`, SHA-256 `11e238165dea943168e4d5cba52cb452a39b5fc360e8d7627ef6279836fc423d`.
- Local result/template: `artifacts/m2-recovery-prepared.json`, explicitly `prepared-not-applied` with fixture upload/effect identifiers excluded from native use.

These are offline results. The original B remains blocked; its saved receipt was not repaired. Native backup restoration and application of this command are not observed, and the new owner integration commit has not undergone B's specialist/Council review or UI observation. No provider, native wake, campaign retry, GitHub delivery or production deployment was performed. The initial 50M/150-minute authorization is not reset or transferred; a later continuation must have a valid period and explicit execution authority. Full M2 stays open.
