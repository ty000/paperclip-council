# Paperclip Council

Agent-led review decisions, revision requests, and traceable acceptance for
Paperclip workflows. This standalone package extracts the demonstrated
`private.paperclip-council` integration without importing from a Paperclip
monorepo workspace.

The legacy decision adapter exposes an agent-authenticated route. It resolves a dedicated
Council agent API key from Paperclip's secret store and submits either a native
changes-requested or approval transition through Paperclip's public issue API.
Approval first requires a valid `delivery-manifest` for the same issue and an
attachment whose metadata matches the manifest's bundle SHA-256.

It does not implement Council reasoning, voting, learning, delivery control, or
a separate authorization model. The configured key retains the Council agent's
normal Paperclip authority.

## N1 candidate preparation boundary

Version 0.5 adds a plugin-private admission envelope, owner-controlled mission
activation, two-contributor plans, persistent native child-issue intents, and
Git bundle verification before an Integration Lead can publish a candidate.
The mission page exposes pinned rosters, participants, reservations, unknowns,
checks and the next actor. Child issues are first created in native Paperclip
backlog; their dispatch requires a separate durable reservation. An uncertain
create or wakeup is retained as unknown and is never retried automatically.

The pinned SDK exposes an authenticated orchestration summary containing exact
native runs, token totals, cost cents, budget incidents and invocation blocks.
Council supports one deliberately narrow native profile that reserves an
explicit token estimate before each launch, runs the two contributors
sequentially, and settles only from the expected terminal run. A zero monetary
cost is labelled unpriced, while a zero token total remains unknown and blocks
publication. The historical `n1FixtureMode: ephemeral-local-sandbox` remains a
test-only transition proof. The separate `qualification:live:n1` command needs
explicit provider authorization and a clean committed candidate. N2 consumes
this exact persisted candidate without rewriting the N1 path. See the
[N1 report](docs/reviews/n1/REPORT.md) for the exact profile and proof boundary.

## N2 development boundary

The adopted opt-in profile for new reviews is `n2RuntimeProfile: ordinary-cli-v1`:
separate N3 specialist opinions and Council judgment run as ordinary CLI tasks,
with terminal per-run accounting before correction or acceptance. See the
[activation and agent contract](docs/n3/ORDINARY-CLI-REVIEW.md).
Existing missions retain their persisted protocol.

N1 contributor tasks now include executable Git-to-JSON reporting. The
[M2 recovery procedure](docs/n6/M2-RECOVERY.md) documents the owner-only recovery
of a known incorrect contribution reference and the offline preparation command;
it does not constitute native recovery, review or publication of B.

The historical profile `n2RuntimeProfile: paperclip_runner-experimental` remains compatible.
It consumes the existing verified N1 candidate through a separately reserved native
transmission, then runs independent review, one optional correction and final
review. Native completion cards, verdicts, scheduling, costs and recovery are real;
Council preserves the candidate/run/card receipt binding and individual reservations.
After rejection, a dependency holds correction until reviewer usage is known and
settled. Native reviewers are individually reserved before their source finishes.

The installed-package qualification passes with four native runs and four cost rows
on unchanged host `61b3fd57`, with only the official model backend substituted.
It uses no provider, core patch, model rendezvous or wake toggles during the cycle.
This does not qualify durable installation or LIVE provider execution. The
[N2 report](docs/reviews/n2/REPORT.md) records the exact source/proof, owner setup,
agent instructions, accounting boundaries and remaining N6 admission limitation.

### Historical legacy N2 launchers

The following `codex_local` LIVE/preflight commands and operator-assisted sequence
are retained as history. They do not launch the experimental native profile and
must not be reused as its campaign recipe. No new provider launcher is supplied.

The proposed campaign command is:

```sh
COUNCIL_N2_LIVE_AUTHORIZED=1 \
COUNCIL_N2_LIVE_MODEL=gpt-5.6-sol \
COUNCIL_N2_LIVE_EFFORT=high \
COUNCIL_N2_LIVE_RUN_UNITS=2000000 \
COUNCIL_N2_LIVE_PERIOD_UNITS=12000000 \
pnpm qualification:live:n2
```

Do not set the authorization variable until the operator has explicitly
authorized that provider campaign for the exact published commit.

For the isolated N2 path, `pnpm qualification:preflight:n2` first builds the
same `ready_for_review` prerequisite through public Paperclip APIs and
fixture-confined public Council commands. It records two distinct contributions,
a verified integrated candidate, three settled zero-usage N1 reservations,
zero fixture exposure, three terminal checkout heartbeat fixtures for lead/Alpha/Beta,
no open checkout/execution locks, an empty primary reviewer readback, and
owned-runtime cleanup. It then removes fixture mode through public configuration,
creates a distinct native 2M-per-run/6M-period envelope with the profile's exact
dates, and carries the same mission and candidate through `start-review` and the
operator PATCH. The reviewer stays disabled, so the resulting native reservation
remains open without any wakeup, run, process, or provider call; the owned sandbox
is then destroyed. A later, separately
authorized campaign can reuse that deterministic builder in the same ephemeral
runtime and launch only reviewer V1, the bounded correction, and reviewer V2:

```sh
COUNCIL_N2_ISOLATED_LIVE_AUTHORIZED=1 \
COUNCIL_N2_ISOLATED_LIVE_CANDIDATE_SHA=<exact-published-sha> \
COUNCIL_N2_ISOLATED_LIVE_MODEL=gpt-5.6-sol \
COUNCIL_N2_ISOLATED_LIVE_EFFORT=high \
COUNCIL_N2_ISOLATED_LIVE_RUN_UNITS=2000000 \
COUNCIL_N2_ISOLATED_LIVE_PERIOD_UNITS=6000000 \
pnpm qualification:live:n2:isolated
```

The isolated LIVE launcher refuses a dirty candidate, a mismatched candidate
SHA, a missing explicit authorization, a substituted model/effort, or any
period allowance other than exactly three run reservations.

## Compatibility

This extraction is tested against Paperclip commit
`61b3fd57a695614dc4a37e2303f426a34a9795cf`, Node.js 24.11 or newer, and the
exact registry releases `@paperclipai/plugin-sdk@2026.916.1` and
`@paperclipai/shared@2026.916.1`. No broader Paperclip version range is claimed.

## Install and verify the package

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
COUNCIL_PACKAGE_EXPECTED_COMMIT=<candidate-sha> \
  PAPERCLIP_TEST_HOST_ROOT=/absolute/path/to/paperclip pnpm test:functional
```

The candidate SHA must be the exact clean commit under qualification, and the
host checkout supplied to the functional test must be at the exact commit
listed above. The harness records both revisions, exports the candidate commit
with `git archive`, installs dependencies and builds in an isolated temporary
directory, and records SHA-256 digests for the source archive and built `dist`.
It then creates a fresh authenticated instance and embedded PostgreSQL test
cluster, installs that isolated build through Paperclip's normal local-plugin
lifecycle, and replays V1 → changes requested → V2 → missing manifest refusal →
manifest and bundle preparation → acceptance. Its bundle is made from the exact
pinned PR #2 extraction commit, which must still be available in the local
repository used to launch the replay; no remote branch is required.
Its agents, issues, policies, and heartbeat runs are explicitly synthetic test
preparation. Executor and Council are distinct agents, and each decision uses a
fresh active run. The isolated instance and database are removed afterward.

For a repo-owned pinned Paperclip checkout and one-command bounded replay, use:

```sh
pnpm qualification:host:prepare
pnpm qualification:host:status
pnpm qualification:bounded
```

The checkout lives under ignored `.paperclip/qualification/`; each replay still
creates and removes its own runtime instance and database. See
[`docs/ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md) for the normative separation
between package checks, this local sandbox, the integrated Paperclip recipe and
an authorized target.

To install the built checkout into a separately selected Paperclip instance:

```sh
paperclipai plugin target
paperclipai plugin install /absolute/path/to/paperclip-council --local
```

Confirm the target diagnostics before installation. Local plugins are trusted
code. This repository is not published by this extraction, and GitHub repository
installation is not a first-class Paperclip workflow.

## Continuous integration

The `Council CI` check runs on every branch push and pull request. It installs
the frozen pnpm lockfile, then runs typechecking, unit tests (with at most two
Vitest workers), and the package build concurrently in one Linux job. Each
command reports its own status and duration, and any failure fails the job.

This fast check does not run `pnpm test:functional`. The functional replay needs
a pinned Paperclip host checkout, Chromium, an authenticated local instance, and
an embedded PostgreSQL test cluster; it remains a separate qualification step.

## Configuration and secret references

Create a company-scoped configuration with Paperclip's plugin configuration API:

```json
{
  "companyId": "<COMPANY_ID>",
  "configJson": {
    "apiBaseUrl": "<PAPERCLIP_INSTANCE_ORIGIN>",
    "councilAgentId": "<COUNCIL_AGENT_ID>",
    "councilApiKey": {
      "type": "secret_ref",
      "secretId": "<PAPERCLIP_SECRET_ID>"
    },
    "n1OperatingProfile": {
      "kind": "paperclip-orchestration-tokens-v1",
      "periodKey": "<IDENTIFIED_PERIOD>",
      "periodStart": "<ISO_TIMESTAMP>",
      "periodEnd": "<ISO_TIMESTAMP>",
      "periodAllowanceUnits": 180000,
      "runReservationUnits": 60000,
      "initialKnownUsageUnits": 0,
      "initialExposureUnits": 0,
      "initialTokenAccountingSource": "owner-attested:fresh-company-and-period:<IDENTIFIER>",
      "maxCorrections": 0
    }
  }
}
```

`apiBaseUrl` is the loopback instance origin without `/api`, credentials, a
path, query, or fragment. Remote origins are rejected before the secret is
resolved so a configuration mistake cannot transmit the standard Council token
off-host. `councilAgentId` must own the stored key. `councilApiKey` must remain
a `secret_ref`; never store a raw token in plugin configuration, source, logs,
or reports.

`n1OperatingProfile` is optional unless native N1 execution is requested. Its
units are tokens, not currency. The allowance and reservation values are an
explicit admission policy; they do not claim a future provider bill ceiling.
Initial known usage and exposure are required activation inputs, and
`initialTokenAccountingSource` must identify the company/period readback or
bounded fresh-period attestation that supports them. Zero is never inferred.
`maxCorrections` defaults to `0`; the N2 profile must set it explicitly to `1`.

Using a board session authorized for the target company:

1. Create a dedicated standard key with
   `POST /api/agents/<COUNCIL_AGENT_ID>/keys` and
   `{"name":"paperclip-council","scope":{"kind":"standard"}}`.
2. Transfer the one-time token directly to
   `POST /api/companies/<COMPANY_ID>/secrets` using the
   `local_encrypted` provider. Retain only the returned secret ID.
3. Save the plugin configuration above and verify that the agent, assignment,
   active run, and normal permissions match the intended review workflow.
4. For rotation, create a replacement key, rotate the stored secret, verify the
   new key, and only then revoke the old dedicated key.

Paperclip currently provides no review-only key scope for this integration.
Rotating a secret does not revoke the old Paperclip token.

## Decision route

```text
POST /api/plugins/<PLUGIN_ID>/api/issues/<ISSUE_ID>/decision
Authorization: Bearer <DEDICATED_COUNCIL_AGENT_TOKEN>
X-Paperclip-Run-Id: <ACTIVE_COUNCIL_RUN_ID>
```

Example request body:

```json
{
  "operationId": "review-result-v1",
  "verdict": "changes_requested",
  "justification": "The result needs the corrected marker.",
  "resultReference": "artifact://review/result-v1"
}
```

Accepted verdicts are `changes_requested` and `approved`. The caller must be the
configured Council agent, the run header must resolve normally, and the issue
must be `in_review` and assigned to that agent. The plugin never creates or
reactivates a run.

`approved` additionally requires a structured `approvedCommit` field containing
the exact 40-character lowercase head hash. A hash mentioned only in
`justification` or `resultReference` has no effect:

```json
{
  "operationId": "review-result-v2",
  "verdict": "approved",
  "approvedCommit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "justification": "The reviewed candidate matches the delivery manifest.",
  "resultReference": "artifact://review/result-v2"
}
```

Before approval, put a `delivery-manifest` document on that issue. Its body must
be JSON with `repository` (GitHub HTTPS URL), `branch` (`codex/...`),
`baseCommit`, `approvedCommit`, `bundleAttachmentId`, `bundleSha256`,
`deliveryWorkspacePath` (under `/home/davy-lp/workspace/`), and
`assigneeAgentId`. The format and field rules follow the separate Council
delivery trigger. The bundle must be attached to the same issue and its stored
SHA-256 metadata must equal `bundleSha256`. The route compares the request's
`approvedCommit` to the document before resolving the PATCH credential. Missing
documents return 409; malformed or mismatched inputs return 422, with an error
naming the failed field. No native decision or status PATCH is attempted on
these refusals. `changes_requested` needs no manifest.

When the host includes structured commit or branch work products in the issue
projection, the route also compares their repository, branch, head and any
available base commit with the manifest. Paperclip host commit
`61b3fd57a695614dc4a37e2303f426a34a9795cf` does not expose a work-product
list through the plugin SDK's `ctx.issues` bridge; its issue projection lacks
that list. Work-product consistency is therefore not verified on that host.
The public work-product route needs a credential, and the Council PATCH secret
is deliberately not resolved before all refusal checks. The attachment check
compares stored metadata; it does not open or parse the bundle bytes.

## Persistent decision receipts

Each new verdict requires an `operationId` (1–128 letters, digits, dots,
underscores, colons or hyphens). Keep it stable for the same intended operation.
Council stores the target, content and authenticated actor/run before atomically
claiming one attempt. Repeating the same operation/content reads its receipt;
changing its content or target conflicts. The original run attribution remains.

A lost, malformed or ambiguous response leaves the operation **indeterminate**.
It stays persisted across restart and blocks any new Council verdict key for that
issue. There is no automatic resend, privileged SDK fallback, or force-success
control. The nominal path records usable native responses without requiring a
human action. A receipt is not proof of subsequent execution.

The existing Council page includes **Council decision receipts**. The configured
company owner can acknowledge uncertainty or record abandonment with a note.
These actions preserve the native observation and the hold. Inspect the receipt
and the native issue using existing authorized interfaces; do not infer success
from `done`, a comment or an agent summary. If safe resumption needs a missing
contract, leave the issue blocked. Do not delete receipts, invent a new key,
reinstall an older blind-send worker, or treat abandonment as cancellation.

The additive migration `004_decision_receipts.sql` is private to the plugin.
Existing records are preserved. See [the V1 contract](docs/DECISION-RECEIPTS-V1.md)
and [owner policy](docs/G3-G4-DECISIONS.md). No Paperclip patch or upstream PR is a
dependency. Installing/upgrading a running instance is a separate operator step.

Replay the isolated transactional/fault/browser proof on Linux with installed
Paperclip test dependencies (read-only source):

```sh
PAPERCLIP_TEST_HOST_ROOT=/path/to/paperclip \
PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium \
pnpm test:receipts
```

This creates and stops a fresh temporary PostgreSQL cluster, uses a synthetic
native HTTP endpoint and SDK UI transport, and makes no model/provider call.
It is separate from `test:functional` on an unchanged host and from any live
qualification. Test evidence records that distinction.

## Preparing future Council tickets

Ask the Executor to publish the exact candidate commit as a structured work
product, attach its Git bundle to the source issue, and write the manifest before
requesting Council approval. Ask Council to read the manifest, bundle metadata,
candidate work product where available, and test evidence; its approval request
must send `approvedCommit` as a structured field. Revision requests remain
available while preparation is incomplete. For agent instructions, recommend
`paperclip-create-plugin` for the plugin contract, then `paperclip` for issue
evidence, then `prcheckloop` and `check-pr` for the delivered PR when those skills
are available. For this consequential approval path, the mapping at
`/home/davy-lp/.codex/shared/model-selection/model-effort-mapping.md` (2026-09-05)
recommends `gpt-6-astra` at `high`; reassess at `medium` once the contract and
tests are stable, and verify actual model and effort at launch.

## Limits and licensing

This package is a trusted decision adapter, not an autonomous council. Anyone
who controls its configuration and secret can exercise the configured agent's
existing authority. The isolated replay qualifies package loading and the native
review transitions only; it does not qualify decision quality, adversarial
security, durable production configuration, external delivery, or model use.
The separate delivery trigger must be running when approval events occur; its
event bus does not replay historical events. A missed approval needs a separate
idempotent reconciliation run or an update to its manifest after the trigger is
ready. A green PR does not activate this gate on a Paperclip instance.

Licensed under the MIT License; see [LICENSE](./LICENSE).

### Native N2 lifecycle with a deterministic model

`pnpm qualification:native:n2` builds and installs the exact clean Council candidate
in an ephemeral authenticated instance using `PAPERCLIP_TEST_HOST_ROOT` and its
exact `COUNCIL_N2_NATIVE_HOST_COMMIT`. The qualified host is unchanged
`61b3fd57a695614dc4a37e2303f426a34a9795cf`.

Only `nativeSessionBackendFactory` is substituted. Real Paperclip services own
admission, API authorization, native review cards, finalization, costs, events and
recovery. Three N1 preparation rows remain labelled fixtures; N2 executes a real
native transmission, reviewer1, correction and reviewer2. Each run has its own
reservation and public per-run usage readback. Unknown usage retains its exposure.

General CI does not install the optional Paperclip host. Fallow's
`ignoreUnresolvedImports` lists only the 17 exact external host specifiers used by
the native tests; their files, other imports and other findings remain audited.
The native qualification resolves those imports against the pinned host at runtime.

The launcher checks final exact-candidate acceptance, four successful runs/costs,
settled reservations, replay without a fifth execution, and owned runtime cleanup.
The dependency-cancelled predispatch row remains visible in the evidence. Neither
an operator rendezvous nor wake disabling masks the reviewer-to-correction boundary.
The earlier three-run, patched-host approach is historical and has been replaced.

See the [N2 report](docs/reviews/n2/REPORT.md) for the explicit experimental setup
and agent command contract. No durable agent is migrated and no provider is called.
N2 approval still rechecks the immutable verified submission attachment; the
non-N2 legacy approval path still requires its delivery manifest. Native final
acceptance is not yet an N6 guarantee that all dependent work waits for final cost.
