# Project task intake

An owner can suspend a current policy with `{companyId, command: "suspend", commandId, expectedVersion}` on the policy route. Suspension retains the original content and baseline as a new disabled revision, and works even when accounting or actors are unavailable.

Council 0.7.12 consumes new manual, parentless **Backlog** tasks assigned to the project's pinned integration lead. The existing native `mission-continuity` scheduled job creates a Council mission, reserves the lead against the existing admission period and delegates the nominal ordinary cycle. No Codex chat, second scheduler or intake model run is required.

The responsible company owner registers a policy with `POST /api/plugins/private.paperclip-council/api/companies/:companyId/projects/:projectId/mandate`. `GET` on the same route reads the current policy. Requests carry `companyId`; a write also carries a stable `commandId`, the exact `expectedVersion`, `authorizeNewTasks: true`, and:

- `enabled`, active `teamRosterId` and `councilRosterId`, and 2–7 independent `n3Slots`;
- `template` containing acceptance criteria, commitments and existing mission limits (`taskPolicy`, `periodPolicy`, `correctionLimit`, `elapsedMinutes`);
- `criteriaSource`: `project-defaults` uses the template criteria. `task-document` requires the root's native `council-task` JSON document with `acceptanceCriteria` and optional `commitments` only;
- `allowedPaths`: explicit repository paths/prefixes. `.` explicitly authorizes the whole repository; a narrower prefix never authorizes its sibling or parent;
- `publication`: explicitly `null`, or `{publisherAgentId, qaAgentId, repository, baseRef, headRefPrefix}`. Branches are exactly `${headRefPrefix}-${missionId}`, with a `codex/` prefix. This delegates PR publication under the existing N5 checks; it grants no merge or deployment rights;
- optional `includedRootIssueIds` for at most 20 roots already present when the policy is registered.

Existing project roots otherwise become a preserved baseline. Complete project inventories are bounded to 500 issues, active policy scans to 100 projects and receipts to 100 per project; exceeding a bound stops the scan visibly instead of silently adopting an incomplete history. Existing G4 accounting must already be configured. Intake never creates a period, resets usage or raises the operating correction bound.

The task title and description supply the expected result (at most 8000 characters together). Council persists the mission ID, exact source revision/hash, policy revision and command payload before each effect. Root creation is never repeated. A lost creation or activation response resumes the same command and reservation. The admitted lead discovers the mission through `inspect` on its exact root without having to obtain a UUID from Codex; normal actor, run and checkout checks still apply.

Before first activation the source must still match its snapshot. Before subsequent departures the original project revision, responsible owner, operating configuration and mission mandate must still match. Updating or disabling a policy does not silently migrate existing missions. Settlement and readback can retain already admitted costs; uncertain effects are never replaced by a new identity.

Missing information or an unsupported condition creates one native question per retained condition, bound to the original project revision, root and owner. Its `continuationPolicy` is `none`: neither the question nor its response starts a model or grants additional authority. A complete edit within the existing mandate can be consumed on a later scheduled pass.

For a publication policy, the job prepares an immutable native operational-plan document from the verified contribution commits before review. The existing publisher admission, independent review, GitHub permission check inside the admitted publisher run, one-shot publication claim and exact PR readback remain mandatory. A null policy ends at candidate acceptance.

This tranche handles a fresh root with the existing two-contribution N1 engine. Pre-existing children are preserved and stop intake with a precise question; issue #51 owns variable hierarchy adoption. Historical missions retain their original contracts. Installed capability, project-policy configuration and actual model execution are separate facts. No production project policy is enabled by installation alone.

Qualification: `COUNCIL_ORDINARY_DELIVERY=1 COUNCIL_CONTINUITY=1 COUNCIL_PROJECT_INTAKE=1 pnpm exec tsx tests/functional/ordinary-installed.ts`. The native host, scheduler, database, SDK, worker, admission and APIs are real and unchanged. CLI model/content/usage and GitHub transport are deterministic. It creates one complete root after policy registration, retains historical and existing-child tasks, verifies single owner questions and restarts the worker between N1 settlement and review. After task creation there are no owner mission commands or manual job triggers.
