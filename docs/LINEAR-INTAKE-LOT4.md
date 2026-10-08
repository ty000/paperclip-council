# Linear intake receiver — Lot 4

**L4-A through L4-E PASS in isolated native qualification.** Council `0.7.18`
at `1b5269ce8ca10a680f27a737b6a075b385477b30` and intake `0.4.0` at
`00c314181043a76ffbadad1721494f49893079ea` completed the installed integration
on unchanged host `61b3fd57a695614dc4a37e2303f426a34a9795cf`.
See the [measured qualification receipt](linear-intake-qualification.json).
Operational installation, real webhook/credential enrollment, real tickets and
model-provider activation remain separate and were not performed by this lot.

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

## Acceptance evidence and limits

| ID | Result | Observed evidence |
| --- | --- | --- |
| L4-A | PASS, isolated native | Four imported tasks, complete 36,300-character root description, consumed authenticated preparation/admission observations; disabled mandate and pending source produce zero missions, runs, wakes or reservations; early Board activation returns 409 `linear_source_pending` with zero reservations |
| L4-B | PASS, isolated native | Existing period and mission, three settled initial reservations, one budget configuration, 450 known usage units supplied by the deterministic CLI |
| L4-C | PASS, isolated native | Exactly three successful runs: coordinator, alpha, beta; alpha finishes before beta starts; cancelled historical child and original product root have no runs; N1 reaches `ready_for_review` before N2 |
| L4-D | PASS, isolated native | Duplicate signed webhook retains one request and request attempt; Council worker restart preserves the original intake, mission and pending challenge; one mission/intake at completion |
| L4-E | PASS, isolated native | Native scheduled jobs and governed Council dispatch only; zero premature wake, no importer wake capability or cross-plugin database write, no budget reset |

The SQL fixture supplies only an isolated local-board identity, membership and
administrator role. It seeds no plugin business state, reservation, mission or
source outcome. The harness reads private journals for evidence; the plugins
never read or write each other's private tables. This is not an operational
owner or mandate qualification.

The campaign used installed workers, the actual SDK bridge, authenticated bus,
native jobs, PostgreSQL, admission, heartbeat runs and accounting. Linear HTTP
responses and CLI model content/usage were deterministic: no real Linear
workspace or model provider was contacted. Only the Council worker was restarted;
this scenario does not prove an intake-worker, database or whole-host restart.
Source withdrawal, expiry and refused attestations are covered by targeted
synthetic tests, not additional native scenarios in this receipt. The terminal
native history case is cancelled; done history is covered by source tests.
N2, review quality, acceptance, publication and operational deployment are outside
this qualification.

Qualification finished at `2026-10-07T23:01:03.889Z`. Its retained private proof
has SHA-256 `b6336e50687010fecc183c2c45037c29126dc3bf4459e0f2442af794b375b8b1`.
All 523 Council and 127 intake source/build/migration/package file hashes match
before and after execution; all 31 intake compiled JavaScript modules also match
its CI artifact. The private server and PostgreSQL instance are stopped, and the
host's tracked files remain unchanged. The public receipt contains only selected
synthetic measurements and hashes; credentials and raw source bodies stay out of
the repository.

## Verification and replay

Intake passed 476 package/worker tests and 169 isolated PostgreSQL tests.
Council passed 980 tests with one inherited skip; operations, both typechecks
and build passed. Exact-candidate CI passed for
[Council](https://github.com/ty000/paperclip-council/actions/runs/37699064473)
and [intake](https://github.com/ty000/paperclip-linear-intake/actions/runs/37697670054).
Independent contextual reviews found no remaining P1/P2 in the reviewed scope.

At qualification, the repository's Fallow 3.23.0 wrapper returned `pass`, while
the raw audit against base `751a82b` returned `fail`: six introduced complexity
findings (one high test helper and five moderate), zero introduced dead code or
critical complexity, two new clone groups and 30 inherited complexity findings.
Subsequent inspection found that the wrapper omitted `complexity.findings` from
normalization. Its passing result therefore did not establish that those six
findings were nonblocking; the high finding should have been evaluated by the
blocking policy. The original native receipt above remains historical evidence
for its exact source/build bytes.

The focused follow-up on base `74c79a9` separates the hierarchy ownership check
and manual/Linear root eligibility, simplifies the four affected test helpers,
and makes the CI wrapper recognize complexity findings and reject unexplained
failing reports. Regression tests cover the CLI verdict, severity and inherited
attribution, root selection, and overlapping leaf ownership. No threshold,
suppression or exclusion is relaxed. The six targeted findings are absent in
the follow-up raw audit; unrelated inherited findings remain visible.

Three earlier native campaigns remain recorded as failures: the unsupported
foreign-origin list filter, a strict-null check on optional native `archivedAt`,
and a harness worktree flag that suppressed native wakes. Each was diagnosed and
corrected before a new isolated campaign. The unknown wake and its reservation
in the third campaign were never rearmed or replaced.

Replay requires the exact clean candidates, locked dependencies, built packages
and a prepared clean read-only host checkout at the commit above. The command
creates a new disposable native host/database and reports its private proof path:

```sh
cd /path/to/paperclip-council-at-1b5269c
PAPERCLIP_TEST_HOST_ROOT=/path/to/prepared-paperclip-at-61b3fd57 \
LINEAR_INTAKE_TEST_REPOSITORY=/path/to/built-intake-at-00c3141 \
corepack pnpm qualification:native:linear-intake
```

Do not target recipe. LIVE authorization flags set to `1` are rejected. The
fixture uses a private HOME, instance, database and deterministic CLI, and checks
the native scheduling guard before creating PostgreSQL. It changes no operational
host setting. Retain previous receipts; documentation-only commits do not change
the tested runtime bytes or replace these qualified code identities.
