# Paperclip Council — G3/G4 owner decisions

Date: September 30, 2026; documentary clarification October 1, 2026. Status: owner decisions accepted; technical qualification open.

Authority: the owner accepted the prudent G4 recommendation ("oui je suis ta recommandation"), then accepted the minimal G3 lot, including a targeted Paperclip change if existing interfaces are insufficient ("oui j'accepte"). The owner also allowed existing improvement ideas to be recorded in the roadmap. These decisions are recorded from the current discussion, not inferred from a test or another agent's report.

Product authority is [PRD 0.4 §6.3](PRD.md#63-initial-delegation-profile). The [TAD](TAD.md) specifies derived contracts and the [sprint plan](SPRINT-PLAN.md#2-decisions-and-blocked-capabilities) preserves dependencies. This record does not claim code changes, deployment, or a passed runtime gate.

## DEC-G4-01 — Prudent monetary control with mandatory operational limits

**Accepted.** Replace the absolute monetary-cap interpretation with admission control: jointly reserve task and shared period allowance before launch, enforce configured parallelism and retry/correction limits, and block new launches when available budget or remaining exposure is unknown. Corrections, appeals and resumption consume the same envelope. Unknown/unpriced usage is visible, never zero.

**Accepted residual risk.** Work already committed can generate an overrun despite stopping new admissions. This is not permission to knowingly launch beyond the allowance, reset reservations, hide late usage, or treat cancellation as proof of zero remaining charge. An estimate or reservation is not a guaranteed provider charge ceiling.

**Still required before affected activation/dispatch.** Qualify the applicable measurement/reservation contract through the supported runtime: competing missions cannot overbook admission allowance; operational limits reject further launches; crash/restart retains unsettled reservations; late/unknown usage blocks new admission and is reconciled. A purely mocked counter is insufficient. If the selected runtime cannot supply the information needed by this policy, dispatch remains blocked even though the owner accepted monetary overrun risk.

Amounts, period boundaries, measurement sources and the treatment of reservation estimates remain explicit activation inputs. No values or permission for real provider calls are supplied here. Prior owner decisions for infrastructure cost changes in either direction, essential uses and the p95 mandate remain unchanged. Owner/mandate/submission-bound human continuation remains a separate unqualified `DEP-OWNER` requirement planned in L3.

### October 1 clarification — token pilot and monetary policy

[PR #15](https://github.com/ty000/paperclip-council/pull/15) implements `paperclip-orchestration-tokens-v1`: explicit token allowances/reservations, initial usage/exposure with named provenance, and terminal native usage, while monetary cost may remain `unpriced`. Its report records one authorized campaign, not a successful N1 exit. These are candidate-specific observations until merge, not a claim of N1 LIVE completion.

Token admission and monetary admission are distinct claims. A token allowance does not establish available currency budget or priced remaining exposure. Authorization for a bounded pilot does not by itself replace DEC-G4-01; acceptance of a token-only profile as a substitute would need an explicit scope decision. Report the measured unit, source, reservation assumptions and monetary unknowns separately. This clarification neither supplies that policy change nor demands a new billing engine.

**N1-only owner scope decision, October 1, 2026.** For N1 only, the owner accepts `paperclip-orchestration-tokens-v1` as the bounded pilot admission control. This decision permits the token-only profile despite potentially unpriced monetary cost, without constituting general qualification of DEC-G4-01 or permanent provider authorization. The profile's allowance, reservations, usage and exposure fields are denominated in tokens. Initial usage/exposure values require a named company/period readback or bounded fresh-period attestation; configured `known/0` never means zero monetary exposure. Monetary cost remains separately visible as `unpriced` when the native runtime cannot price it. Every provider campaign still requires its own explicit authorization and numeric activation inputs.

Use the smallest supported operating profile. Prudent reservation estimates need not predict exact future provider charges; retain the accepted overrun risk and stop rules. If the existing native interfaces cannot qualify the required policy, identify the missing fact and smallest owner arbitration instead of silently weakening the rule or expanding implementation into general financial control.

## DEC-G3-01 — Historical native readback direction (superseded for V1)

The paragraphs below record the earlier September 30 decision. The later priority decision [DEC-G3-02](#dec-g3-02--plugin-only-receipts-and-preserved-uncertainty) supersedes their host-write authorization and automatic-recovery requirement for V1; they are not current implementation instructions.

**Accepted.** A bounded G3 qualification/implementation lot may inspect the existing supported Paperclip API/SDK and, only if insufficient, make the targeted host change required to expose decision readback. This host work is isolated from L2 and has its own base, review and runtime qualification. It is not permission to change unrelated host behavior or to deploy a durable instance.

**Minimum contract.** A company-scoped, authorized read identifies the actual native decision by ID/correlation and exposes the actor/run, body, stage/round, outcome and applied effect needed to match the persisted Council intent and its exact submission. Reuse an existing supported surface if it satisfies this contract. A direct database read by the Council plugin is not the production substitute.

**Required proof.** After a request succeeds natively but its response is lost, Council can identify the matching decision and record the confirmed effect without issuing a second mutation. Cover late completion/restart and reject mismatched attribution/result or policy drift. Missing or inconclusive evidence stays unknown; absence alone does not authorize retry. Manual intervention remains explicit when safe recovery cannot be established.

No distributed exactly-once guarantee, broad history API, native idempotency service, billing engine or new scheduler is added to this minimum. If a host/SDK change is needed, identify and qualify the resulting versions; the existing `61b3fd57a695614dc4a37e2303f426a34a9795cf` / `2026.916.1` evidence does not qualify new code.

## DEC-G3-02 — Plugin-only receipts and preserved uncertainty

**Accepted, September 30, 2026 (later priority decision).** Use only existing Paperclip APIs. V1 must not depend on host changes or upstream PR acceptance. Persist operation identity, exact content/target and actor/run before atomically claiming one attempt. Duplicates read that receipt; conflicting content is refused. Preserve usable native responses and their real references without claiming later execution.

Lost, malformed or ambiguous responses and crashes after a possible send remain indeterminate across restart. Block dependent Council actions, including equivalent submissions with a new key. No blind resend, privileged SDK fallback, core database workaround or fabricated native confirmation is allowed. An authenticated configured owner may acknowledge or abandon with attribution; this neither proves success nor releases the uncertainty hold. Nominal responses remain usable without requiring a human for every verdict.

The [receipt contract](DECISION-RECEIPTS-V1.md) replaces mandatory D-H for this V1 slice. Qualify actual private persistence/concurrency, nominal response handling, faults, restart, authorization and operator visibility. Historical G3 failures remain historical failures under their original contract. Independent attribution, exact subject, permissions, operational/budget limits and distinct opinions remain mandatory; this decision does not complete L03 or V1.

## Status and next actions

| Item | Decision status | Technical status / next action |
| --- | --- | --- |
| G4 budget policy | Accepted, PRD revised; bounded token-only exception accepted for N1 | N1 may qualify only its explicit token pilot; general monetary admission remains open and no provider run is permanently authorized |
| G3 V1 receipts and uncertainty | DEC-G3-02 supersedes mandatory host readback | Qualify plugin-private attempt persistence, no blind resend, durable hold and authenticated human handling |
| Owner-bound continuation | Existing requirement retained | Open: bind authoritative owner, mandate/submission and actual native response in L3 |
| L1/L2 | No completion granted by these decisions | Retain active-mission proof and remaining L2 acceptance criteria; draft persistence alone does not close them |
| Future stronger guarantees | Roadmap proposals permitted | [R-G4-01, R-G3-01, R-OPS-01](ROADMAP.md#10-candidate-improvements-following-g3g4) are deferred candidates, not new V1 obligations |

G3 and G4 qualification can proceed independently with separate write ownership. G4 gates L2 execution; G3 gates L3 application traceability and safe uncertainty handling under DEC-G3-02. Historical L0/S1/L2 reports retain the verdict and contract assessed at their exact candidate; this decision record must not rewrite old evidence as a new PASS. Numeric activation inputs, publication and live activation are separate from these product/technical decisions.
