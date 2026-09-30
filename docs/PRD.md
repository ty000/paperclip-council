# Paperclip Council — PRD

Status: V1 product scope selected; implementation and qualification pending. Detailed design choices and activation prerequisites are identified in the companion documents.
Document version: 0.4 — September 30, 2026.

This document defines the target product, its users, journeys, requirements, and the outcomes used to assess its value. The [roadmap](ROADMAP.md) proposes evolution horizons; it does not change this PRD's requirements. Architecture, libraries, infrastructure, tickets, sprints, and delivery dates belong in other documents.

The [proposed agent catalogue](AGENT-CATALOG.md) translates these responsibilities into candidate missions, execution settings and skills against a reviewed Paperclip source baseline. It prepares the TAD without configuring agents or replacing the mandate defined here.

The full vision is retained: councils, shared memory, and measured improvement. On September 30, 2026 the owner selected teams and council mechanics for V1, with memory and learning deferred. V1 includes C01–C11 and C16, plus C17–C18 below. C12–C15 remain later capabilities; durable state needed to resume the same mission belongs to C05 and is required now. The document version does not identify a released software version.

The [V1 scope](V1-SCOPE.md) elaborates this boundary; the [TAD](TAD.md) derives technical contracts from it, and the [implementation plan](IMPLEMENTATION-PLAN.md) sequences verifiable delivery lots. Neither document weakens the mandate in §6.3.

## 1. Problem and promise

A product owner delegating work to agents still has to repeat context, resolve routine disagreements, verify results, and contain unnecessary scope extensions proposed during reviews. Individually correct contributions can form an incoherent result. Experience gained on one request often disappears before the next.

Paperclip Council must enable agent supervision that guides work, requests corrections, and accepts results based on evidence within an explicit mandate. Useful decisions and experience must then help other agents work better, with observable effects and reversible changes.

The promise is: **better-directed work and results accepted on evidence, with reusable collective experience and human decision authority preserved**.

Reducing human intervention is one objective alongside value delivered, quality, turnaround time, and resource consumption. Asking fewer questions by hiding a problem, abandoning a difficult request, or exceeding the mandate does not constitute progress.

## 2. Users and responsibilities

The initial use case is building and evolving software products with a single human owner. Making the plugin public does not, by itself, introduce a requirement for collaboration between multiple human operators.

| Actor | Need and responsibility |
| --- | --- |
| Owner | Define objectives and delegated authority, understand decisions, resolve exceptions, and stop unsuitable operation. |
| Executor | Receive a useful request and context, produce a verifiable result, and understand the corrections required. |
| Integration lead | Combine contributions into a coherent result; an existing agent can hold and transfer this responsibility. |
| Council | Examine relevance, proportionality, and evidence; guide, request corrections, or accept within its mandate. |
| Long-lived steward | Maintain knowledge for a role or project without becoming the sole holder of essential information. |
| Appeal council | Examine a specific disagreement and its evidence without becoming a mandatory additional approval step. |

The software's end users are represented through their needs, journeys, and corresponding evidence. The opinions of a "product" or "UX" agent do not replace these inputs.

## 3. Positioning and boundaries

Paperclip Council is an extension of Paperclip. Its own scope covers supervision mandates, reviews and decisions, their effects on acceptance, follow-up on trade-offs, and eventually learned knowledge and its evaluation.

The product relies on platform services to organize work and execute agents. The exact technical division of responsibilities must be verified in the TAD. This positioning does not assume that Paperclip already provides every required capability.

The reviewed Paperclip baseline provides agent identities, execution runs, issue review stages and native decision records. Council connects the mandate, identified submission, evidence, verdict and verified effect. Supported company-scoped readback of the decision details needed for uncertain-application reconciliation remains an open G3 dependency. The actors and acceptance paths covered by supervision must be declared when it is enabled; the availability of a platform capability does not demonstrate its integration into Council.

### Included in the vision

- Guide a request already present in Paperclip and examine its expected outcome.
- Bring together useful professional perspectives, with supervision proportionate to the stakes.
- Request a specific correction, review the result again, and issue a reasoned acceptance decision.
- Apply that decision in the covered workflow and make its actual state visible.
- Escalate to the owner with a recommendation when the mandate is insufficient.
- Preserve decisions, disagreements, trade-offs, and follow-up commitments.
- Share applicable knowledge, understand it, maintain it, and control its use.
- Evaluate the effects of supervision and learning on subsequent requests.

### Excluded from the current definition

- Rebuilding a complete platform for agent execution, scheduling, or hosting.
- Developing a catalog of intake connectors or a competing project management platform.
- Promising autonomous delivery of an entire product from an unscoped objective alone.
- Implicitly authorizing a merge, deployment, publication, or external expenditure through internal acceptance.
- Guaranteeing continuous improvement, general intelligence, or autonomous modification of model weights.
- Freely changing acceptance criteria, authority boundaries, or financial commitments.
- Providing a managed service, commercial billing, or governance involving multiple human operators from the outset.

The first use case addresses a bounded request: a bug fix, a simple feature, an improvement with an explicit objective, or an investigation that produces a conclusion. A collection of completed requests does not automatically demonstrate achievement of a broader objective.

## 4. Initial evidence baseline

The local trials reported on September 29, 2026 established:

- actual plugin loading and recorded decisions attributed to a Council identity;
- an isolated functional workflow: V1 → correction requested → V2 → acceptance;
- a persistent local installation and an initial task completed and accepted by distinct Executor and Council agents.

The correction-and-acceptance sequence used controlled fixtures. The separate real-agent workflow concerned a small software function accompanied by tests. It required configuration and recovery interventions, and its council consisted of one agent. These observations do not establish a complete correction-and-resumption journey with real agents. The trials were not rerun to author or revise this document.

They do not yet demonstrate general council authority, resistance to other completion paths, control over external delivery, the quality of a multidisciplinary council, learning, or net savings in time and resources.

These results come from a prototype integrated into the reference Paperclip checkout. The repository now contains the standalone decision adapter and manifest approval gate alongside the product documents. The publication baseline is `9d7d0e0`, including the current-candidate validation fix; exact source identities and limits are recorded in the TAD. Earlier extraction/gate commits were inspected during design, and the current base was inspected again before publication. Runtime trials were not rerun for this documentary change. Their existence does not establish team orchestration, collective decisions, activation on a target instance or V1 qualification. The following requirements describe expected behavior, not a set of capabilities that are all already available.

## 5. Product principles

1. **A decision must have a verifiable effect.** A favorable comment is not an applied acceptance decision; a successful technical status is not an accepted delivery.
2. **Acceptance applies to an identified result.** A version changed after review does not silently retain the previous version's approval.
3. **Criteria and the mandate precede the verdict.** Agents do not relax them to make work acceptable.
4. **Evidence takes precedence.** Consensus, a vote, or a prestigious role does not resolve a factual contradiction.
5. **Supervision remains proportionate.** A finding must relate to a need, a consequence, or an applicable obligation. A cosmetic disagreement does not justify an indefinite loop.
6. **Resumption preserves continuity.** A new session retrieves the mandate, reviewed version, decisions, and remaining work without replaying the entire conversation.
7. **Learning can be challenged.** Stored or consulted knowledge is not evidence of improvement; its application and its effect must be distinguished.

## 6. Council model and authority

### 6.1 Composition and accountability

The smallest starting composition is one Executor and one distinct Generalist Reviewer, as described in the [proposed agent catalogue](AGENT-CATALOG.md#3-h1-startup-profiles). The term "multidisciplinary council" is reserved for a review involving several distinct agents with attributable domain contributions. A single agent switching perspectives does not demonstrate such a council, and several identities alone do not demonstrate independent or better judgments. Product, architecture, and quality are the reference perspectives; others are involved according to the request's consequences.

The product must make it clear who reviewed what, which objections were upheld or dismissed, and who is accountable for the final verdict. An executor cannot turn its own contribution into delegated acceptance. Responsibility for integration remains distinct from acceptance.

Several agents with the same role may contribute when useful. V1 includes execution teams, specialist councils and bounded appeals; the two-agent starting composition is not its full release boundary. The expected outcome remains an integrated result; increasing agent count is neither a measure of progress nor a requirement for every task.

### 6.2 Mandate and decisions

The mandate specifies the expected outcome, criteria, decision scope, commitments to preserve, applicable budgets, and events requiring escalation. A missing parameter does not create permission.

The council may guide work, request targeted evidence, select a sufficient correction, reject an unnecessary scope extension, and accept a compliant result. A new product requirement or a relaxation of criteria requires the owner's decision.

Within the workflow declared to be governed, acceptance must be linked to a valid verdict on the current result. If the decision has not been applied, the product exposes that failure and does not present the work as accepted. The actual scope of this control must be visible; control over an external action cannot be claimed without integration and evidence specific to that action.

The submission identifies the reviewed content and the relevant evidence used. A changed result does not inherit the earlier verdict. The supervision experience distinguishes the reasoning verdict, the recorded decision and its confirmed application. Uncertain application remains visible until its actual effect is established.

An explicit intervention by the owner remains possible and identifiable as such; it is not presented as a council decision. The extent of guarantees regarding other access paths and administrative privileges must be specified and validated before making a general claim of authority.

### 6.3 Initial delegation profile

The following rules reflect the initial user's decisions. They form a usage profile to preserve for this validation setting, rather than a universal policy imposed on every project. Changes to this profile remain the owner's decisions.

| Situation | Expected decision under the initial profile |
| --- | --- |
| Several solutions satisfy the need and authorized limits | The council selects the technical approach and preserves its rationale. |
| A correction restores a validated user journey | The council may accept it within the other limits of its mandate. |
| An important product change or user commitment falls outside a delegated trade-off | Recommendation to the owner before application. |
| An improvement for majority usage degrades minority usage | The council may decide only if essential uses remain possible and every other limit is respected. |
| An essential journey becomes impossible, even for a minority | Owner decision required. |
| A degradation leaves the complete journey's p95 strictly below 30 seconds for each affected group | The council may decide within the preceding trade-off; the duration multiplier is not an additional limit. |
| This p95 reaches or exceeds 30 seconds for an affected group | Owner decision required. Improving an already long journey is not, by itself, a degradation. |
| An infrastructure change affects costs, whether increasing or decreasing them | Prior owner decision, even within an authorized budget envelope. |
| Admitting new work would exceed the task or shared period budget policy | Block new admission and obtain a prior owner decision to change the allowance; both limits apply together. Unknown available budget or remaining exposure blocks new admission. |

The p95 covers the journey through to a usable result, including background waiting. Representative trials may be sufficient; their population, relevance, and uncertainty must be explicit. The 80/20 principle means a benefit for majority usage, not a screen count or a vote.

If identifying an essential use or estimating a trade-off remains both decisive and uncertain, a proportionate investigation precedes escalation. A follow-up action does not authorize a trade-off outside the mandate. The absence of a human response never constitutes approval; only work dependent on that response waits.

**Owner-approved V1 budget policy — September 30, 2026 (DEC-G4-01).** The owner accepts prudent monetary control with mandatory operational limits, rather than an absolute monetary ceiling. Reserve shared task/period allowance before launch, enforce configured concurrency and retry/correction limits, and keep corrections, appeals and resumption within the same envelope. Known spend, reservations and remaining in-flight exposure must stay visible; unknown or unpriced usage is never zero. Unknown available budget or remaining exposure blocks new launches. Work already committed may still produce an overrun: record it and stop new admission under the exhausted or uncertain envelope. This accepted residual risk does not permit knowingly admitting work beyond the authorized allowance. Cancellation is not proof that no further cost can accrue.

Concrete amounts, period boundaries, measurement sources and reservation estimates remain activation inputs; accepting the policy does not qualify a runtime or choose those inputs. Infrastructure cost changes in either direction still require prior owner approval, independently of the operational envelope. See the [decision record](G3-G4-DECISIONS.md) for authority, pending qualification and scope.

### 6.4 Disagreements and appeals

An appeal concerns a specific question after arguments and evidence have been compared. Specialists examine the evidence in their domain and issue a reasoned verdict. Where admissible choices remain tied, the perspective closest to the scope may receive greater weight, determined before breaking the tie.

Such a vote does not override a factual contradiction, an authority boundary, or missing evidence. An inconclusive case calls for a bounded investigation, then escalation to the owner if a decision is still needed. An appeal must not become a mandatory step for every request.

## 7. Memory and collective improvement

### 7.1 Memory scopes

| Logical scope | Purpose |
| --- | --- |
| Individual | Continuity of a steward's experience and awareness of recurring mistakes. |
| Role | Professional methods reusable by several agents with the same specialty. |
| Project | Project-specific objectives, context, environment, constraints, and decisions. |
| Role within a project | Local practices and exceptions useful to that role. |
| Collective decision-making and organization | Mandates, decisions, responsibilities, and ways of cooperating. |
| Collective relevance and follow-up | Links between needs, work, results, trade-offs, and subsequent commitments. |

These scopes do not prescribe separate storage systems or components. A generalizable method may be shared within the mandate; project-specific information remains local unless its transfer is explicitly authorized. A long-lived steward must not become an irreplaceable dependency.

### 7.2 Understanding and managing learned knowledge

The owner must be able to list knowledge items and inspect their sources, scope, applicability conditions, state, and the work in which they were used. The owner must be able to challenge, correct, suspend, withdraw, or reset them within a comprehensible scope.

Withdrawing a knowledge item prevents new use without rewriting historical decisions. The distinction between withdrawal from use, reset, and deletion of content must be explicit before the action; detailed retention and deletion requirements remain to be defined.

Agents propose knowledge items. The council may adopt, restrict, or withdraw them within its mandate; stewards maintain them. A hypothesis remains distinct from a fact, and an authorized decision does not turn its predicted effects into observed results.

### 7.3 Demonstrating improvement

The product distinguishes knowledge that is proposed, adopted, available, consulted, applied, and associated with an evidence-supported benefit. Evaluation concerns new, comparable requests, including adverse effects and other possible explanations: a different model, additional resources, an easier request, or a different context.

Insufficient results must be able to lead to no promotion, a narrower scope for a knowledge item, or reversal of an adjustment. Learning to remove an unnecessary check is among the intended outcomes.

The learning process may be reviewed periodically or in response to a repeated error, an incident, or drift. The council may try a reversible adjustment within approved objectives, criteria, and budgets. Changes to priorities, the mandate, or the definition of success remain human decisions. Unfavorable historical results are not erased to improve the reported outcome.

## 8. Reference journeys

| ID | Journey | Observable outcome |
| --- | --- | --- |
| J01 | Define the mandate and activate supervision for a request | The owner and agents can identify the expected result, criteria, council, and its limits. |
| J02 | Submit, review, and accept a result | The decision concerns an identified result, cites its evidence, and has a visible effect on the work concerned. |
| J03 | Request a correction and review again | The executor understands what is missing; the new version is reviewed without losing criteria or needlessly repeating completed work. |
| J04 | Request a human decision | The need, options, consequences, evidence, uncertainties, and recommendation are presented; dependent work waits for the decision. |
| J05 | Challenge a scope extension or resolve a disagreement | A sufficient correction can be selected; any appeal addresses a specific question and respects the mandate. |
| J06 | Resume interrupted work or transfer a role | The version, mandate, decisions, contributions, and next actions remain understandable; resumption does not duplicate an already applied decision. |
| J07 | Capture experience and pass it on | A new executor can retrieve applicable knowledge, its source, and its limits; consultation, application, and benefit remain distinct. |
| J08 | Suspend or revise knowledge that has become harmful | New decisions stop silently relying on withdrawn knowledge; past uses remain explainable. |
| J09 | Review outcomes and adjust supervision or learning | A justified adjustment can be retained, limited, or reversed; making no change remains a valid outcome. |

## 9. Requirements and selected first-release boundary

"First usable release" refers to the selected V1 scope. "Vision" refers to a target requirement whose commitment depends on the roadmap. These categories neither demonstrate implementation nor prescribe a ticket sequence.

| ID | Requirement | Product acceptance criterion | Proposed scope |
| --- | --- | --- | --- |
| C01 | Identified mandate and result | J01 can be completed without reconstructing the objective from every agent's exchanges. | First usable release |
| C02 | Review distinct from execution | The work's author, reviewer, and verdict authority are identifiable. | First usable release |
| C03 | Explicit correction, re-review, and acceptance | J02–J03 conclude with rationale and evidence; acceptance applies to the result actually reviewed. | First usable release |
| C04 | Actual effect and visible limits | An unapplied decision is not reported as applied; the governed workflow is not declared accepted without a valid verdict. | First usable release |
| C05 | Escalation and resumption | J04 and J06 preserve understandable waiting states, without approval by silence or duplicate effects on resumption. | First usable release |
| C06 | Proportionality and stopping | Each correction addresses a justified gap; repetition without new evidence leads to a conclusion, an explained blocker, or escalation. The stopping rule names a reachable escalation destination and explains what happens at the configured limit. | First usable release |
| C07 | Accessible human inspection | The owner can inspect the result, state, rationale, evidence, and next action without reading complete logs. | First usable release |
| C08 | Minimal usage assessment | Outcomes, time, interventions, corrections, and available resource-usage data are visible; missing data remains flagged. | First usable release |
| C09 | Configuration of the covered scope | The operator understands prerequisites and limits. Activation verifies distinct executor/reviewer identities, the applicable review path and the owner decision destination; suspension makes the disposition of pending work and decisions explicit, without silently losing pending decisions. | First usable release |
| C10 | Proportionate multidisciplinary council | Several perspectives contribute to an actual decision, with attributed objections and explicit accountability for the verdict. | First usable release |
| C11 | Bounded appeals | J05 can resolve a disagreement without creating an indefinite chain of councils or exceeding the mandate. | First usable release |
| C12 | Collective continuity | Decisions, trade-offs, and follow-up remain reusable by another team and linked to the original need. | Vision |
| C13 | Inspectable and controllable knowledge | J07–J08 cover provenance, scope, applications, suspension, withdrawal, and revision. | Vision |
| C14 | Evaluated learning | Assessment distinguishes reuse from benefit on new requests; a regression calls the knowledge item's scope into question. | Vision |
| C15 | Process review | J09 allows reversible trials within approved limits and preserves unfavorable measurements. | Vision |
| C16 | Coherence across multiple contributions | Acceptance examines the integrated result; it is not derived from individual statuses alone. | First usable release |
| C17 | Explicit teams and council composition | The owner can create, revise and retire scoped rosters using existing agents, identify integration and verdict responsibilities, and see which composition governs each active mission. Changes never silently replace an in-flight reviewer or mandate. | First usable release |
| C18 | Coordinated contribution lifecycle | A mission links assigned contributions, dependencies and integration; unavailable members, replacement, suspension and cancellation preserve an attributable next action without accepting incomplete work. | First usable release |

This first release does not require a full council for every task or every future memory capability. It must nevertheless reach an acceptance decision that is actually applied, a correction that can be reviewed again, or an understandable blocker. A collection of mechanisms without a usable journey is insufficient.

## 10. Discriminating validation scenarios

These scenarios are behavioral requirements to translate into the validation environment. They are not a record of executed tests. Deterministic evidence covers rules and transitions; representative trials with agents evaluate decisions. Both are needed for their respective claims.

| ID | Situation | Expected behavior | Capabilities |
| --- | --- | --- | --- |
| A01 | Compliant result, sufficient evidence, mandate respected | Acceptance applied and attributed to the council, without a mandatory second human approval. | C01–C04 |
| A02 | A user criterion fails | Specific correction requested; the work remains unaccepted; a compliant new version can be accepted. | C03 |
| A03 | Content changes after review | The previous verdict does not silently accept the new result. | C03–C04 |
| A04 | Recording or applying the decision fails, or application is uncertain | The reason and resumable state are visible; the actual effect is reconciled before retry, with no false closure or duplicated decision on resumption. | C04–C05 |
| A05 | A decision requires the owner, who does not respond | Dependent work waits, the recommendation is available, and there is no implicit authorization. | C05 |
| A06 | A review proposes a generic redesign where a local correction would suffice | The extension can be rejected with a rationale; a real obligation is not dropped in the name of simplification. | C06 |
| A07 | The agent repeats a review using the same evidence | Applicable conclusions are reused; stop or escalate if no progress justifies repetition. | C06 |
| A08 | All contributors report completion, but the integrated journey fails | Acceptance is not inferred from statuses alone. | C16 |
| A09 | A majority opinion contradicts relevant evidence | The contradiction remains to be resolved; voting does not turn the opinion into fact. | C10–C11 |
| A10 | Initial profile: majority usage improves, minority p95 rises from 2 to 20 seconds, other conditions satisfied | The trade-off is delegated despite the multiplier; at 30 seconds or more, a human decision is required. | C01, C05 |
| A11 | Initial profile: an essential journey becomes impossible, or an infrastructure change affects costs | Human decision required; neither majority usage nor available budget is sufficient. | C01, C05 |
| A12 | Knowledge is adopted but never applied | No learning benefit is claimed from adoption alone. | C13–C14 |
| A13 | Knowledge contradicts recent evidence or an applicable decision | Conflict visible, use suspended or restricted within the mandate, history understandable. | C12–C14 |
| A14 | A shareable method contains project-specific data | The method is shared without that data; the specific transfer requires authorization. | C13 |
| A15 | Turnaround time falls after a model change and simpler requests | Observed improvement is distinguished from attribution to learning. | C14–C15 |
| A16 | Supervision reduces interventions but consumes more resources and leaves more defects | Trade-offs remain visible; no success claim based on a single metric. | C08, C14–C15 |
| A17 | A user inspects a decision through the supervision experience | State, rationale, and required action are understandable, evidence is accessible, and meaning does not depend on color alone. | C07 |
| A18 | A roster changes while a mission is active | The mission retains its recorded composition until an explicit, attributed reconfiguration; invalid reviews are superseded, not silently reused. | C17–C18 |
| A19 | A required specialist is absent or a contributor fails | There is an explained wait, authorized replacement or escalation; silence and missing contributions never count as approval. | C05–C06, C10, C18 |
| A20 | Duplicate delivery, concurrent commands or a worker restart occurs | One logical action has at most one accepted Council result; ambiguous external effects are reconciled before further dispatch. | C04–C05, C18 |
| A21 | A roster is suspended/retired or a mission is suspended/cancelled | Roster changes stop new use while existing missions retain their pinned revision; mission suspension stops new dependent dispatch and accounts for in-flight work. History survives; no task or agent is silently deleted. | C09, C17–C18 |
| A22 | Another company or an unauthorized member submits a command | The command is refused without changing the mission, impersonating a reviewer or disclosing protected evidence. | C01–C02, C17 |

In A01–A02, insufficient decisive evidence produces a precise evidence request or an explained waiting state, never inferred acceptance. The request identifies what is missing and why it changes the decision; it does not automatically require a new result version when additional evidence is sufficient.

Validation must prioritize product journeys and their boundaries, with checks targeted enough to identify the cause of a failure. High line coverage or a large test count does not replace a demonstrated journey. The use of simulated components must be explicit when the conclusion concerns a real integration.

## 11. Supervision experience

The expected surfaces make the following understandable: the mandate; the result and its version; opinions and the verdict; a required correction; a pending owner decision; a trade-off and its follow-up; and knowledge and its effects when those capabilities are in scope.

Business states distinguish at least work in progress, result submitted, correction requested, awaiting a decision, decision awaiting application, accepted, and unsuccessful. They do not prescribe Paperclip's technical state names. A result may be accepted with open follow-up without hiding the remaining problem.

Decisive information must be accessible without reading every conversation. Interactive controls must be keyboard-accessible, states understandable without color alone, and errors accompanied by a possible action. A dedicated interface, its design system, mobile scope, and additional languages remain to be defined; their absence does not justify an incomprehensible supervision experience.

## 12. Measuring value and its limits

| Dimension | Useful observations |
| --- | --- |
| Value and quality | Needs satisfied, journeys verified, regressions, accepted results later reopened, relevant problems detected or missed. |
| Execution | Time to a usable result, waiting, corrections, resumptions, blockers, and abandoned requests. |
| Supervision | Human interventions, relevance of escalations, council overhead, useful disagreements, and unjustified extensions rejected. |
| Resources | Model usage, other available cost data, repeated execution, shared costs, and missing data. |
| Memory and learning | Reuse, effects on new requests, repeated mistakes, regressions, obsolescence, and maintenance cost. |
| Delivery | Delivery metrics, including DORA where relevant and accessible for the product being developed. |

These dimensions form an extensible assessment framework, not an obligation to build every dashboard for the first use case. Each collected measure must support a decision. An unknown cost is not zero; a non-applicable metric is not favorable. Results include failures and abandoned requests.

It must be possible to compare the council with simpler supervision on comparable requests. The comparison specifies what changed and the sample's limitations. No universal percentage reduction in workload or single success score is set here.

An increase in agents, memory items, or reviews demonstrates no progress by itself. Evaluation accounts for the full cost of coordination, maintenance, and measurement. The owner decides product priorities that have not already been authorized.

## 13. Risks and open questions

| Risk | Expected product response |
| --- | --- |
| Advisory council with no actual effect | C04 must be validated within the declared workflow before claiming authority. |
| Agent bureaucracy | C06, visible overhead, and perspectives involved according to need. |
| Misleading consensus | Attributed opinions, comparison against evidence, and bounded appeals. |
| Lost context or an irreplaceable steward | C05 and C12, with decisions independent of a private session. |
| Contaminated or overly broad memory | C13, explicit scope and provenance, withdrawal from use, and bounded sharing. |
| Claimed gains without evidence | C08 and C14, contextualized comparison, and preserved unfavorable results. |
| An extension that rebuilds the entire platform | The boundary in section 3 and justification for each added capability. |

Decisions still required, without reopening those already agreed:

1. V1 scope is selected: C01–C11, C16–C18. Choose representative requests and the deployment-specific roster before qualification; memory and learning remain deferred.
2. Specify the actors and paths covered by acceptance authority, including the visibility of owner intervention.
3. The V1 design starts with owner-selected existing agents and explicit team/council configuration, with a minimal Paperclip plugin supervision surface. Concrete agent identities and runtime availability are activation inputs. Automatic agent provisioning is deferred; ordinary Paperclip agent/catalogue setup remains available outside the Council mission.
4. Set usage budgets, proportionate stopping rules, and criteria for judging acceptable council overhead.
5. Define the visible differences between suspension, withdrawal, reset, and deletion of knowledge before committing to memory capabilities.
6. Specify the promised Paperclip compatibility and adoption beyond the initial setting before expanding distribution.

## 14. Sources and status

This definition carries forward product decisions made while framing the initial ecosystem, followed by the choice of a Paperclip extension, a public repository, and a full vision with a first release centered on councils. Specific profiles are identified rather than presented as universal obligations.

The evidence baseline in section 4 comes from the local functional, packaging, and persistent-installation qualification reports dated September 29, 2026, cross-checked against the prototype documentation. Those private materials are not reproduced in this repository: no instance address, account identity, secret reference, or raw trace is necessary for this public product definition.

Version 0.2 incorporates a documentary integration review against [Paperclip commit `61b3fd57a695614dc4a37e2303f426a34a9795cf`](https://github.com/paperclipai/paperclip/tree/61b3fd57a695614dc4a37e2303f426a34a9795cf) and the local prototype. The [agent catalogue](AGENT-CATALOG.md) cites the observed contracts and identifies unpublished evidence separately. Source inspection supports the proposed division of responsibilities; it does not extend the historical runtime qualification or settle the open product decisions.

This proposal is neither an independent validation of the product nor a delivery schedule commitment. The scenarios describe required behavior; only the facts explicitly qualified in section 4 are reported as demonstrated within their trial scope.

Version 0.3 records the September 30 owner scope decision, adds team lifecycle requirements C17–C18 and scenarios A18–A22, and links V1 design and delivery planning. Detailed technical defaults are design proposals, not evidence of installed or running behavior. The initial §6.3 mandate is unchanged.

Version 0.4 records owner-approved DEC-G4-01 in §6.3 and DEC-G3-01 for minimal supported decision readback. The former explicitly replaces the absolute monetary-cap interpretation with prudent admission control; all other mandate protections remain. Both technical gates stay open pending qualification. Future stronger guarantees are roadmap candidates, not V1 acceptance additions.
