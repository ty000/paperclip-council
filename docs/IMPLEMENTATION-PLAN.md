# Paperclip Council — V1 implementation lots

Version 0.1 — September 30, 2026. Proposed execution sequence, not a schedule, issued tickets or implemented backlog.

Product parents: [PRD](PRD.md) C01–C11, C16–C18 and [V1 scope](V1-SCOPE.md). Architecture: [TAD](TAD.md) D01–D10. Memory/learning C12–C15 remain deferred. This plan does not authorize instance changes, credentials, provider runs, external publication, merge or deployment.

## 1. Entry and evidence rules

Integrate the documentary base with the existing extraction and manifest-gate code deliberately before implementation; neither is present merely because its Git object was inspected. Preserve unrelated changes and the historical integration review. Confirm the resulting branch, exact host/SDK versions and existing package checks. Do not recreate an adapter already present in S8, discard its preflight tests or treat its reported qualification as fresh proof.

Each lot ends with an inspectable behavior and scoped evidence. A failing dependency keeps dependent claims open. Unit tests may isolate rules; qualification of plugin/API/authentication/persistence must use the actual supported path. Agent reasoning, startup authentication and runtime availability cannot be proven by synthetic fixtures. Record PASS, FAIL or NOT EXECUTED by claim and explain manual recovery.

## 2. Delivery sequence

| Lot / user outcome | Product parent and architecture | Implementation scope and dependency | Exit proof |
| --- | --- | --- | --- |
| L0 — A defensible plugin foundation | C01–C05, C09; D01, D03–D04, D06–D08 | Reconcile code/document branches, preserve manifest gate, pin host/SDK, verify G1 and prototype the narrow G2/G3/G4 seams. No full UI or team automation yet | Existing build/typecheck/tests pass on the integrated base; real bridge proves migration + competing CAS writes; attachment and decision/owner readback seams are demonstrated or explicitly block dependent work |
| L1 — Owner configures teams and councils | C01, C09, C17; D02–D03, D09–D10 | Revisioned rosters, existing-agent selection, responsibility/conflict checks, activation inputs, lifecycle and minimal configuration surface. Depends on L0 | Create/revise/activate/suspend/retire; foreign-company and self-review configurations refused; active mission revision unaffected by roster edits; understandable prerequisite errors |
| L2 — A mission receives integrated team work | C01, C05, C16, C18; D02–D04, D09 | Mission aggregate, command receipts, effect intents, task/period reservations, contribution graph, child issue mapping, integration lead, isolated write ownership, submission publication. Depends on L1 and relevant L0 gates | Two contributions feed an integrated candidate; a failing integrated check blocks review despite completed children; duplicate command/concurrent update and ambiguous child creation do not silently duplicate work |
| L3 — One separate reviewer can correct and accept | C02–C06; D05–D08 | Native root stage/handoff, immutable result/evidence binding, bundle verification, stored verdict, guarded decision adapter, addressed owner waiting and application readback. Depends on L2 | A01–A05, A10–A11, A20 and G2–G4: correction → new version → applied acceptance; stale result, wrong actor, failed application and absent owner response cannot pass |
| L4 — A council resolves relevant disagreement | C06, C10–C11, C17; D02, D05–D07 | Specialist review child issues, required opinion slots, objection synthesis, missing-member handling and one-level appeal. Depends on L3 | At least two attributed perspectives on one submission; missing opinion blocks; evidence defeats unsupported majority; appeal resolves or escalates without recursion; final native actor remains accountable |
| L5 — Owner can inspect, stop and resume the whole mission | C05, C07–C09, C17–C18; D04, D08–D10 | Complete mission view, restart scan, explicit member replacement, suspension/cancellation accounting, usage/unknowns and retained history. Depends on L4; underlying recovery exists since L2–L3 | A17–A22 and G5: restart at effect boundaries, late opinion, roster change and in-flight suspension produce attributable states and next actions; no duplicate approval or silent data loss |
| L6 — V1 is qualified on representative work | Entire selected scope; D01–D10 | Fresh authenticated target qualification and bounded real-agent missions, after L0–L5. Requires selected instance, owner, roster, budgets and representative requests | Integrated team + collective review + correction + appeal + human waiting + restart are demonstrated with persisted actor/run/result/effect evidence. Real-agent judgment and coordination are assessed separately from deterministic transition tests |

L3 is an intermediate usable workflow, not completion of V1. L4–L6 are required by the owner's selected teams/councils scope. No lot adds cross-mission memory, learning, automated knowledge adoption or an external delivery trigger.

## 3. Proof matrix

| Proof layer | Selected scenarios | Evidence and limit |
| --- | --- | --- |
| Domain / persistence | A03–A07, A09–A11, A18–A22 | State transition and actor guards, command identity/payload conflict, concurrent CAS, pinned revisions and no silent quorum reduction; does not prove host behavior |
| Actual plugin / Paperclip | A01–A05, A08, A18–A22 | Installed built plugin, company scope, real authentication and persistence, native review transition, owner response and recovery across crashes; synthetic setup actors must be labeled |
| Representative agents | A01–A02, A06–A11, operational A16, A19 | Distinct actual agents create and review a coherent result, compare arguments, correct and resume; record intervention, usage and uncertainty, not just process exit codes |
| Human inspection | A17, A18, A21 | Configure and inspect without full logs; keyboard use, focus/errors, evidence links, non-color state and narrow-window layout; screenshots alone do not establish keyboard usability |

Fault injection must cover intent persistence, dispatch claim, native success before local receipt, timeout with late native completion, duplicate wake and manifest/content change. Observe the actual readback path. If safe retry cannot be established, an explicit recoverable unknown state is the correct result; a false acceptance is a failure.

## 4. Release and activation boundary

Release closure requires selected scenarios, complete requirement traceability and explained residual limits. A green package test suite or installed/ready plugin does not close V1. No claim of learning, time savings, bypass impossibility, broader Paperclip compatibility or external delivery control is included.

Before L6/live activation, supply the actual WSL instance/company/project, designated human owner, eligible execution/review agents and credentials through native secret management, task/period budget policy, correction/elapsed limits, accessible Git/evidence location and representative tasks. Missing values leave activation pending without blocking bounded earlier code work.

The next implementation task is L0. Its output is a reconciled code/document base and a short pass/fail record for the host contract seams, followed by L1 when those dependencies are supported. This is an implementation plan, not a generated agent/run prompt or authorization to launch live agents.
