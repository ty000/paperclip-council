# Paperclip Council — nominal-first sprint plan

Version 0.4 — September 30, 2026. Documentary execution plan; no dates, capacity, runtime activation or passed qualification are implied.

Sources: [backlog B01–B11](BACKLOG.md), [PRD 0.5](PRD.md), [V1 scope](V1-SCOPE.md), [TAD D01–D14](TAD.md), [technical coverage L0–L8](IMPLEMENTATION-PLAN.md), [G3/G4 decisions](G3-G4-DECISIONS.md), and [prepared agent profiles](AGENT-CATALOG.md).

## 1. Baseline and entry status

Inspected main: `cbe8e54ffa4e3c857424b44518b75d38de45d28b`. Configuration (PR #6), draft-mission persistence (PR #8), fast CI (PR #7), qualification infrastructure (PR #9), G3/G4 decisions (PR #10) and nine documentary agent profiles (PR #11) are merged. Historical reports under `docs/reviews/` keep their original candidate identities and limits. The earlier pre-Sprint-1 plan is retained in Git at this baseline; it is not the current work queue.

Delivered is not operationally complete: L1 active-mission pinning and L2 dispatch/integration remain open; G3/G4 technical qualification remains open; profiles are not configured or running agents. The pre-L3 infrastructure did not complete L2. No historical runtime replay proves this planning revision or future candidates.

**Owner direction:** prioritize a generic end-to-end path, collect concrete exceptions during implementation, and schedule subsequent hardening/decision work. Also maximize the diversity of agent types exercised so their usefulness can be assessed during those generic missions. N1→N6 supersedes the old sequential sprint outline for execution: N1–N4 remain foundations, N5 completes M1 and N6 demonstrates M2, without widening already bounded lots or deleting full-V1 acceptance criteria.

The nominal milestone is an early, narrow L6-style evaluation. Full L6/V1 closure still requires the remaining mandatory cases; report these two milestones separately.

PRD 0.5 extends the selected scope with M1 (complete mission through PR) and M2 (two coordinated missions). This revision was framed on `46669b3b77f760b0f481bb927d3ff3f53bf9b42c`, including the merged nominal plan. Preserve N1–N4 as foundations; N5 completes M1 and N6 demonstrates M2. Existing bounded implementation work is not silently widened. Nine prepared profiles remain the N4 coverage target; the new responsibilities require preparation and evaluation in their own lots.

## 2. Decisions and blocked capabilities

| Dependency / parents | Required in the nominal path | Later coverage and stop boundary |
| --- | --- | --- |
| G4 / B04 | N1 qualifies admission for the explicitly supported operating profile: atomic task/period reservations, bounded concurrency/retries, known allowance/exposure and durable unsettled usage. Test competing admissions and settlement/restart through the supported runtime | Broader throughput/profiles can follow. Unknown allowance/exposure still blocks launches; estimates are not an absolute monetary ceiling. Serialization alone is not a budget contract |
| G3 / B03, B08 | N2 must prove the actual native actor/result/effect for ordinary success. Implement any supported read needed for that claim. Persist intent and preserve unknown effects; no blind retry or false acceptance | Dedicated lost-response/restart reconciliation can follow in F01 where the nominal profile stops safely. G3 stays OPEN until its required proof passes |
| DEP-OWNER / B04 | Enforce the existing configured owner and mandate. A reserved decision stops dependent work with a precise question and next actor | Bound owner-response verification and attributable continuation are F02. No response, another responder or a stale answer cannot resume work |
| Runtime inputs / B01, B04 | Select supported host, instance/company/project, eligible agents, native auth, tools, skill mounts, operating amounts/periods and measurement sources before real runs | Missing inputs block affected activation, not unrelated bounded code. This plan supplies no credentials, amounts or live-run authorization |

The 80/20 choice changes ordering and operating scope, not DEC-G3-01/DEC-G4-01 or owner-reserved authority. If a required nominal guarantee cannot be implemented proportionately, record the exact conflict for an owner decision. Do not invent a cheaper policy, simulate a PASS or start a new scheduler/billing platform.

## 3. Nominal delivery lots

Six coherent delivery lots, each split into one or a few reviewable PRs where useful. Preserve existing implementation and tests. Each lot includes its useful inspection slice and ends at an observable result. Narrow setup assumptions must be enforced and visible, not promises in a prompt.

### N1 — Two contributors deliver one integrated candidate

- **Parents:** B01, B02, B04; initial B07/B08. **TAD:** D02–D04, D07–D10. **Coverage:** L1 remainder and nominal L2.
- **Entry:** current main, existing roster/draft persistence, selected supported host/SDK contract. G4 work belongs in this lot before any affected launch, not in an open-ended preliminary programme.
- **Implement:** mission activation, pinned revisions, minimal contribution plan and native child mapping, one integration lead, persisted effect/command identity and admission. Use two contributors with explicit write ownership; a simple ordered plan and bounded parallelism suffice. Do not build a generic graph scheduler.
- **Inspect:** mission state, participants, contribution state, integrated candidate/evidence, usage/reservations or unknowns, blocker and next actor.
- **Validate:** supported installed plugin path produces two contributions and one integrated result; failed integration prevents submission. Active mission keeps its pinned revisions. Reject wrong actor/company and conflicting/duplicate commands. Prove the selected G4 contract, including competing admission and restart with unsettled usage; uncertain child creation stops instead of dispatching twice.
- **Exit:** an identified, checked candidate can enter review. Fixture actors prove transitions only; real-agent contribution quality is evaluated in N4.
- **Defer:** arbitrary graphs, automatic reassignment, concurrent mission throughput and a complete operations dashboard. Basic preservation and safe stopping are included.

### N2 — Ordinary correction and confirmed acceptance

- **Parents:** B03, B04; B07/B08 slices. **TAD:** D04–D08, D10. **Coverage:** nominal L3.
- **Entry:** N1 candidate and eligible final reviewer distinct from recorded authors/integrator.
- **Implement:** native review handoff, immutable submission/evidence binding, applicable G2 bundle/content verification, one ordinary correction/resubmission, persisted verdict/application intent and confirmed native effect. Reuse the existing decision adapter where its contract suffices.
- **Inspect:** candidate under review, correction requested, formulated verdict, applied decision/effect, uncertainty and next actor.
- **Validate:** correction → changed candidate → new review → confirmed acceptance. Wrong actor, stale bytes, failed application and unknown outcome cannot pass. Stop a duplicate wake/uncertain effect without a second mutation. Ordinary success must have supported native evidence; use the minimum G3 read necessary if the response/current supported reads are insufficient.
- **Exit:** one accountable reviewer can correct and accept this supported path. A reserved owner question or ambiguous effect remains durably waiting/unknown.
- **Defer:** general interruption-recovery automation and bound owner-answer continuation (F01/F02), without claiming full L3 closure.

### N3 — Relevant specialist opinions inform the verdict

- **Parents:** B05; B03/B04 and B07/B08 slices. **TAD:** D02, D05–D07, D09–D10. **Coverage:** nominal L4.
- **Entry:** N2 exact-candidate review and prepared profile catalogue.
- **Implement:** native specialist work and attributed opinion slots for any selected prepared reviewer profile; original opinions and material objections remain visible. One Generalist Reviewer owns synthesis and the root verdict. Select required perspectives before the round; no automatic relevance router or new role-specific runtime engine.
- **Validate:** at least two distinct relevant perspectives on the same candidate; a required missing opinion cannot count as agreement. Show the reasoned disposition of an objection and refusal of author/reviewer conflicts. A changed candidate invalidates affected opinions. An unresolved dispute stops with the next actor rather than spawning recursive councils.
- **Exit:** the common machinery supports all seven specialist profile types; a mission can request more than two when it has concrete questions for them. Availability is checked rather than assumed from the catalogue.
- **Defer:** formal one-level appeal, replacement/late-opinion automation and sophisticated selection policies (F02/F03). Appeal remains required for full V1.

### N4 — Representative real-agent use and profile evaluation

- **Parents:** integrated nominal slices of B01–B05, B07/B08. **TAD:** D01–D10 within this operating profile. **Coverage:** early narrow L6, not full L6 closure.
- **Entry:** N1–N3 working through the selected installed runtime; actual authorized owner, identities, auth, mounts, tools and qualified operating envelope. Prepare eligible identities using existing Paperclip setup and profiles; do not build automatic provisioning. Configuration, activation and execution are separately recorded.
- **Run:** a small campaign of generic software missions following the matrix below. Include two contributors and an integration lead, distinct final reviewer, specialist opinions, at least one ordinary correction, confirmed acceptance and readable mission inspection. Exercise stop-on-unknown/mandate boundaries with focused deterministic checks; do not fabricate an exception in each real-agent mission.
- **Validate:** persisted actor/run/candidate/opinion/effect evidence, actual integrated result quality, distinct substantive perspectives, observed interventions, elapsed time and available usage with unknowns visible. Fixture-only success cannot close this lot. Record the provenance of a naturally occurring correction or a deliberately selected correction exercise.
- **Exit:** nominal journey demonstrated; all nine profile types evaluated on a concrete relevant question at least once. A profile not exercised is explicitly NOT EVALUATED and keeps profile coverage partial; do not claim its relevance from its title, output volume or an empty opinion. End-to-end success and breadth of profile evaluation have separate reported statuses.
- **Defer:** exhaustive failure combinations and universal model/profile comparisons. Capture concrete discoveries for the decision checkpoint instead of repeatedly expanding N4.

### N5 — Planned multidisciplinary mission through its PR (M1)

- **Parents:** B02, B11; B03/B04/B07/B08 and selected B05. **TAD:** D04–D06, D08–D11, D14. **Coverage:** explicit planning/skills in L2 plus L7; PRD C19–C20/C23, A23–A24/A28–A30.
- **Entry:** N1–N4 foundation/evidence within the selected operating profile. Verify the narrow publisher API/tool, authenticated actor, repository/base permissions, PR readback and native post-acceptance correction route before dependent implementation/publication. Missing host support is a named dependency, not an inferred API.
- **Implement:** revisioned technical plan and named planner/orchestrator/integrator; skill and interface routing; QA expectations during planning; guarded replan and correction handoffs. Prepare missing responsibility instructions using existing agents without automatic hiring. Add one persisted authorized PR effect and actual PR/check/review observations; reuse an existing delivery path if it satisfies D14, with one dispatch owner.
- **Inspect:** plan revision, assignments, dependencies, integration/QA evidence, accepted candidate, publisher authority, PR URL/head and actual check/review state. Preserve separate accepted/waiting/unknown/opened/ready observations and the next correction actor.
- **Validate:** a representative frontend/backend or equivalent complementary mission follows plan → contributions → integrated validation → real correction → acceptance → observed PR. Verify missing authority causes no publication, mismatched head does not pass, timeout does not create a second PR, and code changes requested by CI/review receive affected revalidation and independent acceptance. Label intentionally selected correction exercises. Domain tests do not prove provider effects.
- **Exit:** M1 is demonstrated on the authorized target; record exact candidate/PR, evidence and actual readiness. A PR can be opened with pending checks, but neither pending/failed checks nor draft status may be reported as ready. M1 does not imply merge/deployment or M2.
- **PR slices:** planning/responsibility and validation handoff; authorized PR effect/readback and minimal view; focused qualification/evidence. Combine when coherent; no unrelated provider framework or CI redesign.

### N6 — Durable project coordination and useful facilitation (M2)

- **Parents:** B09, B10; B02/B04/B07/B08/B11. **TAD:** D02–D04, D07–D13 and D14 for each PR handoff. **Coverage:** L8, PRD C21–C22, A25–A27.
- **Entry:** M1, two scoped native missions in one configured company/project, explicit priority delegation, finite shared-capacity rules and dependency evidence. Prepare suitable Project Manager/facilitator instructions and identities; availability is checked before execution.
- **Implement:** durable native-mission references, ordering rationale, capacity claims, dependency/wait state and coordinator handoff; each mission retains one execution orchestrator. Qualify atomic claims and conservative reconciliation before concurrent use. Add bounded facilitation on a concrete blocker with question, participants, outcome and next actor. Reuse native events/wakeups; no constantly polling model or new general scheduler.
- **Inspect:** compact project view with queued/active/waiting missions, capacity/dependency reason, decisions, next actor and linked mission/PR states; existing accessibility criteria apply.
- **Validate:** two real missions contend for a resource or depend on a required result. Observe a delegated ordering decision, blocked dispatch, verified release/prerequisite and resumed progress through the PR workflow. Deterministic/runtime cases additionally cover competing exclusive claims, dependency cycle/false completion, crash between project claim and mission dispatch, coordinator restart/replacement and reserved priority change. Evaluate one concrete facilitation outcome without inventing mandatory ceremonies.
- **Exit:** M2 demonstrates coordination rather than independent concurrent successes; responsibility, waiting, resumption, budget effects and facilitation evidence are durable and inspectable. Report PM/facilitator usefulness separately from runtime transition checks.
- **PR slices:** coordination state/admission and mission handoff; minimal view plus bounded facilitation instructions/path; representative qualification/evidence. Arbitrary cross-project scheduling and throughput tuning remain outside this lot.

## 4. Breadth of agent evaluation

Target **nine profile types**: Executor, Generalist Reviewer and the seven specialist reviewers. This is coverage across the campaign, not nine mandatory participants per mission or nine automatically hired identities. Two distinct Executor identities are needed for the integrated-work proof. Required specialist opinions use eligible attributed identities distinct from the authors/integrator; a generalist adopting several tones is not specialist coverage.

| Generic case | Concrete result and questions | Perspectives to exercise |
| --- | --- | --- |
| A — small user-facing software change | A working screen/flow plus its service contract: usefulness, implementation, boundaries, interaction/accessibility and behavioral evidence | Executor(s), Generalist, Development, Architecture, UX & Accessibility, Product, Quality |
| B — configuration/access change in the same product | A bounded settings or permission flow: who may change it, how it fails, how it is observed and recovered operationally | Executor(s), Generalist, Security, Operations; repeat Development/Quality or other specialists where the question warrants it |

These are campaign templates, not invented requirements for the target application. Choose real representative tasks; combine or adjust cases when relevance is preserved. Architecture reviews an actual boundary, not an imaginary future scale; Security reviews a stated asset/permission boundary; Operations reviews an actual configuration/runtime concern. If a required perspective has no meaningful question, choose a more representative task or report the coverage gap rather than manufacture work.

All selected perspectives remain under the same mission allowance, correction limit and elapsed bound. More types does not require more concurrent runs: bounded/sequential solicitation is acceptable. Keep profile/model/effort revisions visible so changes between runs are not mistaken for evidence about the same setup.

Use one compact row per participation: case, profile/identity/run, question, candidate revision, useful finding and evidence, final disposition or correction triggered, overlap with other reviewers, elapsed time, observed usage/unknowns and next recommendation (`retain`, `adjust`, `conditional`, `not evaluated`). Retain non-blocking confirmations when they establish a requested property; count neither verbosity nor number of objections as quality. This is an initial qualitative signal, not a causal benchmark or learning/memory system.

## 5. Discovery register and follow-up lots

During implementation, add a row only for an observed issue, a concrete unimplemented requirement, or a consequential decision. Record: ID, source case/candidate/evidence, user impact, current safe behavior, minimal next action, parent requirement, destination and revisit trigger. Reuse IDs for the same cause; do not generate one ticket per theoretical edge case.

A finding blocks the current nominal lot only if it prevents its journey, violates an existing mandate, loses/corrupts owned state, duplicates an effect, launches without valid admission, exposes unauthorized data or produces false acceptance/proof. Correct the smallest sufficient cause. Everything else goes to a reasoned follow-up; an uncertain effect stops instead of becoming a new recovery framework in the same lot.

| ID / status | Source and impact | Current boundary / next action | Destination and trigger |
| --- | --- | --- | --- |
| F01 — required, deferred after nominal proof | B03/B08, G3, full L3/L5: lost response or restart can prevent automatic decision reconciliation | Preserve intent/unknown; no blind retry. Qualify minimal supported readback and attributable recovery | Recovery lot, after N4; pull forward only what N2 needs for truthful ordinary acceptance |
| F02 — required, deferred after nominal proof | B04/B06, DEP-OWNER, full L3/L4: disputed or reserved decisions cannot yet complete automatically | Stop with owner destination; implement bound response verification and one-level appeal | Decision/appeal lot, after N4 or if representative use repeatedly stops here |
| F03 — required, deferred after nominal proof | B01/B05/B08, full L4/L5: replacement, late opinions and in-flight lifecycle changes | Preserve history and stop new dependent work; complete explicit replacement, resumption and lifecycle inspection | Lifecycle lot, after N4 or observed need; retain G4 unsettled-usage safety in N1 |
| F04 — optional breadth, deferred | Arbitrary graphs, throughput beyond M2, automatic reviewer selection, additional runtimes | Use the selected simple plan and configured roster; retain isolation/admission. Required two-mission coordination belongs to N6, not this optional item | Only with observed demand and a separate value/effort decision |
| F05 — evaluation-driven, pending N4 observations | Nine profiles may overlap, miss important questions or consume disproportionate time | No profile declared useful merely because it ran; use participation records | Post-N4 decision checkpoint chooses retain/adjust/conditional and any bounded profile edits |

No new defects are claimed by these seeded coverage gaps. Every discovered defect needs evidence; every mandatory V1 gap retains its requirement even if inconvenient. Cosmetic work, hypothetical hostile local races and speculative generalization are not release blockers unless they violate the actual supported contract.

After N4, hold **one decision checkpoint**: inspect value, blockers and profile usefulness; sequence N5 → N6 and coherent F01–F03 completion lots. Pull forward a follow-up only when needed by the selected journey or its guarantees; for example, N5's post-acceptance correction requires its own supported native continuation. Retain required V1 coverage or obtain an explicit scoped release decision. Full L6 qualification follows required L7/L8 and the remaining coverage. Do not predetermine an exhaustive hardening backlog before using the nominal path.

## 6. Execution and validation rules

- Select N1 next under its existing bounded scope. N1 → N2 → N3 → N4 → N5 → N6 follows functional dependencies; M1 precedes M2. Independent contract inspection and preparation of runtime inputs can overlap; use separate write ownership, not concurrent edits to the same implementation.
- Keep changed-surface tests with each increment. Run independent typecheck, tests and build in parallel using the existing CI runner; target at most four minutes of CI per push. Keep heavier selected-runtime qualification explicit and bounded, outside the default push loop. Tests needed to prove a current guarantee cannot be removed just to meet timing.
- One consolidated independent review of a coherent candidate; fix material findings, then recheck affected paths. Reopen the whole review only for a changed contract or consequential new evidence. Cosmetic preferences and unused correction budget do not justify another cycle.
- Preserve still-valid evidence with its candidate identity and scope; do not promote old runtime results to a changed candidate. Describe implemented, configured, activated and exercised states separately.
- Stop each lot at its stated observable exit. Document open cases, next actor and limits. Do not close an entire L-lot or V1 from one nominal slice.

This plan edits documents only. It does not launch implementation, provision/activate agents, choose money limits, call providers, publish external tickets or authorize a merge/deployment.
