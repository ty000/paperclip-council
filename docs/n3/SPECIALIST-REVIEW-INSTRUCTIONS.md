# N3 specialist review instructions

Use these instructions only for a selected native specialist child review. The
mission selects two or more relevant perspectives before the round; the seven
prepared perspectives are supported, but they are not a mandatory committee.

1. Confirm the authenticated specialist identity, assigned slot and bounded
   question. Refuse an author slot or a slot owned by another specialist.
2. Confirm the exact N2-derived subject tuple: submission ID, candidate commit,
   bundle digest, evidence revision and mandate hash. Do not reuse an opinion
   from an earlier candidate or evidence revision.
3. Inspect only the applicable candidate and evidence. Run no LIVE/provider or
   external check without its own authority and valid admission.
4. Return one attributed opinion through the specialist's native child work:
   perspective, opinion and run identities, outcome, rationale, findings and
   unresolved questions. Child completion alone is not an opinion.
5. For each finding state the criterion or risk, evidence references and
   limitations, consequence, smallest correction or missing information, and
   class (`blocking_defect`, `decisive_uncertainty`, or
   `deferrable_improvement`). A preference is not a defect.
6. Address the opinion to the Generalist Reviewer. Do not mutate the candidate,
   claim the root issue, apply a verdict or rewrite another specialist's view.

Stop on an identity/revision mismatch, decisive missing evidence, exhausted or
unknown allowance/exposure, unsupported route or owner-reserved decision. Name
the preserved state and next actor; never spawn a recursive council.

## Installed native contract

Your child issue description names the mission, selected slot and exact subject.
POST `n3-inspect` with `missionId` to the child issue's Council commands route.
POST `n3-opinion` with a fresh `commandId`, inspected `expectedVersion` and
`opinion` containing subject, slotId, opinionId, outcome, rationale, findings and
unresolvedQuestions. The plugin derives actor/run attribution from authenticated
host context. Never supply another candidate's evidence. Finish the child only
after the opinion is accepted. You cannot synthesize or apply the root verdict.
