# Native project setup and review

Lot #70, Council 0.7.23, October 9, 2026. Source baseline: Council
`1e7f37481aceaf0671ede9b843904b9a8a89f1b2`; Paperclip qualification host
`61b3fd57a695614dc4a37e2303f426a34a9795cf`; npm SDK `2026.916.1`.
The host checkout builds its own SDK; it is not the npm SDK version. This recipe
does not change Paperclip or its SDK. Linear intake belongs to its separate plugin.

## Ownership and available native surfaces

| Capability | Native setup | Council connection | Access and proof limit |
| --- | --- | --- | --- |
| Project workspace | Operator sets primary workspace, repository/base, execution policy and preparation commands | `projects.getPrimaryWorkspace`, declared `project.workspaces.read`; coordinator inherits root workspace | SDK can read workspace metadata, not prove checkout contents or dependency preparation |
| Agent runtime | Operator creates CLI actors, instructions, native skill links, tools and grants | Existing team/Council rosters and model profile selection | Agent configuration is readable; effective injected tools/skills must be observed in its run |
| Task context | Native task description, hierarchy, work documents and immutable execution document | Existing project mandate/intake and `materialize` | New root must be assigned to the declared lead; hierarchy leaves retain their original IDs and blockers |
| Independent review | Ordinary native CLI tasks/auth/runs/events | `ordinary-cli-v1`, bounded N3 slots, designated Council final reviewer, existing correction controller | Native completion `executionPolicy` review is a different protocol; do not activate both on ordinary tasks |
| Admission | Native run inventory and per-run token usage | Existing G4 reservations, mission deadline, run and correction limits | A monthly monetary budget cannot establish known mission token exposure |
| GitHub publication | Native external objects, refresh, work products; publisher credentials in agent environment | Existing attributed publisher preflight, exact submission/candidate and bounded PR contract | Server connector access and operator `gh` login do not prove publisher push/PR rights; grant inspection is operator-only |
| Wait and recovery | Native dependencies, issues and demand wake policy | Existing Council job and wake guard | No periodic agent polling, manual child wake or competing scheduler |

These contracts are documented in [native reuse decisions](../NATIVE-REUSE-DECISIONS.md),
[ordinary review](../n3/ORDINARY-CLI-REVIEW.md) and
[publication](../n5/NATIVE-DELIVERY.md). Core implementation references at the pinned
host: `packages/plugins/sdk/src/types.ts`, `server/src/services/plugin-host-services.ts`,
`server/src/services/heartbeat.ts`, `docs/guides/board-operator/execution-workspaces-and-runtime-services.md`.

## Configure once, before enabling new tasks

1. Prepare a native primary checkout with an explicit repository and base. Decide
   shared versus isolated execution, and configure the project's native dependency
   preparation and verification commands. The current Council ordinary contribution
   path requires a common Git candidate; this diagnosis supports an absolute native
   primary path and does not claim support for arbitrary isolated worktree strategies.
   Record preparation output and the base SHA; do not grant arbitrary new shell rights.
2. Link the applicable native task/Git/PR skills to fresh CLI actors. Provide their
   role instructions through native agent configuration. Give the publisher the
   minimum repository/PR permissions required by the explicitly delegated result.
   Keep contributor, specialist, final reviewer and publisher identities independent
   under the existing roster validation. Set native heartbeat `enabled: false`,
   `wakeOnDemand: true`; the admitted Council controller owns phase departures.
3. Configure the existing `ordinary-cli-v1` profile, token accounting, bounded run
   and correction limits, then activate the exact team/Council roster revisions.
   Do not add native completion review cards to ordinary tasks. Link the pinned
   project mandate to these roles, write paths, acceptance criteria, deadline and
   explicit publication contract. GitHub fusion/integrated delivery belongs to #72.
4. Enable new-task delegation through the existing owner-only versioned mandate
   command. Read back its revision and inspect setup before creating the first task.
   Do not silently adopt historical roots or change an active mission's configuration.

## Read-only diagnosis

As the company's responsible owner, call:

```text
GET /api/plugins/{pluginId}/api/companies/{companyId}/projects/{projectId}/mandate?companyId={companyId}&readiness=true
```

`readiness` uses protocol `council-project-readiness-v1` and reports the exact policy
revision, observation time and individual checks. `configurationReady` requires a
current enabled mandate, matching owner/configuration and published rosters, a
primary absolute workspace, conclusive existing accounting, and available demand-only
CLI actors. No reservation, configuration write, task creation or wake occurs.
The historical GET without this query preserves its existing response.

`launchAuthorized` is always false: this inspection is advisory and does not replace
the existing admission/launch gates. `run-check-required` explicitly covers effective
agent tools, native skill injection, preparation/Git writes and publisher rights.
Neither credentials nor raw agent environment/configuration are included in the
response. The diagnosis reads the existing period; it never creates or resets one.

## Reproducible qualification

```sh
pnpm qualification:host:prepare
pnpm build
COUNCIL_NATIVE_SETUP=1 COUNCIL_PROJECT_INTAKE=1 COUNCIL_CONTINUITY=1 \
  COUNCIL_ORDINARY_DELIVERY=1 COUNCIL_HIERARCHY_COUNT=3 COUNCIL_PR_FEEDBACK=1 \
  pnpm exec tsx tests/functional/ordinary-installed.ts
```

This owns a temporary company, new actors, Git checkout, installed plugin worker and
native database. Setup diagnosis occurs before the new task. The scheduled native
job then runs intake, attributed contributions, independent Council review and a
bounded correction of the same PR. Model content/token usage and GitHub responses
are deterministic fixtures; native auth/tasks/documents/runs/jobs/accounting and Git
are real. It does not prove live model quality, effective production GitHub grants
or installation on the operational instance. Runtime cleanup is part of the proof.

Install and activate separately. For the target instance, preserve active missions,
read back its installed artifact/version and configuration, then qualify a bounded
real task under an explicit provider/publication grant before claiming operational
autonomy. A green deterministic qualification alone does not close that requirement.
