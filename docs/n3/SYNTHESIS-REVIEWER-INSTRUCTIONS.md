# N3 synthesis reviewer instructions

For `ordinary-cli-v1`, follow the generated task/inspect instructions and the
[ordinary CLI contract](ORDINARY-CLI-REVIEW.md). Submit the opinion or
`ordinary-verdict`, then finish normally; the plugin records the accounting wait
and closes tasks after terminal settlement. The native-card section below applies
only to persisted historical runner missions.

The assigned Generalist Reviewer is the sole synthesis and root-verdict owner
for this round. Specialists advise; favorable opinion count is never authority.

1. Confirm reviewer independence and the exact candidate/evidence/mandate tuple.
2. Check every required slot selected before the round. A missing required
   opinion is waiting, replacement or explicit reconfiguration—not agreement.
3. Preserve each original attributed opinion and visible disagreement.
4. Give every material objection exactly one reasoned disposition:
   `upheld_with_correction`, `resolved_by_evidence`, `rejected_with_reason`, or
   `escalated`. Evidence resolution names its evidence; rejection does not edit
   the specialist's original record.
5. Formulate `approved` only when no objection remains upheld or escalated;
   formulate `changes_requested` for an upheld correction or a concrete defect
   you independently discover. Use `waiting` for an unresolved factual or
   authority question, including one absent from the specialist opinions.
   Explain your independent finding and the required action in the bounded
   `rationale`; favorable specialist opinions do not constrain your judgment.
6. Keep the reasoning synthesis, persisted decision and confirmed native effect
   separate. N3 preparation does not itself authorize or prove application.

A changed submission starts a fresh candidate-bound round. Do not automatically
carry opinions or acceptance forward. Do not launch appeals or other councils;
an unresolved question names its next human/native actor.

## Installed native contract

The native card is sourced from the final transmission after specialist usage
settlement. Confirm its N2 handoff, inspect the root, then POST `n3-synthesize`
with missionId, fresh commandId, expectedVersion and `synthesis` (exact subject,
verdict, rationale, exhaustive material-objection dispositions). A `waiting`
verdict also requires `nextActor`; preserve the card and report the blocker.
Only an approved/changes_requested synthesis from this authenticated reviewer
run permits the matching existing decision command. Finish after the native
decision. Never create another Council or bypass a stale/missing opinion.
