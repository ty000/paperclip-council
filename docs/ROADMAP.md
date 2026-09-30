# Paperclip Council — Product Roadmap

Status: V1 scope selected (H1 + H2 + team lifecycle); later horizons remain conditional.
Document version: 0.2 — September 30, 2026.
Product reference: [PRD](PRD.md).

This roadmap describes potential major evolutions, their value, their product dependencies, and the observations needed to decide what comes next. It is neither a schedule, a technical backlog, nor a commitment to deliver every horizon.

The PRD is authoritative on needs and behavior. The roadmap identifies what may be taken forward; it cannot silently remove a requirement or extend delegated authority. A change in need requires a PRD update; a change in priority may affect only this roadmap.

The September 30 scope decision selects H1 and H2 together, including C16–C18 team coordination, for the first release. H1 is an implementation dependency and intermediate demonstration, not the complete V1. Memory and learning (H3–H5) follow later. See [V1 scope](V1-SCOPE.md), [TAD](TAD.md) and [implementation lots](IMPLEMENTATION-PLAN.md).

## 1. Starting point

A prototype supported a functional correction-and-acceptance loop, followed by an initial real local workflow with a distinct executor and reviewer. This evidence is limited and required intervention. It does not yet demonstrate a reproducible experience for another user, complete authority, multidisciplinary supervision, resource savings, or learning.

The dedicated repository and public availability are not, by themselves, a functional milestone. The first question remains: **can a user obtain a useful, reviewed, and accepted result through a workflow they can understand and resume?**

## 2. Overview

| Horizon | Intended user outcome | PRD references | Status |
| --- | --- | --- | --- |
| H1 — Useful review and acceptance | Delegate a bounded request, obtain a correction or an applied acceptance decision, and understand a blocker. | C01–C09; J01–J04, J06 | Selected V1 foundation |
| H2 — Proportionate multidisciplinary council | Have the relevant disciplines examine a trade-off without turning every task into a committee. | C10–C11, C16–C18; J05 | Selected V1 council and team capability; built on H1 |
| H3 — Collective continuity | Retrieve decisions, trade-offs, and follow-up for a new request or after an agent change. | C12; J06–J08 | Deferred beyond V1; same-mission resumption remains in H1 |
| H4 — Shared, controllable knowledge | Understand, reuse, and withdraw lessons useful to a role or project. | C13; J07–J08 | Candidate, after identifying reusable experience |
| H5 — Evaluated improvement | Observe what knowledge and process adjustments contribute, then retain or reverse those changes. | C14–C15; J09 | Candidate, after observable reuse and an actionable comparison baseline |
| H6 — Broader use cases | Transfer useful capabilities to other users, contexts, or professions without exporting private data. | PRD sections 2–3 and 7 | Exploration; requires additional product framing |

Horizons express usable capabilities, not technical layers to deliver separately. H3 extends the minimum continuity already required by H1; it does not postpone resuming a single request. Basic observation starts at H1: H5 adds learning evaluation, rather than the first measurement of costs.

## 3. H1 — Useful review and acceptance

**Value.** Reduce the owner's need to review every result without losing control of criteria or discovering that work was closed without evidence.

**Complete experience.** The owner activates supervision for a bounded request and understands its limits. An executor submits an identified result; a separate reviewer evaluates it, requests a correction, or accepts it. A new version can be reviewed again. An application failure, missing evidence, or a required human decision produces an understandable, resumable state. The owner can inspect and then suspend operation.

**Success condition.** The journey is reproduced within the declared scope, covering correction, acceptance, waiting for a human decision, and resumption. The verdict is linked to the current result and its actual effect. Available measurements make time, interventions, and consumption understandable; missing measurements remain visible.

**Boundary.** This horizon requires neither several specialists, every memory scope, nor control over external delivery. It does require validated acceptance authority within the claimed workflow. Validation following manual intervention does not demonstrate operation without intervention.

**Implementation gate.** Establish this workflow before enabling the selected H2 mechanisms. Compare overhead with simpler supervision, and fix resumption or consumption problems before expanding a particular live mission. No arbitrary number of validation campaigns is imposed.

## 4. H2 — Proportionate multidisciplinary council

**Value.** Avoid decisions that are technically defensible but offer no product value, insufficient corrections, and disproportionate scope extensions.

**Complete experience.** A justified disagreement brings in the relevant perspectives. Each opinion cites its evidence; the verdict explains which objections were upheld or dismissed and produces guidance or a decision. An appeal remains exceptional and bounded. If several executors contribute, the review covers their integrated result.

**Success condition.** Representative requests demonstrate the usefulness of distinct perspectives compared with a single reviewer, accounting for coordination overhead and remaining errors. Consensus alone is insufficient. Mandate boundaries continue to apply to both the council and appeals.

**Dependency.** H1's acceptance, correction, and escalation workflow already works. Multiple agents are not used to compensate for a basic problem in that workflow.

**Proportional use within V1.** The capability is included, but simple requests may still use one reviewer. Activate specialist opinions only for relevant domains. Qualification must demonstrate actual multidisciplinary work and an integrated team result; the two-agent path alone cannot close V1.

## 5. H3 — Collective continuity

**Value.** Avoid repeating the same decisions and losing commitments when agents or requests change.

**Complete experience.** A decision retains its rationale, scope, authority, and associated follow-up. A new agent or another council can retrieve it, apply it, or flag a contradiction. An accepted trade-off can be revisited without reconstructing the entire previous conversation.

**Success condition.** Resumed work or a subsequent request uses the appropriate decision; an outdated decision is not applied silently. The owner understands outstanding commitments without additional reconstruction work.

**Dependency.** Actual decisions and follow-up from H1 exist. H2 is not mandatory: continuity can serve a single reviewer.

**Boundary.** Preserving and retrieving a decision demonstrates continuity, not yet professional learning. This horizon does not require a universal knowledge system.

## 6. H4 — Shared, controllable knowledge

**Value.** Let a new agent benefit from relevant experience without imposing every historical exchange on it.

**Complete experience.** An experience produces a candidate knowledge item with its source and applicability conditions. It is reviewed, adopted within a scope, and then applied to another request. The owner inspects knowledge, its applications, and its limits, and can correct, suspend, withdraw, or reset it in an understandable way.

**Success condition.** Relevant knowledge is actually transferred and applied; outdated knowledge can stop influencing new work. Sharing methods does not expose project-specific information. Responsibility for adoption and maintenance remains identifiable.

**Dependency.** Continuity and understandable sources are available. An inventory without control over use does not constitute a completed horizon.

**Reason to defer.** If experience is too sparse or too specific for reuse, improve contextualization and continuity before automating the production of knowledge items.

## 7. H5 — Evaluated improvement

**Value.** Distinguish useful learning from an accumulation of rules, and adjust the process based on its effects.

**Complete experience.** The owner and council observe knowledge applied to new, comparable requests, its benefits, trade-offs, and other possible explanations. A periodic or event-driven review may try a reversible adjustment, then retain, restrict, or reverse it.

**Success condition.** A conclusion may be favorable, unfavorable, or inconclusive. It remains understandable, preserves previous results, and does not equate an improvement in one metric with overall success. Evaluation costs are included in the assessment.

**Dependency.** H4 provides observable application, and H1's initial measurements enable comparisons. No promise of general progress is based on a single successful example.

**Reason to defer.** An insufficient comparison baseline leaves a hypothesis open, without automatically multiplying evaluations or promoting knowledge as confirmed progress.

## 8. H6 — Broader use cases

**Potential value.** Allow other users and, later, other professions to benefit from capabilities whose value is supported by evidence.

Possible directions include reusable mandate profiles, other work contexts, or a better adoption experience. They do not automatically create a need for a managed service, multi-user governance, or a new execution engine.

**Condition for commitment.** An actual need is identified and the additional scope is defined in the PRD. Adoption by other software users may be explored earlier; it does not necessarily wait for H5's full learning capabilities.

**Boundary.** Generalizing a method does not automatically transfer project data or the authority of project owners.

## 9. Continuity between horizons

- Existing usable journeys remain demonstrable after each evolution; a new capability does not replace evidence of acceptance for the integrated result.
- Authority boundaries, criteria, and decisions remain retrievable as perspectives or memories are added.
- Each new horizon's contribution is identified: better decisions, better resumption, useful reuse, or evidence-supported improvement. Installed infrastructure alone does not demonstrate that value.
- PRD scenarios are reused and extended only for new or changed behavior; their presence in this document does not mean they are already automated.
- An absent need, excessive cost, or unfavorable evidence may lead to a horizon being deferred, narrowed, or abandoned with a rationale.

## 10. Reviewing the roadmap

The owner revises priorities based on outcomes from the use cases undertaken, encountered blockers, and new needs. A review may also be triggered by a significant Paperclip change or disproportionate supervision overhead. Its frequency is not set without actual usage.

The next-step decision must answer three points: which problem remains observable; which evolution adds distinct value; and which observations will support a conclusion without a disproportionate validation campaign.

Horizons have no dates. A delivery commitment is made only after the selected scope and its dependencies have been defined in the appropriate design and planning documents. A failed hypothesis must be able to shorten the roadmap, not merely extend it.
