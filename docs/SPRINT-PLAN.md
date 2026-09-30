# Paperclip Council — V1 sprint plan after L0

Version 0.2 — September 30, 2026. Documentary plan, not a running sprint or delivery-date commitment.

Sources: [product backlog](BACKLOG.md), [PRD 0.4](PRD.md), [V1 scope](V1-SCOPE.md), [TAD D01–D10](TAD.md), [technical lots](IMPLEMENTATION-PLAN.md). PRD §6.3 incorporates owner-approved DEC-G4-01; other mandate protections remain unchanged. Every technical ticket below names a backlog parent; implementation details do not become new product requirements.

## 1. Baseline and entry status

This section preserves the original pre-Sprint-1 planning baseline. Use the candidate-specific reports under `docs/reviews/` for delivered increments; §2 below records the later owner decisions, not a fresh runtime PASS.

Published documentary base: `4cf7127880f4847a46cf1fdefa5acd5de5593206` on `origin/main`, verified September 30. L0 is a **local, separately reviewed candidate**, not merged into that base:

- Implementation: `939c49ad4b170652f4b1adc1f85c87a8a7ab5082`.
- Runtime-tested candidate: `7fcf5c7716c71905b60b2fbe2ac89955353a334a`.
- Final report revision: `a2b9be7dc76d3edcec702f8d14fd7d84ca3cc86c`, branch `codex/council-l0`.
- Host: Paperclip `61b3fd57a695614dc4a37e2303f426a34a9795cf`; SDK/shared `2026.916.1`.
- Evidence sources at the report revision: `docs/reviews/l0/REPORT.md` and `docs/reviews/l0/proof-manifest.json`; runtime trace `artifacts/functional.json` is local and Git-ignored. Retrieve the reports with `git show a2b9be7dc76d3edcec702f8d14fd7d84ca3cc86c:docs/reviews/l0/REPORT.md` and the analogous manifest path. These local commits/trace are not promised to exist in a fresh clone; obtain them before relying on the evidence.

This pass read the report and manifest; it did not rerun L0 or requalify its runtime. L0 reports build/typecheck, 30 tests, real migration and competing CAS, narrow bundle-byte verification and addressed-human mechanics passing. Its overall verdict remains **PARTIAL / keep-open**. G1's UI/job surfaces were inspected, not executed; G3/G4 are not globally green.

**Sprint 1 is ready to prepare, with an entry condition:** select a reviewed implementation base containing the L0 code/evidence and preserve its exact-candidate checks. An authorized integration of that candidate, or an explicit continuation from it, must be recorded before coding. Do not cherry-pick an older adapter or copy code from a stale worktree. This plan does not itself merge L0. A full G3/G4 PASS is not needed for the configuration-only slice of L1.

## 2. Decisions and blocked capabilities

| ID / backlog parent | Current fact and boundary | Smallest next action / exit | Needed before |
| --- | --- | --- | --- |
| DEP-G3 / B03, B08 | The pinned host has no supported canonical readback of native decision actor/run/body/effect after an uncertain response. Ordinary native flow passing does not establish safe reconciliation | DEC-G3-01 authorizes a bounded qualification/implementation lot: inspect existing supported reads first; if insufficient, add the minimum company-scoped host readback and necessary SDK exposure. Qualify uncertain-response replay before recovery. Keep host edits isolated from L2; no blind PATCH retry or direct-DB substitute | L3's applied-decision reconciliation; not L1 |
| DEP-G4 / B04 | DEC-G4-01 adopts prudent monetary admission control and mandatory operational limits; the selected contract remains technically unqualified | Qualify atomic task/period reservations, concurrency/retry bounds, settlement/restart and blocking on unknown available budget or exposure. Keep affected activation/dispatch disabled until proven. Already-committed work may overrun; no absolute monetary ceiling is promised. Do not build a new scheduler or billing subsystem | L2 dispatch under the required limit policy |
| DEP-OWNER / B04 | The probe proves an addressed fixture human responded; it does not prove contractual owner identity or mandate/submission binding | In L3, resolve the persisted configured owner, bind the question to exact revisions, verify native responder and reject stale/system/other responses. Test no-response waiting and attributable continuation. This is planned business implementation, not a reason to expand L0 | L3 owner-bound continuation |

Default disposition: enforce the revised PRD mandate and leave affected actions blocked until qualified. The [September 30 owner decisions](G3-G4-DECISIONS.md) adopt the G4 policy and authorize a minimal G3 host readback change if needed; no budget amounts, live activation or wider host work are authorized. G3 and G4 technical qualification may proceed independently in isolated worktrees; G4 gates L2 dispatch, G3 gates L3 decision recovery. One bounded qualification conclusion is sufficient; reopen only on new evidence or a changed contract.

## 3. Sprint 1 — owner configuration (slice of L1)

**Goal:** the owner can create and manage a team/council composition in the plugin, see its current revision and prerequisites, and understand that mission dispatch is not yet available. This delivers the configuration slice of B01; active-mission reconfiguration and complete V1 activation remain later work.

**Capacity assumption:** one implementation worker at a time, with one consolidated independent review. Three coherent tickets/PR units below; adjacent units may share a PR if needed for a runnable increment. No dates, story-point estimates or fixed duration without capacity evidence. Stop at the observable configuration journey rather than drawing more work into the sprint.

### S1-01 — persist revisioned rosters

- **Backlog parent:** B01. **TAD:** D02–D03; §3 roster publication. **Dependency:** Sprint 1 entry base and G1 persistence proof.
- **Outcome / component:** minimal roster domain/store and host namespace migration for team/council revisions and lifecycle heads. Preserve published content; publish by inserting an immutable revision then CAS-updating its head. Keep company/project scope and responsibility references. An unreferenced revision after interruption is acceptable; a published head pointing at missing content is not.
- **Boundaries:** implement only roster storage needed by L1. No mission aggregate, budget engine, generic repository abstraction, event framework or operational cleanup service. Preserve applied L0 migration checksums if retained in the selected base.
- **Acceptance / validation:** real bridge create/read/revise; two competing head updates yield one winner and one conflict; old published content is unchanged; another company cannot read/write it. Verify the interruption boundary without building a general fault-injection framework. Domain tests cover meaningful lifecycle rules.
- **PR unit:** roster persistence, migration and its focused checks together.

### S1-02 — expose authenticated configuration and lifecycle commands

- **Backlog parent:** B01; prerequisites for B04/B08, not their completion. **TAD:** D02–D03, D07, D09; §§3, 9. **Dependency:** S1-01.
- **Outcome / component:** owner-authorized roster routes/services using existing Paperclip agents. Support draft, validation, activation, revision, suspension and retirement; expose active revision, responsibilities and actionable prerequisite errors. Resolve the configured company owner from authoritative configuration, not a request-supplied identity. Roster edits never rewrite agent instructions or credentials.
- **Acceptance / validation:** reject foreign-company, unavailable/ineligible or project-incompatible selections; validate a proposed team/council pairing for integration/final-reviewer responsibilities and recorded self-review conflicts. Only the configured owner mutates; unauthorized or stale-version commands change nothing. Retired/suspended rosters cannot be selected for new use; historical revisions remain readable. Agent availability must still be rechecked in later dispatch code.
- **Activation boundary:** roster activation validates composition; it is not mission activation. Report owner destination, native review path, mandate/limits and unsupported runtime guarantees as distinct mission prerequisites. Do not expose enable/dispatch controls that bypass G3/G4. No mission row, owner-response workflow or agent run is needed to demonstrate this ticket.
- **Validation:** authenticated API lifecycle on the isolated real host, including wrong actor/company and version conflict; fixture identities are declared. A service mock alone is insufficient for route/company/owner claims.
- **PR unit:** routes, eligibility/lifecycle guards and scoped integration checks.

### S1-03 — deliver the minimal configuration surface and close the increment

- **Backlog parent:** B01; configuration inspection contributes to B07. **TAD:** D01, D09–D10; §§9–10. **Dependency:** S1-02; qualify the G1 UI contract while implementing this surface because L0 only inspected it.
- **Outcome / component:** one Paperclip plugin configuration page for choosing existing agents, inspecting/editing rosters and performing the lifecycle actions. Reuse host components/tokens. Clearly distinguish saved configuration, eligible roster and mission prerequisites still pending.
- **Acceptance / validation:** demonstrate create → validate/activate → revise → suspend/retire with historical revision still inspectable. Cover empty/loading/error/unauthorized/stale-version states; keyboard access, focus/error feedback and non-color statuses. English first per TAD. Verify page load and authenticated actions through the actual installed plugin; record manual versus automated checks and any remaining limitation.
- **Completion boundary:** no full mission dashboard, specialist-review interface, design-system extraction or generic UI testing framework. A historical revision read proves storage immutability; it does not prove A18 active-mission pinning, which awaits L2/L5.
- **PR unit:** configuration page and necessary UI wiring, focused journey validation and concise evidence. One final independent review covers the integrated Sprint 1 change; do not commission separate repeated reviews for each cosmetic detail.

## 4. Sprint 1 exit and stopping rules

Sprint 1 closes only when the installed plugin configuration journey works, its persistence/authorization checks pass and the consolidated review has no unresolved material finding. Record exact base/candidate/host, changed behavior and checks. Run existing build/typecheck/tests plus the affected actual-host journey; broaden only for a changed surface, failure or unresolved concern.

Use separate statuses: **configuration increment done**, **L1 still partial pending active-mission revision proof**, **L0 G3/G4 still partial**, **mission activation unavailable**, **V1 incomplete**. The original L1 exit includes active-mission pinning: close that criterion with the first L2 persisted mission, then exercise explicit reconfiguration in L5. Completing this sprint does not close all of L1. A blocked UI bridge means partial Sprint 1, not an API-only substitute silently called done. No provider/model execution is required for configuration qualification. Do not mutate the durable council-local instance to demonstrate this increment.

Once these checks pass, stop. Defer cosmetic polish, generic abstractions, hypothetical scale, broad compatibility and further fault campaigns unless a concrete acceptance failure justifies them. Preserve unresolved required proof rather than relabeling it as optional hardening.

## 5. Later increments — outline only

| Increment / technical lot | Selected backlog outcomes | Entry condition and exit |
| --- | --- | --- |
| S2 / L2 | B02; B04 limit enforcement and B08 dispatch recovery slices; minimal B07 mission state | B01 configuration exists; demonstrate the remaining L1 active-mission pinning criterion when persisting the first mission; resolve DEP-G4 before affected dispatch. Exit: two contributions feed one integrated candidate; failed integration blocks review; duplicate/uncertain creation is reconciled conservatively |
| S3 / L3 | B03 and remaining B04 owner path; B08 application recovery; decision/owner inspection from B07 | Integrated result plus DEP-G3 and DEP-OWNER qualification. Exit: correction → new submission → confirmed acceptance, stale result refused, owner silence waits, uncertain application cannot create false acceptance |
| S4 / L4 | B05, B06; related B07/B08 behavior | Single-reviewer path works within the mandate. Exit: relevant independent opinions, absence handling, evidence-led synthesis and one bounded appeal; no recursive councils |
| S5 / L5 | Complete B07/B08 and remaining B01/B02 lifecycle coverage | Dispatch/application recovery already exists. Exit: whole-mission inspection, explicit replacement, suspension/cancellation accounting, restart and usage gaps; do not defer foundational recovery to this increment |
| Qualification / L6 | Integrated B01–B08 | Selected actual owner, instance, eligible agents, limits and representative requests; separate runtime authorization. Exit: representative real-agent team/council journeys and applicable V1 scenarios, with intervention and consumption limits reported |

These are sequencing envelopes, not detailed committed sprints. Slice the next one only after the preceding result and relevant dependency decisions are known. No calendar or automatic continuation is implied.

## 6. Ready for the next implementation task

The next bounded implementation request should target **Sprint 1 / S1-01–S1-03 only**, name the selected L0-containing base and exact worktree, use the [backlog](BACKLOG.md) and TAD as authorities, and retain the stop condition above. Concrete live agents, budgets and owner-account setup are activation inputs, not values to invent during this documentary pass.

This document creates no external tickets and launches no implementation, provider run, publication, merge or deployment. G3/G4 follow-up is conditional scoped work; an unresolved guarantee does not authorize expanding L0 or this configuration sprint.
