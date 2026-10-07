# Linear intake receiver — Lot 4

Implementation in progress. The receiving behavior is not yet qualified,
installed, or activated in the operational instance.

## Ownership and authority

Council starts from `751a82bce5436e7c54cda05e9db9fc92db072534` (0.7.17).
The separate intake repository starts from
`0488cb7b799d015db69760e5a4603a333f3f4637` (0.3.0). This lot is authorized
to extend these two plugins. Paperclip core and SDK are read-only references.
Native qualification uses an isolated host and deterministic Linear/model
transports; deployment and real webhook/ticket/provider activity remain separate.

Intake owns webhook eligibility, activation, complete source retrieval, import
effects and the immutable readiness document. Council owns the project mandate,
contributor/path preparation, admission, mission and accounting. Neither plugin
reads or writes the other's private tables. The importer never wakes an agent.

## Current-source handshake

The supported native event bus authenticates plugin namespace, actor and company.
It provides no delivery or persistence guarantee. Council journals a nonce before
emitting `plugin.private.paperclip-council.linear-intake-revalidation-request`.
The opt-in importer responds on
`plugin.ty000.linear-intake.linear-intake-revalidation-result` only after checking
its own enabled binding, activation, request revision, prepared plan and observed
effects, reading the readiness document and fully rereading the current source.
No caller-provided address, credential or source scope is used for these reads.

Requests last at most five minutes. A result observes the source before that
deadline and lasts at most two minutes from completion. Council records the
authenticated result, rechecks its current owner/mandate/configuration and consumes
it once with a compare-and-swap. It does this before preparation and again before
initial N1 activation. The N1 activation function checks the consumed durable
attestation and original journaled activation payload before reservation and CAS,
including calls made directly by the Board. If the attestation expires after
reservation, the existing reservation remains attached to its original command.
The existing continuity job drives progress; receipt of an
event never starts a mission. Loss, restart, mismatch, withdrawal and expiry wait
without replacing any effect, intake, mission, attempt or budget identity.

Expired read-only challenges may be renewed under the same admission identity,
up to 128 observations per phase. This renewal cannot rearm an uncertain native
effect. After initial admission, the pinned source and existing native-source and
mandate guards govern Council; subsequent remote Linear changes do not silently
cancel an admitted mission. Cross-system observations are bounded in time, not
an atomic transaction with Linear.

`readinessSha256` hashes the import ledger's readiness *receipt*, containing
document ID, revision, number, exact document-content digest, root and source/plan
digests. It is distinct from a digest of the JSON document body.

## Safe preparation

Imported origin remains `plugin:ty000.linear-intake`. Only an explicit revisioned
project rule may map source issue IDs to contributors and permitted repository
paths. Council records each preparation intent before its native effect, reads
it back, and never retries an uncertain absent effect under a new key.
Assignment and transition to Backlog occur in one update so native blocked-task
recovery cannot dispatch an agent before Council admission. Completed/cancelled
source history is preserved and cannot become a contribution or closure target.

Complete descriptions remain in native tasks and source documents. A bounded
mission objective identifies those sources and their digests; no source text is
silently truncated to fit the mission mandate.

This first receiver requires at least one executable descendant. A standalone
root, a root with only terminal history, or an unresolved external blocker stays
blocked for an explicit operator decision. It does not invent implementation
subtasks or infer ownership from ticket text.

## Acceptance evidence required

- L4-A: complete native handoff, fresh source and currently enabled mandate.
- L4-B: existing Council admission, period, reservation and permitted effects.
- L4-C: representative subtree runs in dependency order through native orchestration.
- L4-D: duplicates and restart retain one intake, mission and attempt.
- L4-E: no importer wake, foreign database write, invented owner or budget reset.

Source tests, static analysis, installed native execution and provider execution
will be reported separately. None of the criteria is claimed complete here.
