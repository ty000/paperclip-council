# L03 governed approach and exact-result review

Council 0.5.0 owns the mandate, admissions, direction, result decisions and operator observations. Executive 0.3.0 owns one native session/send for each Council-reserved opinion. Paperclip remains unchanged. This implementation consumes Council 0.4.0 decision receipts (PR #14, `9ae33f1`) and preserves the orchestration responsibility boundary documented in PR #13.

## Prepare and execute

1. Prepare native company, project, root issue, distinct executor/final reviewer and versioned team/Council rosters using the existing APIs. Pin a mission with its criteria, responsibilities and required perspectives. Configure Council's company-specific native API secret reference for that final reviewer. Give agents positive timeouts, finite run caps and concurrency one. Start no automatic trigger.
2. The configured company owner creates governance with `POST /api/plugins/private.paperclip-council/api/companies/:companyId/l03`. The `L03CreateInput` contract in `src/l03-types.ts` binds the existing mission version, supplied context, preserved criteria, expiry and finite shared allowance. The supplied context is a user-provided snapshot; no Linear ingestion occurs. Both context hashes must match its bytes. The Council actor is the final reviewer, distinct from the executor.
3. The authenticated executor submits an approach using `POST .../l03/:missionId/commands`, `type: submit-approach`. Its `contentRef` is a native root-issue document key, and `contentHash` identifies those exact bytes. Every command carries `companyId` and the current `expectedVersion` from readback.
4. Council reserves selected required opinions with `reserve-consultation`. Each reservation binds the active approach, a pinned profile/version/instruction hash, native agent, method, criteria, evidence and expiry. The approach document key/hash/body must match the reserved context. The authenticated event handshake persists a fresh, at-most-60-second admission grant. Executive claims one physical dispatch before session creation/send. Replaying a reservation only re-emits its existing identity; it cannot create another grant or dispatch.
5. The final reviewer records `decide-approach`: proceed, revise, refuse or escalate. All required perspectives must be present. The reviewer owns the decision; opinions are not votes. Revision targets mandatory findings, creates A2 and consumes existing allowances. Proceed claims an execution attempt before one native `issues.requestWakeup` on the released root issue. Only a queued response with a native run ID advances the mission.
6. The executor submits V1 with `submit-result`, binding author, root/released issue, repository, base and candidate commits, native bundle attachment and digest. Native delivery-manifest metadata and actual attachment bytes are checked; the existing isolated Git-bundle verifier checks self-contained history and ancestry. V1 releases one root issue as its segment; arbitrary sibling issues are rejected.
7. The final reviewer records `decide-result` for that exact result. Accept/revise use the retained `executeCouncilDecision` receipt path with the decision's stable `receiptRef` as `operationId`. Refuse/escalate stop work without inventing a native application. After an observed changes-requested response, mandatory gaps permit a bounded V2 with fresh identity and review. Optional findings alone cannot require correction.

Reads: `GET .../companies/:companyId/l03?companyId=:companyId`, Council missions page, and Executive's Council observations section. A recorded direction is not approval of a result; a usable native decision response does not prove later execution started.

## Evidence syntax and identities

Native evidence references use `document:<key>#sha256:<digest>` or `attachment:<id>#sha256:<digest>`, scoped to the released issue. They are re-read and hashed before admission/application. Opinion findings may only cite reserved evidence and criteria. Result findings may only cite that result's evidence. Branch names, external URLs and free-form labels are insufficient proofs.

The supported V1 artifact set contains exactly the verified Git bundle:

```json
[{"ref":"attachment:<id>#sha256:<digest>","sha256":"<digest>","byteVerificationRef":"attachment:<id>#sha256:<digest>"}]
```

`artifactSetHash` is SHA-256 of recursively key-sorted, compact JSON of this array. Include the bundle reference in result `evidenceRefs`. The byte-verification reference is accepted only after the worker verifies those bytes; a caller-supplied label is never itself trusted evidence.

## Uncertainty and limits

Private additive migration 005 stores the governance aggregate and atomic CAS counters; migration 004 remains the sole result-application receipt journal. Approach, result and consultation counters consume one persistent mission allowance. Corrections reserve their separate limit and the next approach/result allowance when a revision is authorized, before any native corrective wake. The first result allowance is reserved before the execution wake; returning the result does not consume it twice. Restart, session replacement and new actors do not replenish them. Unknown cost exposure remains visible; observed native billing controls are not a guaranteed future-spend ceiling.

A lost execution wake response leaves its claimed attempt blocked. A failed/unknown opinion remains distinguishable from missing or completed advice. `acknowledge-uncertainty` records the company owner's note and disposition for an uncertain direction or consultation, without releasing work. Retained receipt acknowledgement/abandonment uses the existing receipt operator surface and never clears its hold.

If receipt storage succeeded but recording its confirmed observation in governance failed, the configured Council agent may issue `reconcile-result-observation`. This is strictly observational: it validates the exact stored receipt content and imports an already usable observation, without creating a receipt or sending a native mutation. A missing or indeterminate receipt does not permit another attempt. There is no automatic native-result recovery, watchdog, publication or deployment.

## Qualification boundaries

Automated domain, content, authorization and isolated PostgreSQL tests are separate from installed-host qualification. Executive's `scripts/qualify-l03-host.mjs` exercises real installed plugin paths with provider-free native test agents; it does not establish real advisor usefulness. The seven real catalogue profiles are provisioned separately and remain paused until approval of `docs/L03-REAL-CAMPAIGN.md` in Executive. Effective runtime profile/skill loading and useful model output require that campaign. See Executive's final L03 evidence report for the exact candidate hashes and unresolved proof obligations.

## Native run attribution

Paperclip authenticates the agent identity. Signed run JWTs also bind the run ID; long-lived agent API keys instead pass a caller-supplied run header into plugin context. L03 requires that ID but the SDK exposes no live-run lookup for independent verification of the latter path. Do not describe standard-key run attribution as cryptographically bound or necessarily live. Qualification must retain real native run readbacks. This host-contract limitation is separate from pinned reviewer authorization and does not require or authorize a Paperclip change.

## Terminal-event delivery boundary

Executive persists terminal session output before publishing it to Council through a freshly scoped native `agent.run.finished`, `agent.run.failed`, or `agent.run.cancelled` event. The ordering wait is bounded to two seconds and cannot send or create another session. Missing delivery leaves the required opinion absent in Council and blocks direction.

The unchanged host does not emit a plugin lifecycle event for the native `interrupted` terminal status. Its session callback can therefore persist a failed Executive contribution while Council still shows a missing opinion. This is a documented stop requiring operator inspection, not an automatically recovered state. A replay of an unexpired, unchanged reservation can publish an already-persisted terminal observation under a fresh scope without another consultation; it cannot extend expiry, replace identity, or prove success. Expired reservations and worker restarts have no guaranteed automatic observation recovery. No polling watchdog or host patch is included.
