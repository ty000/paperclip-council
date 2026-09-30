---
name: council-review
description: Review an exact Paperclip Council submission as a final reviewer or attributed domain specialist, separating evidence-backed opinion, accountable verdict, recorded decision and confirmed native effect. Use for assigned Council review rounds; not for executor self-review, generic code review, or authority-free approval.
---

# Council review

Review one identified submission against one pinned mandate and evidence revision.
This method structures judgment; it grants no permission, tool, route, identity
or acceptance authority.

## Inputs

Require:

- mission/review-round reference and reviewer mode: `final_verdict` or
  `specialist_opinion`;
- exact submission, evidence and mandate revisions;
- recorded authors/Integration Lead and active participant/slot;
- applicable criteria, owner-reserved decisions and operating limits;
- prior findings, corrections, owner decisions and required opinions;
- supported output and readback surface for the current mission.

Stop before judgment if independence, candidate identity or decisive evidence
cannot be established. A missing skill mount is also explicit: use the minimum
method in the role charter only when it is self-contained there.

## Method

1. Confirm that the current identity is eligible and that every artifact refers
   to the same submission/evidence/mandate tuple. A specialist uses its own slot;
   only the assigned final reviewer may formulate the root verdict.
2. Derive the applicable checks from the mandate and task. Do not import a full
   QA, design or security checklist without a concrete need.
3. Inspect the candidate and evidence. Preserve still-valid evidence; run only
   authorized proportionate checks needed to resolve material risk.
4. Record each finding with an ID, applicable criterion or risk, evidence and
   its limits, concrete consequence, smallest sufficient correction or missing
   information, and class: `blocking defect`, `decisive uncertainty`, or
   `deferrable improvement`. Preference alone is not a defect or new criterion.
5. In `specialist_opinion` mode, return an attributed opinion on the assigned perspective:
   `support`, `changes_requested`, or `insufficient_evidence`. Do not close the
   root issue or use final-reviewer credentials.
6. In `final_verdict` mode, keep the original attributed specialist positions
   visible and reconcile every material objection as upheld with correction,
   resolved by evidence, rejected with reason, or escalated. Do not rewrite an
   opinion retrospectively to manufacture consensus, and never treat a missing
   required opinion as agreement. Decide by evidence and authority, never
   automatic majority. Return `approved`, the smallest sufficient
   `changes_requested`, or an explicit evidence/owner waiting state. A waiting
   state is not an approval verdict, and only this mode may formulate or apply
   the root verdict.
7. If an authorized supported decision mutation is performed, separately record
   the formulated verdict, persisted decision identity, requested effect and
   read-back native effect. A timeout or lost response remains unknown until
   reconciled; do not repeat blindly.

## Output

Include exact revision tuple, identity/mode, independence statement, scope,
finding records, rationale, unresolved questions and next actor. A specialist
opinion also carries `opinionId`, perspective and criterion-linked evidence
references; identity and run attribution come from authentication, not from a
caller-supplied body. Specialists address their opinion to the final reviewer.
The final reviewer preserves the original attributed opinions, includes every
material objection's disposition and reports verdict, decision record and
effect as separate states.

## Stop conditions

Stop on an author/reviewer conflict, mismatched revisions, missing decisive
evidence, unsupported route, wrong active participant, owner-reserved decision,
unresolved application outcome, exhausted operating envelope, or unknown
available allowance/remaining exposure for a new launch. Name the preserved
state and next supported action. Unknown or unpriced usage is never zero; do not
start a new check, model/provider call, correction or appeal that requires a
reservation while either task or shared-period admission remains unknown.

New result bytes require a new review. New evidence can trigger a bounded
reassessment but does not silently reaffirm prior opinions. Correction, appeal
and resume keep the same overall limits; unknown usage is not zero.

## Selection cases

- Explicit match: “Use `$council-review` for the assigned final review round.”
- Implicit match: “You are the Product specialist for this Council submission;
  return an attributed opinion to the final reviewer.”
- Near miss: “Review this unsubmitted pull request and fix the code you dislike.”
  Use an ordinary code-review/remediation method instead; do not select this
  skill to manufacture Council authority or self-acceptance.
