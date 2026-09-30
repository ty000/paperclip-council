# Paperclip Council — V1 product backlog

Version 0.3 — September 30, 2026. Nominal-first delivery order; no item is declared implemented or qualified by this document.

Product authority: [PRD 0.4](PRD.md), especially §6.3 and C01–C11, C16–C18; [V1 scope](V1-SCOPE.md). Architecture: [TAD](TAD.md). Technical lots: [implementation plan](IMPLEMENTATION-PLAN.md). Selected work and technical dependencies: [sprint plan](SPRINT-PLAN.md).

## 1. Release and priority

Every item below belongs to the **selected first usable release V1**. H1/H2 remain roadmap horizons, and L0–L6 remain technical delivery lots, not additional product releases. Team configuration and the single-reviewer journey are useful intermediate demonstrations; neither closes V1. Required V1 scope is not reduced because a host contract is missing.

The configuration slice and draft-mission persistence are already delivered; their reports retain their exact proof limits. The owner's current 80/20 direction selects a **nominal end-to-end milestone**: integrated team work, ordinary correction/acceptance, relevant specialist opinions and a representative real-agent campaign covering all nine prepared profile types on relevant questions. Build these slices across B01–B08 before completing every variant of an individual item. Inspection and safe stopping accompany each slice.

This milestone brings a narrow L6-style evaluation forward. It does not declare full L6 or V1 complete, remove required acceptance criteria, or reinterpret accepted G3/G4 policy. Complete remaining V1 cases in explicit follow-up lots; reconsider scope only through a recorded owner decision. The [sprint plan](SPRINT-PLAN.md) owns the new execution order N1–N4 and the follow-up register.

The dependencies below are **product capabilities**. SDK access, migrations, contract probes and package work are technical dependencies in the sprint plan, not standalone product backlog items. Acceptance criteria describe expected behavior, not tests already passed.

## 2. Product items

### B01 — Owner configures identifiable teams and councils

- **Actor / value:** the owner selects existing agents and responsibilities, understands eligibility, and changes composition without rewriting agents or losing previous compositions.
- **Parent / priority:** V1; C01, C02, C07, C09, C17; first increment.
- **Product dependencies:** none for configuration. Enabling a governed mission also needs B04; changing an active mission needs B08.
- **Acceptance:** create, inspect, revise, activate, suspend and retire company/project-scoped rosters; identify integration lead, accountable final reviewer and required perspectives. Invalid or foreign-company members and incompatible selections have actionable errors. Selecting execution/review compositions rejects recorded author/reviewer conflicts. A published revision remains inspectable after later edits; retirement prevents future use without deleting history. Configuration readiness is visibly distinct from mission activation readiness.
- **Evidence:** scoped lifecycle journey plus A22; A18/A21 roster behavior in the first increment, then active-mission behavior with B08. Actual agent availability is rechecked when work is dispatched.

### B02 — Executors deliver one integrated result

- **Actor / value:** the integration lead coordinates bounded contributions; the owner receives a coherent result rather than a collection of completed child tasks.
- **Parent / priority:** V1; C01, C16, C18; after configuration and operating safeguards.
- **Product dependencies:** B01 and B04 before governed dispatch. B08 supplies failure/replacement/resumption behavior for the completed journey.
- **Acceptance:** identify mandate, lead, assigned contributions, dependencies and expected evidence; expose blocked contributions; publish an identified integrated candidate only after required integration checks. A failed integrated journey remains unaccepted even if every contributor reports completion. Concurrent contributors have explicit write ownership.
- **Evidence:** A08, contribution portion of A19–A20, and a representative two-contributor result.

### B03 — A separate reviewer corrects and accepts the exact result

- **Actor / value:** executor and reviewer can converge on a sufficient correction, while the owner can distinguish a verdict from its confirmed effect.
- **Parent / priority:** V1; C02–C06; establish the single-reviewer journey before expanding review composition.
- **Product dependencies:** B02 and B04; B08 provides safe continuation after interrupted application.
- **Acceptance:** an eligible reviewer examines the exact candidate and evidence, requests a justified correction, and reviews a new version. Changed content cannot inherit acceptance. Missing evidence produces a precise request. Applied acceptance identifies result, actual actor and effect; uncertain application remains visible and cannot be retried blindly. Repeated review without new evidence stops or escalates.
- **Evidence:** A01–A04, A06–A07 and decision portion of A20. This intermediate journey is not the entire V1 release.

### B04 — Owner authority and operating limits govern dependent work

- **Actor / value:** the owner delegates routine decisions while retaining reserved trade-offs and control over task/period consumption.
- **Parent / priority:** V1; C01, C05–C06, C09; required before affected dispatch or decision application.
- **Product dependencies:** B01 for identifiable participants and owner. Binding to a concrete result is completed with B02/B03, without requiring those capabilities to design the policy.
- **Acceptance:** enforce the owner-approved PRD §6.3, including essential uses, affected-group p95 strictly below 30 seconds, prior owner decision for infrastructure cost changes in either direction, and joint task/period limits. The actual owner receives options, evidence and a recommendation for a bound question. Silence, another responder or stale authorization cannot approve it. Only dependent work waits. Unknown consumption is shown as unknown; corrections and appeal do not reset operating limits. DEC-G4-01 requires shared reservations before admission, concurrency/retry limits and blocking new launches on unknown available budget or exposure; already-committed work can overrun the monetary threshold without creating permission for more work.
- **Evidence:** A05, A10–A11; no-response, wrong-responder and stale-response checks; concurrent task/period reservation, restart/settlement, operational limit and unknown/late-usage evidence under DEC-G4-01. No absolute monetary cap is claimed. Missing support for this adopted contract remains a blocker until qualified.

### B05 — Relevant perspectives inform one accountable verdict

- **Actor / value:** the reviewer and owner see attributable specialist objections and how they affected the decision.
- **Parent / priority:** V1; C02, C06, C10; after the single-reviewer journey.
- **Product dependencies:** B03 and B04.
- **Acceptance:** collect the required independent perspectives on the same submission; keep one accountable final reviewer; explain each material objection's disposition. An absent required opinion waits, triggers explicit replacement or escalates; it is never agreement. Contradictory evidence cannot be overruled by majority alone. Simple missions may still use one reviewer.
- **Evidence:** A09, review portion of A19, and at least two actual attributed perspectives in representative qualification.

### B06 — A specific disagreement receives a bounded appeal

- **Actor / value:** the owner or reviewer can resolve a consequential disputed question without an indefinite committee chain.
- **Parent / priority:** V1; C06, C11; after collective review.
- **Product dependencies:** B05 and B04.
- **Acceptance:** retain the question, compared arguments, exact result, eligible participants and resolution; one appeal level per disputed question/submission, within the same mission limits. No eligible independent participant or inconclusive evidence leads to the owner. The final reviewer remains accountable for applying the verdict; appeal is optional, not a universal approval step.
- **Evidence:** J05, A06–A07, A09; one appeal resolution and one explained escalation.

### B07 — Owner understands progress, decisions and consumption

- **Actor / value:** the owner knows what happened, what remains uncertain and who acts next without reading full logs.
- **Parent / priority:** V1; C07–C09; delivered incrementally with each visible journey.
- **Product dependencies:** B01 for configuration inspection; mission sections consume B02–B06 as they become available.
- **Acceptance:** show composition, mandate, result/evidence, contributions, opinions, rationale, application state, owner waiting and next action. Show available time, corrections, interventions and usage with gaps visible. Support keyboard operation, meaningful evidence links, understandable errors and status without color alone. Measurements support decisions; no generic analytics platform or claimed savings is required.
- **Evidence:** A17 and the operational portion of A16; keyboard/focus/error checks on delivered surfaces. Learning attribution remains excluded.

### B08 — Owner can stop, reconfigure and resume without losing responsibility

- **Actor / value:** the owner and replacement participants can continue the same mission while preserving history and accounting for work already in flight.
- **Parent / priority:** V1; C04–C05, C09, C17–C18; implemented alongside dispatch/application, completed before qualification.
- **Product dependencies:** B01; mission scenarios consume B02/B03. These completion dependencies do not justify postponing recovery until after effectful work ships.
- **Acceptance:** keep pinned roster and mandate revisions; explicit replacement names actor/reason and invalidates affected opinions. Roster suspension prevents new use while preserving active missions. Mission suspension/cancellation stops new dependent dispatch, reports in-flight effects and preserves history. Restart or duplicate delivery cannot silently produce another approval; unresolved effects remain uncertain with a next action. No global pause of a shared agent or automatic deletion.
- **Evidence:** A04, A18–A22 across the actual supported persistence/authentication paths.

## 3. Nominal milestone and later coverage

All slices below inherit V1 and their existing PRD parents. They are delivery priorities, not extra product backlog items or completed claims.

| Product item | Nominal milestone | After the first end-to-end run |
| --- | --- | --- |
| B01 — configuration | Reuse existing rosters; prove active-mission revision pinning | Live member replacement and extended lifecycle combinations |
| B02 — integrated result | Two bounded contributions, one lead and one verified integrated Git candidate | Richer dependency graphs and concurrent mission scheduling |
| B03 — review | Exact-candidate review, one ordinary correction/resubmission, confirmed native effect | Lost-response reconciliation and wider interruption variants |
| B04 — mandate and limits | Existing owner authority, qualified G4 admission for the selected operating profile, stop on reserved decisions or unknowns | Bound owner-response continuation and broader operational profiles |
| B05 — perspectives | At least two relevant attributed opinions per collective case, all seven specialties evaluated across the campaign, and one accountable synthesis | Replacement and late-opinion variants; broader selection policies |
| B06 — appeal | An unresolved dispute stops with an explicit owner destination | Implement and qualify the one-level appeal required for full V1 |
| B07 — inspection | One understandable mission summary: candidate, contributions, opinions, effect, usage/unknowns and next actor | Complete lifecycle/history inspection and usability coverage |
| B08 — continuity | Durable state, single-effect command handling, stop new work on suspension/uncertainty | Assisted resumption, replacement and complete interruption qualification |

An unsupported case must stop with preserved state and a next actor. Deferral never means accepting a missing opinion, ignoring a failed integration, retrying an uncertain mutation, forgetting unsettled usage, or silently changing a mandate. Record concrete discoveries in the sprint plan's follow-up register; hypothetical improvements do not block the nominal milestone.

## 4. Coverage and release closure

| PRD requirement | Accountable backlog item(s) |
| --- | --- |
| C01 | B01, B02, B04 |
| C02–C03 | B01/B03/B05 for separation; B03 for correction and acceptance |
| C04–C05 | B03, B04, B08 |
| C06 | B03–B06 |
| C07–C08 | B07; B01 configuration inspection |
| C09 | B01, B04, B07, B08 |
| C10–C11 | B05, B06 |
| C16 | B02 |
| C17–C18 | B01, B02, B08 |

V1 closure requires these capabilities together and the applicable A01–A11, operational A16, A17–A22 scenarios. Deterministic tests establish rules; representative actual-agent missions establish judgment and coordination within their recorded limits. A package build, installation or a prototype probe cannot close a product item on its own.

## 5. Explicitly deferred beyond V1

C12–C15, A12–A15 and the learning portion of A16 remain beyond V1: cross-mission memory, knowledge adoption/retrieval, learning evaluation and automatic process changes. Also deferred: automatic agent provisioning, recursive councils, a separate execution engine, broad compatibility, generalized artifact approval and external merge/deployment control. Same-mission persistence and recovery remain required now.

No agent identities, monetary amounts, dates or delivery capacity are invented. Concrete activation inputs and unresolved host guarantees are tracked in the sprint plan. This backlog does not authorize runtime activation, external tickets, publication or implementation.
