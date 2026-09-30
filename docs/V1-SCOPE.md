# Paperclip Council — V1 scope

Current V1 decision (September 30, 2026, priority rescope): [DEC-G3-02](G3-G4-DECISIONS.md#dec-g3-02--plugin-only-receipts-and-preserved-uncertainty) replaces mandatory host D-H/readback and automatic ambiguous-result recovery with plugin-private receipts, a persistent uncertainty hold and authenticated human acknowledgement/abandonment. No Paperclip change or upstream PR acceptance is a V1 dependency. Human handling never confirms native success or unlocks an equivalent uncertain action. Other acceptance criteria and G4 remain mandatory. Historical reports retain their original verdicts.

Version 0.4 — September 30, 2026. Product framing for implementation; no deployed capability is asserted.

Authority: [PRD 0.5](PRD.md), especially §6.3 and C01–C11, C16–C23. Technical realization: [TAD](TAD.md). Delivery sequence: [implementation plan](IMPLEMENTATION-PLAN.md).

## 1. Selected outcome and decision status

The owner selected a first version containing councils, implementation teams and durable project coordination, with learning and reusable knowledge in a second phase. V1 carries a bounded task through technical planning, serial/parallel contributions, integration, specialized verification, Council acceptance and an authorized PR. It also coordinates several missions sharing capacity or dependencies. Suspension, human escalation and restart must remain understandable.

The scope decision is confirmed by the September 30 request. The defaults below are explicit design proposals made to render it implementable; they are not claims that the owner selected particular agents, budgets or runtime settings. They can be adjusted without inventing past approval.

| Decision | V1 treatment | Status |
| --- | --- | --- |
| Teams, councils, correction, arbitration, bounded appeal | Included, with actual multi-agent qualification | Owner-selected scope |
| Implementation orchestration and PR handoff | Technical planner, accountable mission orchestrator, skill-based contributors, integration and QA | Owner-selected C19–C20, C23 |
| Durable project coordination | Project Manager coordinates multiple missions within delegated priorities, finite capacity and dependencies | Owner-selected C21 |
| Scrum Master / facilitation | Available for a concrete cooperation blocker or bounded council; no mandatory recurring ceremony | Owner-selected C22 |
| Memory and learning | Deferred; no knowledge ingestion, retrieval engine or process self-improvement | Owner-selected exclusion |
| Durable mission history and restart | Included under C05; a restart must not lose assignments, opinions or decisions | Required by existing PRD |
| Initial actors | One human owner; existing Paperclip agents selected explicitly | Design default |
| Agent provisioning | Use Paperclip setup/catalogue when needed; Council composes references, does not create agents automatically | Design default |
| Verdict | One accountable final reviewer, informed by required attributed opinions | PRD-derived design |
| Appeal | One appeal level per disputed question and submission; no recursive councils | Bounded implementation default |
| Result type | Software mission delivering a Git commit and accessible evidence; other artifact-only approval contracts deferred | Initial technical scope |
| Runtime | One explicitly selected WSL-native Paperclip company/project; company isolation still enforced | Initial qualification scope |
| Human interface | Minimal plugin page and issue detail summary inside Paperclip | Design default; accessibility qualification pending |

### Nominal-first delivery milestone

The owner now prioritizes an 80/20 path to representative end-to-end use. Deliver one supported software-mission profile through contribution, integration, ordinary correction, specialist synthesis and confirmed acceptance, with minimal inspection. Exercise all nine prepared profile types across relevant generic cases and record their usefulness, overlap and observed cost; no compulsory full committee per mission. Bring that narrow real-agent evaluation forward instead of completing all failure and lifecycle variants first. The [sprint plan](SPRINT-PLAN.md) defines N1→N6: N1–N4 remain foundations, N5 completes M1 and N6 demonstrates M2, without widening an already bounded lot.

This is an intermediate milestone within V1. Full release acceptance in §8, the existing mandate and DEC-G3-02/DEC-G4-01 remain in force. A deferred case stops safely and remains visible; automation for its recovery can follow later. A new restriction that prevents representative use or a relaxation of those contracts needs a specific owner decision, not an implicit “80/20” waiver.

The accepted orchestration extension adds **M1**, a complete mission through an identified PR with complementary contributions, integrated validation and a real correction, then **M2**, two active missions sharing a constrained resource or dependency with observed prioritization, waiting and resumption. N1–N4 remain the foundation; N5 completes M1 and N6 demonstrates M2 in the sprint plan. N4 alone closes neither new exit. These additions do not expand an already-bounded implementation lot implicitly.

## 2. Domain vocabulary

| Concept | Meaning and boundary |
| --- | --- |
| Execution team | Named, company-scoped, revisioned roster of agent references and responsibilities, optionally restricted to a project. It owns no separate agent runtime. |
| Council | Revisioned roster of reviewing perspectives, an accountable final reviewer and a bounded decision policy. It is not an extra Paperclip company or a native stage containing several alternative assignees. |
| Mission | Council's governed view of one root Paperclip issue, its mandate, execution plan, pinned rosters and result. |
| Contribution | Bounded work assigned to one agent through a child issue, with dependencies, required output and inspection evidence. |
| Integration lead | The named agent responsible for combining contributions and submitting the coherent result; may also be a contributor. |
| Project coordination | Persistent view of native missions, delegated ordering, shared capacity, dependencies and next actions within one company/project. |
| Mission orchestrator | Accountable execution owner through PR handoff; may hold integration responsibility or name its separate holder. |
| Technical plan | Revisioned contributions, skill assignments, interface/dependency contracts and verification expectations. |
| Facilitation | Bounded intervention on a cooperation problem; it does not transfer dispatch or verdict authority. |
| Review round | Review of one immutable submission and evidence revision against a pinned mandate and selected perspectives. |
| Opinion | An attributed domain judgment; supports the final verdict but does not independently close the root issue. |
| Verdict | Accountable decision: approve or request changes, with rationale, resolved objections and evidence. Owner escalation and insufficient evidence are waiting states, not approvals. |
| Appeal | A bounded review of one unresolved question using identified participants and compared arguments. |
| Acceptance | A verdict whose effect is confirmed on the covered native workflow and whose exact submission remains identified. PR authority is separately pinned in the mandate. |
| PR handoff | Observed PR URL, repository/base, head, accepted submission and evidence, plus actual check/review state and next actor; distinct from merge or deployment. |

Several teams and councils can be configured; each mission selects one execution team and one council. V1 supports several contributors and several reviewing perspectives without requiring every mission to use them. A simple mission may use one executor and one distinct reviewer. Cross-company rosters and autonomous councils that create further councils are excluded.

## 3. Team and council lifecycle — C17–C18

The owner can create a draft roster, select existing agents and their responsibilities, validate prerequisites, activate a revision, revise it, suspend it and retire it. Missing identities, project incompatibility and executor/reviewer conflicts are visible before activation. A roster revision alone neither alters a Paperclip agent's global instructions nor grants it permissions.

Each mission records the roster revisions, integration lead, final reviewer, owner and required review perspectives it uses. Editing a roster affects future missions. Replacing a member in an active mission is an explicit reconfiguration: identify the actor, reason, affected contributions and invalidated opinions; pause affected dispatch while the transition is reconciled. The replacement must be eligible before resuming. Decisions already applied remain attributed to their actual authors.

The final reviewer and counted reviewing specialists must not have authored or integrated the reviewed submission. A contributor may supply factual clarification, but that is not a required independent opinion. If an agent fixes the submission, another eligible reviewer must review the changed result. The plugin cannot infer undisclosed off-platform authorship; recorded provenance and instructions support this boundary.

Suspending a roster rejects new missions using it. Existing missions retain their pinned revision and show the suspension; they continue unless explicitly suspended as well. Suspending a mission stops new dependent dispatch and decision application, accounts for in-flight effects and preserves the next action. Retirement removes a roster from future selection, not from history. Mission cancellation is explicit and never becomes acceptance. No agent, issue or evidence is deleted automatically.

## 4. End-to-end mission

1. **Configure.** The owner selects company/project, team, council, owner escalation destination, covered result/workflow, mandate and operating limits. Validation distinguishes configuration saved from activation ready.
2. **Plan.** The named planner proposes contributions, suitable assignees, shared interfaces, dependencies and integration/QA checks. The orchestrator takes execution responsibility; planning and integration may share a holder on small missions. Scope or authority changes wait for the owner. Independent contributions may run in parallel; dependencies and workspace ownership are explicit.
3. **Execute and integrate.** Paperclip owns agent runs and issue checkout. Completion of child issues is input to integration, never root acceptance. A failed or missing required contribution blocks submission until corrected or explicitly replanned within authority.
4. **Submit.** The lead publishes the integrated Git candidate, manifest, accessible bundle and criterion-linked evidence. The review identifies all contributing agents and the exact content. Changes create a new submission; added evidence creates a new evidence revision.
5. **Review.** The council collects the selected required perspectives on that submission. A missing opinion waits or leads to explicit replacement/escalation. Optional advice does not block forever. No absence is counted as agreement.
6. **Decide.** The final reviewer addresses material objections, respects the mandate, and issues a reasoned verdict. An unsupported majority cannot overcome contradictory evidence. A correction identifies the smallest justified change and sends actionable work back to integration/contributors.
7. **Appeal or ask the owner.** A consequential unresolved question may use the configured one-level appeal. If no eligible participant exists, evidence remains inconclusive or the authority is reserved, the owner receives options, consequences and a recommendation. Silence never approves.
8. **Apply and inspect.** The plugin records the intended effect, applies through the native review route and checks the resulting decision and state. A timeout becomes an uncertain application to reconcile. The owner sees the reviewed result, next actor, pending follow-up and actual effect.
9. **Hand off the PR.** The orchestrator ensures the authorized publisher opens or updates the PR for the accepted candidate and records verified URL/head/evidence. Missing authority or uncertain publication remains a delivery wait. CI/review status is read back separately; a code correction returns to the responsible contribution, integration, affected verification and acceptance before publishing the revised accepted candidate. No merge/deployment follows from this handoff.

Appeal participants issue a resolution or recommendation; the originally accountable final reviewer remains responsible for applying the verdict in V1. It must incorporate the resolution within the mandate or explain an unresolved blocker and escalate. No appeal participant silently acquires root closure rights.

### Project coordination and facilitation

The Project Manager coordinates native mission references within delegated priorities and commitments. It records ordering, dependency evidence, finite shared capacity and wait/release decisions; mission orchestrators dispatch only when those conditions and mission admission permit it. Replacement or restart retrieves the same project state. A task's `done` status alone does not satisfy an integration or acceptance dependency.

The facilitator is invoked for a stalled handoff, responsibility conflict or consequential disagreement. It receives a bounded question, relevant participants and expected outcome, then records a resolution, clarified next actor or escalation. It can facilitate a council but cannot accept code, override priorities or redefine a mandate. No model call or recurring meeting is required merely because the role exists.

Roles may be combined when useful; each mission identifies its orchestrator, planner, integration owner and independent final reviewer. Frontend/backend execution, architecture design, specialized QA and independent opinions remain distinct responsibilities even if some share identities where authorship rules allow it.

## 5. Operational state versus deferred memory

V1 retains the current mission's mandate, assignments, roster revisions, submission revisions, opinions, appeal, owner responses, application attempts, follow-up and measurements. Another eligible agent can resume that same mission from persisted records. Prior rounds remain inspectable; a new result does not inherit approval automatically.

V1 also retains operational project coordination: native mission references, ordering, resource claims, dependency/wait decisions, coordinator identity and facilitation outcomes. This is current work state under C21, not learned knowledge under C12–C15. Durable responsibility does not require a continuously running agent.

V1 does not extract reusable lessons, adopt knowledge items, build role/project retrieval, transfer experience to new missions, score learning benefit, auto-tune instructions or maintain a knowledge steward. C12's knowledge continuity and C13–C15 remain deferred. A simple link to an earlier issue is not a learning feature. No vector store, embedding service or separate memory engine is required by this scope.

## 6. Authority, limits and stopping

The [owner mandate](PRD.md#63-initial-delegation-profile), including the explicitly approved DEC-G4-01 policy, applies: protected essential uses, affected-group p95 strictly below 30 seconds for delegated degradations, owner decisions for infrastructure cost changes in either direction, and both task and period spending limits. The mandate's majority refers to usage, not votes. The TAD defines guard records without pretending that prompts prove product facts.

Activation requires explicit task/period budget policy, review/correction limits, appeal limit, elapsed-time limits, owner destination and available measurement sources. This document invents no monetary envelope. Missing decisive cost or impact information produces bounded investigation or owner waiting; unknown is never zero. Native agent budgets alone do not establish an aggregate Council mission budget. V1 requires atomic admission reservations and mandatory operational limits, but does not promise an absolute monetary ceiling on already-committed work. Unknown remaining exposure blocks new launches. The [G3/G4 decisions](G3-G4-DECISIONS.md) require plugin-private receipts and persistent uncertainty handling and adopt this budget policy; neither is runtime qualification.

The authority claim covers Council-managed coordination, submissions, reviews and decisions for selected issues, plus the separately authorized and qualified PR path under C23. Administrative overrides, direct platform mutations and external merge/deployment paths remain outside that guarantee. If policy or native ownership drifts, affected work waits for reconciliation. PR mandate, repository/base, publisher and operations must be explicit before publication; this document authorizes no live action.

## 7. Minimal inspection experience — C07–C09

The owner needs a team/council configuration page and a mission view linked from the native issue. The view shows mandate and limits, pinned composition, contributions and dependencies, result/evidence identity, required and received opinions, objections, appeal, verdict, confirmed native effect, owner waiting, usage gaps and next action.

Add a compact project view using native issue links: active/queued missions, priority rationale, shared-capacity/dependency waits and next actor. The mission view includes plan revision, skill/QA responsibilities, facilitation outcome and PR URL/head/check/review state. Distinguish accepted from PR pending/unknown/opened and ready for review. Existing accessibility and narrow-window criteria apply; no second backlog UI is required.

Commands include validate/activate, revise/retire a roster, enable supervision, explicitly reconfigure a mission, suspend/resume/cancel, and request reconciliation. Owner-reserved decisions use the attributable native human interaction. Agent commands use authenticated routes, not browser controls that claim an agent identity.

Required states include loading, empty/unconfigured, invalid setup, active work, missing evidence, waiting for a member, correction, appeal, waiting for owner, applying, uncertain application, accepted, suspended, cancelled and failed. Errors explain who can act and what is preserved. Controls are keyboard usable, focus is managed after actions, status does not rely on color, and evidence links have meaningful labels. Reuse Paperclip components and tokens; no separate design system. Start with English labels consistent with this repository and Paperclip, use layouts that reflow on narrow windows, and defer additional translations or a mobile-specific application. These are design defaults, not tested UX claims.

## 8. Release acceptance and activation inputs

V1 requires the selected PRD scenarios A01–A11, A17–A30, plus the operational portion of A16. A12–A15 and learning attribution in A16 are deferred. Demonstrations include M1 and M2, at least two distinct relevant review perspectives, correction and re-review, one bounded disagreement/appeal, proportionate facilitation, owner waiting, roster replacement and restart recovery. Simple two-agent success is insufficient.

Deterministic tests cover state, authorization and concurrency. A real authenticated Paperclip instance covers persistence, plugin lifecycle, attribution and effects. Representative real-agent work covers reasoning, coordination and usability claims. These layers cannot substitute for one another. The qualification records failures, manual interventions and missing measurements alongside successes.

Inputs still needed before live activation: concrete instance/company/project, owner user identity, eligible agent roster and actual tools/authentication, budget and time limits, representative repository/task and evidence location. These do not prevent document or bounded code work. The TAD separately lists technical feasibility gates that can change implementation choices.

For M1/M2 also select project priority delegation, finite shared-resource capacity, the dependent evidence contract and PR repository/base/publisher authority. Newly described responsibilities are not installed profiles or qualified host integrations.
