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

The pinned SDK does not expose authenticated provider usage or remaining
exposure. A caller-provided source label and amount cannot establish that
measurement. Consequently, this package refuses **real** N1 activation and
dispatch. Known admission inputs require worker test mode, the explicit
`n1FixtureMode: ephemeral-local-sandbox` company configuration, and the
source label "fixture:local-sandbox". The bounded replay sets these on its
owned ephemeral host; they
qualify state transitions, not live budget safety or agent judgment. No
durable Paperclip instance is activated by the repository's qualification
commands. N2 verdict and review handoff are not part of this slice. See
[N1 report](docs/reviews/n1/REPORT.md) for exact evidence and remaining gates.

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
