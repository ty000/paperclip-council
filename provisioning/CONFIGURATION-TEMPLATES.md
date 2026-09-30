# Paperclip configuration templates

Status: **not applicable as-is**. Replace every angle-bracket input from the
inventory below, re-read the target schema/version and prepare a diff against
the selected existing identity. These fragments are operator preparation, not a
manifest or provisioning engine.

Inspected source: Paperclip
`61b3fd57a695614dc4a37e2303f426a34a9795cf`, including
`packages/shared/src/validators/agent.ts`,
`packages/shared/src/validators/adapter-skills.ts`,
`packages/adapters/codex-local/src/index.ts` and
`server/src/routes/agents.ts`.

## Unresolved inputs

- target instance/version, company, project and authenticated board/CEO actor;
- selected existing agent ID for each participation, reports-to relationship and
  current status;
- exact workspace strategy/default environment and allowed repository roots;
- effective Codex authentication/home and model/effort availability;
- task/period budgets, time/correction/retry limits and measurement source;
- actual company-library keys/version IDs for `council-review` and optional
  skills, plus runtime mount support;
- target-specific filesystem/network confinement and required tool endpoints;
- final-reviewer secret reference mapping and supported Council review/readback
  route;
- current instruction bundle mode, entry file, revision/hash and customization
  diff;
- whether an Integration Lead genuinely needs task-assignment authority.

No UUID, secret, home path, budget or installed skill version is supplied by this
repository.

## Existing-agent configuration diff

Use `PATCH /api/agents/<agent-id>` only for supported profile/adapter/runtime
fields. Fetch the current configuration first. The route normally merges
`adapterConfig`; keep `replaceAdapterConfig` absent/false unless an intentional
complete replacement has been reviewed.

Common fragment:

```json
{
  "role": "<profile-native-role>",
  "title": "<profile-title>",
  "capabilities": "<bounded durable capability summary>",
  "adapterType": "codex_local",
  "adapterConfig": {
    "engine": "cli",
    "model": "gpt-5.6-sol",
    "modelReasoningEffort": "medium",
    "dangerouslyBypassApprovalsAndSandbox": false,
    "search": false,
    "fastMode": false
  },
  "replaceAdapterConfig": false
}
```

The existing-agent fragment intentionally omits `runtimeConfig`. In the
inspected update path it is a replacement object, not the field-level merge used
for `adapterConfig`. To change timer policy, start from the complete redacted
current `runtimeConfig`, preserve every intended retry/concurrency/debug/auth
binding, set `heartbeat.enabled` to `false` and `heartbeat.wakeOnDemand` to
`true`, then submit the reviewed complete object. Never send only the two-field
heartbeat example to an existing customized identity.

Profile substitutions:

| Profile | `role` | `title` | Capability summary |
| --- | --- | --- | --- |
| Executor | `engineer` | `Software Executor` | Bounded contribution, verification and attributable handoff; Integration Lead only when assigned |
| Generalist Reviewer | `general` | `Generalist Reviewer` | Independent final review, objection synthesis and supported decision/readback |
| Product Reviewer | `pm` | `Product Reviewer` | Attributed product/user-outcome opinion for selected Council rounds |
| Development Reviewer | `engineer` | `Development Reviewer` | Attributed code-level correctness and local-contract opinion for selected Council rounds |
| Architecture Reviewer | `engineer` | `Architecture Reviewer` | Attributed boundary, interface and consequential structural opinion for selected Council rounds |
| UX & Accessibility Reviewer | `designer` | `UX & Accessibility Reviewer` | Attributed usability and accessibility opinion for selected Council rounds |
| Quality Reviewer | `qa` | `Quality Reviewer` | Attributed evidence/coverage opinion for selected Council rounds |
| Security Reviewer | `security` | `Security Reviewer` | Attributed trust, authority and sensitive-data risk opinion for selected Council rounds |
| Operations Reviewer | `devops` | `Operations Reviewer` | Attributed configuration, runtime, recovery and operability opinion for selected Council rounds |

All nine substitutions keep the common `gpt-5.6-sol` / `medium` starting
recommendation. A title never changes model or effort automatically; reconsider
only for a separately framed problem under the current model/effort mapping and
verify availability at activation.

Do not add `cwd`, `CODEX_HOME`, environment IDs, budgets, sandbox/network fields
or tool credentials until the target values and compatibility are known. The
`codex_local` source supports optional spawn-level filesystem/network scopes for
CLI, but their host prerequisites and required provider/API allowlist must be
qualified; the charter alone is not enforced isolation.

## Instructions update

For an existing identity, first read:

```text
GET /api/agents/<agent-id>/instructions-bundle
GET /api/agents/<agent-id>/instructions-bundle/file?path=<entry-file>
```

Then review a merge from the applicable `agents/*/AGENTS.md` into the current
customized entry. Use the dedicated file endpoint with the current concurrency
token:

```json
{
  "path": "<current-entry-file>",
  "content": "<reviewed merged profile text>",
  "baseRevisionId": "<current-entry-revision-id>"
}
```

`PUT /api/agents/<agent-id>/instructions-bundle/file` is the inspected write
surface. Do not assume that the current entry is named `AGENTS.md`; a bundle
entry/path change is a separate reviewed bundle configuration operation. For a
non-entry managed file, use its current `baseHash`; `null` is only for a genuinely
new file. Read back content and the new revision/hash. On `409`, re-read and
re-review the diff rather than retrying stale content.

Do not send a creation-only `instructionsBundle` through general update as a
replacement for this workflow.

## Skill selection

First verify the company library and the agent snapshot. Resolve real keys and
version IDs before constructing this request:

```json
{
  "mode": "add",
  "desiredSkills": [
    "<resolved-paperclip-key-if-required-by-deployed-contract>",
    "<resolved-council-review-key>"
  ]
}
```

Use `POST /api/agents/<agent-id>/skills/sync`. Add optional
`qa-acceptance`, `github-pr-workflow`, `design-critique` or an actually available
domain skill only for a selected profile/mission need. No Development,
Architecture, Security or Operations title implies a dedicated skill or tool.
Prefer `add`/`remove`; `replace` affects the entire desired set. A non-null
`versionId` is valid only when the target's Beta version-pin contract is enabled.
Read back both saved desired skills and runtime skill snapshot because sync
failure can leave desired state changed.

Source presence here is not company installation, desired selection, mount or
execution proof.

## Permissions

The dedicated endpoint requires both creation and assignment booleans:

```json
{
  "canCreateAgents": false,
  "canCreateSkills": false,
  "canAssignTasks": false
}
```

Use `PATCH /api/agents/<agent-id>/permissions`, then read the returned agent
detail, membership and grants. For the inspected source, active membership can
still yield effective `canAssignTasks: true` with source `simple_default`; the
request above is not an enforceable denial by itself. If an Integration Lead
needs assignment, specify the concrete flow and grant/readback rather than
silently broadening every Executor.

`canCreateSkills: false` also does not replace the current company-skill policy
and grant checks. New creation/hire currently applies a default task-assignment
grant; any intended revocation is a separate, post-approval operation and is not
available while a hire remains pending. Read back the effective state instead
of treating these fields as universal access-control switches.

## Governed hire fallback

Use only when identity inventory proves no eligible existing agent. Prefer
`POST /api/companies/<company-id>/agent-hires`; company policy may return a
pending approval rather than an active agent. The creation schema accepts an
initial `instructionsBundle` and `desiredSkills`, unlike an existing-agent
instruction update.

```json
{
  "name": "<owner-selected-identity-name>",
  "role": "<profile-native-role>",
  "title": "<profile-title>",
  "reportsTo": "<resolved-manager-id-or-null>",
  "capabilities": "<bounded durable capability summary>",
  "adapterType": "codex_local",
  "adapterConfig": {
    "engine": "cli",
    "model": "gpt-5.6-sol",
    "modelReasoningEffort": "medium",
    "dangerouslyBypassApprovalsAndSandbox": false,
    "search": false,
    "fastMode": false
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true
    }
  },
  "instructionsBundle": {
    "entryFile": "AGENTS.md",
    "files": {
      "AGENTS.md": "<applicable reviewed profile text>"
    }
  },
  "desiredSkills": [
    "<resolved-paperclip-key-if-required-by-deployed-contract>",
    "<resolved-council-review-key>"
  ],
  "permissions": {
    "canCreateAgents": false,
    "canCreateSkills": false
  }
}
```

This placeholder payload is intentionally non-applicable and has not been sent.
At future use, validate the fully resolved payload against the deployed create
schema, submit once, then read back the returned identity, approval, configuration,
bundle and skills. A timeout requires reconciliation across agents and linked
approval/source-issue records before another hire request; names are not unique
idempotency keys.

Profile changes can be protected changes in the deployed instance and may need
the current grant/consent flow. A submitted hire approval is likewise separate
from its later approval or activation.

## Readback checklist

- Identity/company/project/org relation and status match the selection.
- Role/title/capabilities and adapter fields equal the reviewed diff.
- Explicit CLI engine, model/effort and bypass false are observable; account
  availability/auth mode is separately verified without exposing secrets.
- Timer heartbeat is disabled; on-demand wake and concurrency/retry policy are
  deliberate activation inputs.
- Effective permissions, membership and grants are recorded, especially task
  assignment source.
- Bundle mode, entry, content, revision/hash and preserved custom clauses match.
- Required company skills exist; desired keys/versions and runtime mount/tool
  snapshot are distinguished.
- Candidate/workspace access and disposable verification output are adequate;
  reviewer candidate modification remains prohibited and any enforced boundary
  is separately proven.
- Final-reviewer identity/secret reference and supported decision/readback path
  match without revealing credentials.
- State is reported separately as declared, installed, desired, loaded,
  configured, activated and executed.

Activation and trial execution are explicitly outside this preparation lot.
