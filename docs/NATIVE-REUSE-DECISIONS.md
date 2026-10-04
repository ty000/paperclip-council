# Native Paperclip reuse — adopted owner decisions

October 1, 2026. **All 11 points decided by the owner, option A, with the Linear, Slack and Agent-Pixels additions below.** These decisions guide the remaining lots; they are not implementation or runtime evidence.

Purpose: reduce duplicated functionality and competing ownership. The [PRD 0.6](PRD.md) carries the adopted product policy, the [TAD reuse boundary](TAD.md#native-reuse-boundary-for-n2n6) assigns implementation responsibilities, and the [sprint plan](SPRINT-PLAN.md#native-first-implementation-direction) sequences delivery. The grill does not reopen the bounded N1 handoff or authorize implementation, provisioning, provider runs or external publication. Budgets, exact-candidate acceptance and reserved owner decisions remain binding.

Inspection baseline: Paperclip `61b3fd57a695614dc4a37e2303f426a34a9795cf`, also pinned by Council's qualification configuration. Sources below were read locally; they establish available contracts and source behavior, not target-instance configuration or successful Council integration. Council comparison: main `64fc809`, N1 completion `eca320d`, draft N2 `a7760eb`. Absence of an equivalent in these inspected paths is not proof that none exists anywhere in Paperclip.

October 4 refinement: the owner adopted [ordinary CLI Council review](n3/ORDINARY-CLI-REVIEW.md) for new N2/N3 missions. It reuses Paperclip tasks/auth/CLI runs/events and existing Council admission/N3 contracts; native completion-review policy is no longer required by this path. Historical runner missions remain readable and use their persisted protocol. Acceptance still requires the exact Council judgment, terminal usage and durable readback; no N6 closure follows.

## 1. Native review is already a workflow — C02–C06, N2

- **Observed:** execution policy routes executor completion to a selected reviewer, returns requested changes to the executor, resumes the same stage after resubmission and records approval. `maxReviewRounds` exists; the default is three and human decisions reset its counter. Each stage requires one approval; multiple participants are alternatives, not collected specialist opinions. See [transitions and round limits][policy], [transition tests][policy-tests] and [schema][issue-schema].
- **Overlap:** a second generic review/correction loop, round counter or dispatcher in Council could disagree with native assignment and escalation.
- **Limit:** Council's one allowed correction is not automatically native `maxReviewRounds=1`: the native code can escalate to a human when the next changes-requested count reaches the threshold. Compare meanings before copying a numerical limit.
- **Historical decision (superseded for new ordinary-profile missions by the October 4 refinement above):** native review/correction/approval is the default. Align the selected Council correction limit with native semantics; retain exact-candidate binding, contributor/reviewer conflict checks, attributed opinions and uncertain-effect receipts. Add only the missing Council guarantee, not another review workflow or counter with a competing meaning.

## 2. Assignment and routines already trigger execution — C18–C21, N2/N5/N6

- **Observed:** issue assignment queues native wakeups; dependency readiness has persisted wake identities. Routines support schedules, webhooks and API/manual runs with concurrency policies. See [assignment wakeups][assignment], [dependency wakeups][dependency-wakes] and [routines][routines].
- **Overlap:** native assignment, a routine and Council explicit dispatch could all try to start the same work. Polling with an orchestrator agent would add another mechanism.
- **Decision:** progress automatically on native events within the accepted mandate, through one launch owner. The orchestrator assigns and coordinates work; the owner intervenes on exceptions or reserved decisions. Preserve admission before provider launch. Use routines only for a concrete trigger/useful routine, with no periodic model polling or mandatory recurring meeting.

## 3. Native budgets cover a different contract from G4 — C05/C09, N2/N6

- **Observed:** budget policies support company, agent and project scopes; calendar-month or lifetime windows; the supported metric is `billed_cents`. Invocation blocking reads observed cost events and checks pauses/thresholds. See [budget constants][budget-constants], [budget service][budgets] and [cost aggregation][costs].
- **Overlap:** a second monetary ledger, budget UI or company/agent pause system would duplicate native functions.
- **Limit:** these inspected policies do not express Council's per-mission token reservations, arbitrary period envelope or unknown in-flight exposure. Billed-cost totals are not evidence of a token allowance or accurately priced subscription usage.
- **Decision:** native billed-cost policies are the monetary source of truth. Add targeted mission/concurrency/correction limits and the reservation/exposure semantics missing there; no second monetary ledger or billing UI. Preserve the bounded N1 token pilot and its qualification limits. A token reservation is not an absolute per-run ceiling, unpriced usage is not zero, and a later operating profile still needs its applicable G4 admission proof.

## 4. Plans already have native versioned storage — C19, N5

- **Observed:** keyed issue documents support revisions and stale-update rejection through `baseRevisionId`. The bundled `task-planning` skill writes the `plan` document, names owners, evidence and dependencies, and guides decomposition into native child work. See [documents API][issues] and [planning skill][planning].
- **Overlap:** a parallel plan editor, revision store or generic task-graph format in Council.
- **Decision now:** keep the readable plan in a native versioned document, with native child work and enforceable dependency/ownership/limit fields where required. Council stores only missing bindings and guards.
- **Decision with Linear:** consume the already prepared `project → milestone → feature → technical contribution` hierarchy, criteria and dependencies. Linear is the reference for that published breakdown, including its technical scope; Paperclip records execution and a linked operational plan. The planner checks readiness, fills concrete gaps, assigns and coordinates; it does not automatically decompose every imported contribution again or create a competing backlog.
- **Refinement boundary:** internal implementation steps stay in Paperclip. A distinct deliverable or a change to published scope, criteria or dependencies returns to Linear through the authorized path. Adjustments inside the mandate remain delegated; changes outside it require the owner. One contribution need not mean one agent, run or PR. Hierarchy and related links are not automatically hard execution blockers.
- **Source examples:** Workflow [PEZ-585](https://linear.app/pezzoslabs/issue/PEZ-585) describes hierarchical publication; Content Assistant [PEZ-593](https://linear.app/pezzoslabs/issue/PEZ-593) and its contribution [PEZ-603](https://linear.app/pezzoslabs/issue/PEZ-603) already define integration order, criteria, evidence and open questions. Their prepared state is not execution authorization. These private ticket examples informed the interview; connector support remains to be verified.

## 5. Teams and skills already provide a delivery organization — C17/C20, N3/N4/N5

- **Observed:** the bundled Product Engineering team defines CTO, senior coder, QA, a project and a recurring engineering sync, with planning, QA and PR skills. The host has team install/preview and managed agent/project/routine/skill surfaces. See [team definition][engineering-team], [team service][teams] and [plugin resource guide][managed].
- **Overlap:** recreating staffing, skill installation, team distribution or one service per professional title. Installing both organizations could create duplicate managers, QA roles and routines.
- **Decision:** compose suitable existing agents and skills first; prepare only missing responsibilities through normal Paperclip setup. Share roles when useful while keeping acceptance independent from recorded authors/integrators. Council adds its mandates, responsibility mapping and roster snapshots. No automatic provisioning or installation of a second overlapping management team is required.

## 6. Native blockers already express work dependencies — C18/C21, N5/N6

- **Observed:** native issues expose `blockedByIssueIds`, blocker relationships and dependency-ready wakeups. The plugin SDK can read/add/remove blockers. The planning skill explicitly distinguishes hierarchy from execution dependencies. See [issues API][issues], [SDK relation client][sdk] and [dependency wakeups][dependency-wakes].
- **Overlap:** a second dependency graph and readiness scheduler alongside the native issue graph.
- **Decision:** the first M2 scenario uses two missions, the second depending on an accepted result of the first. Demonstrate delegated ordering, explained waiting and resumption after that result is verified. Use native blockers/events plus the missing acceptance binding; preserve existing concurrency/admission limits. Do not introduce a generic resource manager. For an actual exclusive-resource path, use native capacity/isolation/serialization where sufficient and prove non-double-booking (A25); add a claim mechanism only if that selected need remains uncovered.

## 7. Execution workspaces already manage isolation — C16/C18/C20, N5

- **Observed:** Paperclip distinguishes project and execution workspaces, can create/reuse isolated worktrees and can intentionally share an execution workspace across issues. See the [workspace guide][workspaces].
- **Overlap:** another general workspace/branch allocator or cleanup controller in Council.
- **Decision:** use native isolated workspaces for parallel writes where suitable; otherwise serialize conflicting work. Council records write/integration ownership, provenance and the integrated result. No separate general worktree allocator; preserve the working N1 sandbox until a concrete later need justifies changing it.

## 8. Native PR skills and work products cover part of delivery — C23, N5

- **Observed:** the bundled GitHub PR skill covers branch preparation, PR content and review feedback. Native work products support PR references; their service refreshes selected GitHub PR metadata through a resolver. See [PR skill][pr-skill] and [work-product service][work-products].
- **Overlap:** a new publisher framework or duplicated PR record/view. Conversely, a work-product link is not proof that Council created the PR or verified its accepted commit.
- **Decision:** an authorized agent publishes with existing tools; native work products expose the PR link. Council verifies authority, exact candidate and observed effect/readiness. Add only missing bindings/readback, not a new publisher framework. The inspected metadata refresh does not establish every required SDK field. Merge/deployment authority remains separate; point 11 permits useful early draft PRs without an acceptance/readiness claim.

## 9. Native interactions already collect human decisions — C01/C05, N2/F02

- **Observed:** issue interactions support confirmation requests, revision references, addressed users, `human_only` resolution and continuation wakes. Source also permits system resolution; a resolved card does not authorize every subsequent effect. See [interactions API][issues] and [resolver][interactions].
- **Overlap:** another question inbox, approval-card system or continuation queue.
- **Decision:** use native human interactions first. Later, add the selected Slack plugin for notifications and responses linked to the same Paperclip decision. Verify the actual owner, mandate/result binding and answer before dependent work continues. Keep delegated routine decisions autonomous; neither a resolved card nor silence grants new authority. Slack's additional workflow/agent-loop features are not part of this initial integration.

## 10. Native views can carry most operational information — C07/C08, all later lots

- **Observed:** native issues expose plans, documents, relations, interactions and work products; costs/budget surfaces already exist. See [issues API][issues], [work products][work-products] and [costs][costs].
- **Overlap:** a Council project board, plan editor, cost dashboard and PR tracker each duplicating a native surface.
- **Decision:** native screens by default, with a compact Council summary only for missing information/actions: pinned composition/mandate, reviewed candidate, attributed opinions/dissent, verdict, uncertainty and next action. Retain useful existing screens. Add further UI for observed user friction, not a duplicate board, plan editor, cost dashboard or PR tracker. Agent-Pixels is a later visual addition; operational decisions and evidence remain in Paperclip/Council.

## 11. Reused skills bring product choices, not just implementation — C01/C06/C19/C23, N4/N5

- **Observed:** `task-planning` says not to create subtasks until plan acceptance; the Product Engineering pack includes a weekly sync. `github-pr-workflow` discourages draft PRs before functional completion and asks for broad verification/screenshots and renewed review after fixes. See [planning][planning], [team][engineering-team] and [PR workflow][pr-skill].
- **Overlap/conflict:** importing those defaults literally could introduce extra approvals, ceremonies and review cycles, or contradict Council's delegated planning and distinction between an opened draft PR and a ready PR.
- **Decision:** proceed autonomously within the accepted mandate, including planning/replanning; escalate only decisions outside it or explicitly reserved. Permit authorized early draft PRs when useful for integration/discussion, while keeping accepted-candidate delivery and readiness distinct. Convene a council/sync for a concrete disagreement, blocker or coordination need. Define proportionate checks and exit criteria before work; use bounded reviews, fix material defects and defer optional improvements. Another review needs a specific changed or unresolved risk, not unused cycle budget. Required independent acceptance still applies. Adapt only skill instructions conflicting with this policy; do not build a new skills framework.

## Delivery impact and later integrations

N2 retains its native correction/acceptance outcome and existing G3/G4 boundaries. N3 composes relevant opinions; N4 evaluates the selected agents and journey. N5 reuses a native plan, existing decomposition, workspace isolation and agent publication to finish M1. N6 uses the accepted-result dependency scenario for M2. Apply point 11 throughout. No preliminary audit sprint, plugin rewrite, Executive restart or new qualification campaign follows from the grill.

| Later addition selected by the owner | Intended role | Narrow verification when integrating |
| --- | --- | --- |
| [Linear plugin](https://github.com/Oldharlem/paperclip-linear-plugin) | Import prepared product and technical work, linked to its authoritative Linear hierarchy; Paperclip executes | README describes issue/comment synchronization, not proof of complete milestone/parent/dependency mapping. Verify hierarchy, criteria/source references, field ownership and status feedback on one representative feature; avoid pushing internal execution steps as new product tickets. |
| [Slack plugin](https://github.com/mvanhorn/paperclip-plugin-slack) | Notifications and bound human responses, retained in Paperclip | README describes notifications and issue-thread confirmations. Verify responder identity and exact decision continuation; installing it must not enable a competing dispatcher, discussion loop or timeout approval. |
| [Agent-Pixels](https://github.com/gcampton/Agent-Pixels) | Optional visual representation of agents/activity | README describes an animated office view. Check target-host compatibility and interpretation of displayed activity when adding it; operational state and acceptance stay in Paperclip/Council. |

These repository descriptions were read on October 1, 2026; no integration was installed or qualified. Each addition follows its corresponding native working path, with no fixed order among the three and no new N2–N6 exit requirement. This is a bounded adoption direction, not a connector-development programme.

[policy]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/issue-execution-policy.ts
[policy-tests]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/__tests__/issue-execution-policy.test.ts
[issue-schema]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/shared/src/validators/issue.ts
[assignment]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/issue-assignment-wakeup.ts
[dependency-wakes]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/issue-dependency-wakeups.ts
[routines]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/docs/api/routines.md
[budget-constants]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/shared/src/constants.ts
[budgets]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/budgets.ts
[costs]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/costs.ts
[issues]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/docs/api/issues.md
[planning]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/skills-catalog/catalog/bundled/paperclip-operations/task-planning/SKILL.md
[engineering-team]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/teams-catalog/catalog/bundled/software-development/product-engineering/TEAM.md
[teams]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/teams-catalog.ts
[managed]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/doc/plugins/PLUGIN_AUTHORING_GUIDE.md
[sdk]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/plugins/sdk/src/types.ts
[workspaces]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/docs/guides/board-operator/execution-workspaces-and-runtime-services.md
[pr-skill]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/packages/skills-catalog/catalog/bundled/software-development/github-pr-workflow/SKILL.md
[work-products]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/work-products.ts
[interactions]: https://github.com/paperclipai/paperclip/blob/61b3fd57a695614dc4a37e2303f426a34a9795cf/server/src/services/issue-thread-interaction-resolution.ts
