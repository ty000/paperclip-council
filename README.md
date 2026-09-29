# Paperclip Council

Agent-led review decisions, revision requests, and traceable acceptance for
Paperclip workflows. This standalone package extracts the demonstrated
`private.paperclip-council` integration without importing from a Paperclip
monorepo workspace.

The plugin exposes one agent-authenticated route. It resolves a dedicated
Council agent API key from Paperclip's secret store and submits either a native
changes-requested or approval transition through Paperclip's public issue API.

It does not implement Council reasoning, voting, learning, delivery control, or
a separate authorization model. The configured key retains the Council agent's
normal Paperclip authority.

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
PAPERCLIP_TEST_HOST_ROOT=/absolute/path/to/paperclip pnpm test:functional
```

The host checkout supplied to the functional test must be at the exact commit
listed above. The harness creates a fresh authenticated instance and embedded
PostgreSQL test cluster, installs this built package through Paperclip's normal
local-plugin lifecycle, and replays V1 → changes requested → V2 → acceptance.
Its agents, issues, policies, and heartbeat runs are explicitly synthetic test
preparation. Executor and Council are distinct agents, and each decision uses a
fresh active run. The isolated instance and database are removed afterward.

To install the built checkout into a separately selected Paperclip instance:

```sh
paperclipai plugin target
paperclipai plugin install /absolute/path/to/paperclip-council --local
```

Confirm the target diagnostics before installation. Local plugins are trusted
code. This repository is not published by this extraction, and GitHub repository
installation is not a first-class Paperclip workflow.

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

`apiBaseUrl` is the instance origin without `/api`. `councilAgentId` must own
the stored key. `councilApiKey` must remain a `secret_ref`; never store a raw
token in plugin configuration, source, logs, or reports.

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
  "verdict": "changes_requested",
  "justification": "The result needs the corrected marker.",
  "resultReference": "artifact://review/result-v1"
}
```

Accepted verdicts are `changes_requested` and `approved`. The caller must be the
configured Council agent, the run header must resolve normally, and the issue
must be `in_review` and assigned to that agent. The plugin never creates or
reactivates a run.

## Limits and licensing

This package is a trusted decision adapter, not an autonomous council. Anyone
who controls its configuration and secret can exercise the configured agent's
existing authority. The isolated replay qualifies package loading and the native
review transitions only; it does not qualify decision quality, adversarial
security, durable production configuration, external delivery, or model use.

Licensed under the MIT License; see [LICENSE](./LICENSE).
