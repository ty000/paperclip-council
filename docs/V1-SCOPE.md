# Paperclip Council — V1 scope

Version 0.2 — September 30, 2026. Product framing for implementation; no deployed capability is asserted.

Authority: [PRD 0.4](PRD.md), especially §6.3 and C01–C11, C16–C18. Technical realization: [TAD](TAD.md). Delivery sequence: [implementation plan](IMPLEMENTATION-PLAN.md).

## 1. Selected outcome and decision status

The owner selected a first version containing the mechanics of councils and teams, with learning and memory in a second phase. A useful V1 lets the owner configure an execution team and a reviewing council, assign a bounded mission, obtain an integrated submission, collect relevant opinions, resolve a disagreement, request corrections and obtain an applied acceptance decision. Suspension, human escalation and restart must remain understandable.

The scope decision is confirmed by the September 30 request. The defaults below are explicit design proposals made to render it implementable; they are not claims that the owner selected particular agents, budgets or runtime settings. They can be adjusted without inventing past approval.

| Decision | V1 treatment | Status |
| --- | --- | --- |
| Teams, councils, correction, arbitration, bounded appeal | Included, with actual multi-agent qualification | Owner-selected scope |
| Memory and learning | Deferred; no knowledge ingestion, retrieval engine or process self-improvement | Owner-selected exclusion |
| Durable mission history and restart | Included under C05; a restart must not lose assignments, opinions or decisions | Required by existing PRD |
| Initial actors | One human owner; existing Paperclip agents selected explicitly | Design default |
| Agent provisioning | Use Paperclip setup/catalogue when needed; Council composes references, does not create agents automatically | Design default |
| Verdict | One accountable final reviewer, informed by required attributed opinions | PRD-derived design |
| Appeal | One appeal level per disputed question and submission; no recursive councils | Bounded implementation default |
| Result type | Software mission delivering a Git commit and accessible evidence; other artifact-only approval contracts deferred | Initial technical scope |
| Runtime | One explicitly selected WSL-native Paperclip company/project; company isolation still enforced | Initial qualification scope |
| Human interface | Minimal plugin page and issue detail summary inside Paperclip | Design default; accessibility qualification pending |

## 2. Domain vocabulary

| Concept | Meaning and boundary |
| --- | --- |
| Execution team | Named, company-scoped, revisioned roster of agent references and responsibilities, optionally restricted to a project. It owns no separate agent runtime. |
| Council | Revisioned roster of reviewing perspectives, an accountable final reviewer and a bounded decision policy. It is not an extra Paperclip company or a native stage containing several alternative assignees. |
| Mission | Council's governed view of one root Paperclip issue, its mandate, execution plan, pinned rosters and result. |
| Contribution | Bounded work assigned to one agent through a child issue, with dependencies, required output and inspection evidence. |
| Integration lead | The named agent responsible for combining contributions and submitting the coherent result; may also be a contributor. |
| Review round | Review of one immutable submission and evidence revision against a pinned mandate and selected perspectives. |
| Opinion | An attributed domain judgment; supports the final verdict but does not independently close the root issue. |
| Verdict | Accountable decision: approve or request changes, with rationale, resolved objections and evidence. Owner escalation and insufficient evidence are waiting states, not approvals. |
| Appeal | A bounded review of one unresolved question using identified participants and compared arguments. |
| Acceptance | A verdict whose effect is confirmed on the covered native workflow and whose exact submission remains identified. It does not authorize delivery. |

Several teams and councils can be configured; each mission selects one execution team and one council. V1 supports several contributors and several reviewing perspectives without requiring every mission to use them. A simple mission may use one executor and one distinct reviewer. Cross-company rosters and autonomous councils that create further councils are excluded.

## 3. Team and council lifecycle — C17–C18

The owner can create a draft roster, select existing agents and their responsibilities, validate prerequisites, activate a revision, revise it, suspend it and retire it. Missing identities, project incompatibility and executor/reviewer conflicts are visible before activation. A roster revision alone neither alters a Paperclip agent's global instructions nor grants it permissions.

Each mission records the roster revisions, integration lead, final reviewer, owner and required review perspectives it uses. Editing a roster affects future missions. Replacing a member in an active mission is an explicit reconfiguration: identify the actor, reason, affected contributions and invalidated opinions; pause affected dispatch while the transition is reconciled. The replacement must be eligible before resuming. Decisions already applied remain attributed to their actual authors.

The final reviewer and counted reviewing specialists must not have authored or integrated the reviewed submission. A contributor may supply factual clarification, but that is not a required independent opinion. If an agent fixes the submission, another eligible reviewer must review the changed result. The plugin cannot infer undisclosed off-platform authorship; recorded provenance and instructions support this boundary.

Suspending a roster rejects new missions using it. Existing missions retain their pinned revision and show the suspension; they continue unless explicitly suspended as well. Suspending a mission stops new dependent dispatch and decision application, accounts for in-flight effects and preserves the next action. Retirement removes a roster from future selection, not from history. Mission cancellation is explicit and never becomes acceptance. No agent, issue or evidence is deleted automatically.

## 4. End-to-end mission

1. **Configure.** The owner selects company/project, team, council, owner escalation destination, covered result/workflow, mandate and operating limits. Validation distinguishes configuration saved from activation ready.
2. **Plan.** The integration lead proposes bounded contributions, their assignees, dependencies and integration checks within the mandate. Scope or authority changes wait for the owner. Independent contributions may run in parallel; dependencies and workspace ownership are explicit.
3. **Execute and integrate.** Paperclip owns agent runs and issue checkout. Completion of child issues is input to integration, never root acceptance. A failed or missing required contribution blocks submission until corrected or explicitly replanned within authority.
4. **Submit.** The lead publishes the integrated Git candidate, manifest, accessible bundle and criterion-linked evidence. The review identifies all contributing agents and the exact content. Changes create a new submission; added evidence creates a new evidence revision.
5. **Review.** The council collects the selected required perspectives on that submission. A missing opinion waits or leads to explicit replacement/escalation. Optional advice does not block forever. No absence is counted as agreement.
6. **Decide.** The final reviewer addresses material objections, respects the mandate, and issues a reasoned verdict. An unsupported majority cannot overcome contradictory evidence. A correction identifies the smallest justified change and sends actionable work back to integration/contributors.
7. **Appeal or ask the owner.** A consequential unresolved question may use the configured one-level appeal. If no eligible participant exists, evidence remains inconclusive or the authority is reserved, the owner receives options, consequences and a recommendation. Silence never approves.
8. **Apply and inspect.** The plugin records the intended effect, applies through the native review route and checks the resulting decision and state. A timeout becomes an uncertain application to reconcile. The owner sees the reviewed result, next actor, pending follow-up and actual effect.

Appeal participants issue a resolution or recommendation; the originally accountable final reviewer remains responsible for applying the verdict in V1. It must incorporate the resolution within the mandate or explain an unresolved blocker and escalate. No appeal participant silently acquires root closure rights.

## 5. Operational state versus deferred memory

V1 retains the current mission's mandate, assignments, roster revisions, submission revisions, opinions, appeal, owner responses, application attempts, follow-up and measurements. Another eligible agent can resume that same mission from persisted records. Prior rounds remain inspectable; a new result does not inherit approval automatically.

V1 does not extract reusable lessons, adopt knowledge items, build role/project retrieval, transfer experience to new missions, score learning benefit, auto-tune instructions or maintain a knowledge steward. C12's cross-mission continuity and C13–C15 remain deferred. A simple link to an earlier issue is not a learning feature. No vector store, embedding service or separate memory engine is required by this scope.

## 6. Authority, limits and stopping

The [owner mandate](PRD.md#63-initial-delegation-profile), including the explicitly approved DEC-G4-01 policy, applies: protected essential uses, affected-group p95 strictly below 30 seconds for delegated degradations, owner decisions for infrastructure cost changes in either direction, and both task and period spending limits. The mandate's majority refers to usage, not votes. The TAD defines guard records without pretending that prompts prove product facts.

Activation requires explicit task/period budget policy, review/correction limits, appeal limit, elapsed-time limits, owner destination and available measurement sources. This document invents no monetary envelope. Missing decisive cost or impact information produces bounded investigation or owner waiting; unknown is never zero. Native agent budgets alone do not establish an aggregate Council mission budget. V1 requires atomic admission reservations and mandatory operational limits, but does not promise an absolute monetary ceiling on already-committed work. Unknown remaining exposure blocks new launches. The [G3/G4 decisions](G3-G4-DECISIONS.md) authorize the minimal supported readback direction and adopt this budget policy; neither is runtime qualification.

The initial authority claim covers Council-managed submissions, reviews and decisions for selected root issues. Administrative overrides, direct platform mutations and external merge/deployment paths are separately attributed and outside that guarantee. If a policy is removed or native ownership drifts, Council suspends application until reconciled. External delivery integrations require their own authorization and qualification.

## 7. Minimal inspection experience — C07–C09

The owner needs a team/council configuration page and a mission view linked from the native issue. The view shows mandate and limits, pinned composition, contributions and dependencies, result/evidence identity, required and received opinions, objections, appeal, verdict, confirmed native effect, owner waiting, usage gaps and next action.

Commands include validate/activate, revise/retire a roster, enable supervision, explicitly reconfigure a mission, suspend/resume/cancel, and request reconciliation. Owner-reserved decisions use the attributable native human interaction. Agent commands use authenticated routes, not browser controls that claim an agent identity.

Required states include loading, empty/unconfigured, invalid setup, active work, missing evidence, waiting for a member, correction, appeal, waiting for owner, applying, uncertain application, accepted, suspended, cancelled and failed. Errors explain who can act and what is preserved. Controls are keyboard usable, focus is managed after actions, status does not rely on color, and evidence links have meaningful labels. Reuse Paperclip components and tokens; no separate design system. Start with English labels consistent with this repository and Paperclip, use layouts that reflow on narrow windows, and defer additional translations or a mobile-specific application. These are design defaults, not tested UX claims.

## 8. Release acceptance and activation inputs

V1 requires the selected PRD scenarios A01–A11, A17–A22, plus the operational portion of A16. A12–A15 and learning attribution in A16 are deferred. Required demonstrations include two contributors with a genuinely integrated result, at least two distinct relevant review perspectives, correction and re-review, one bounded disagreement/appeal, owner waiting, roster replacement and restart recovery. Simple two-agent success is insufficient.

Deterministic tests cover state, authorization and concurrency. A real authenticated Paperclip instance covers persistence, plugin lifecycle, attribution and effects. Representative real-agent work covers reasoning, coordination and usability claims. These layers cannot substitute for one another. The qualification records failures, manual interventions and missing measurements alongside successes.

Inputs still needed before live activation: concrete instance/company/project, owner user identity, eligible agent roster and actual tools/authentication, budget and time limits, representative repository/task and evidence location. These do not prevent document or bounded code work. The TAD separately lists technical feasibility gates that can change implementation choices.
