# N3 independent preparation checkpoint

This branch prepares the independent part of N3; it does not close N3.

## Boundaries and contract snapshot

- Base: `origin/main@d4d4a6032a96b6bd1e9c5cb6b9b754b05f08f28b`, containing PRs #19 and #20.
- N2 snapshot inspected: `a7760eb4a7088377fe447611a7176144d8a6baab`.
- The N3 subject port mirrors that snapshot's immutable submission identity:
  submission ID, candidate commit, bundle SHA-256, evidence revision and mandate
  hash. N3 imports no N2 module and changes no common mission, command,
  admission, receipt, worker, manifest, route or migration file.
- The inspected N2 snapshot is a draft branch that diverges before the current
  main and is not merged. Its final reconciled checkpoint is therefore not yet
  a consumable integration base. A future adapter must consume the merged N2
  type at its exact SHA and map its active submission into `N3CandidateSubject`.
- `migration_prewrite`: not applicable. This preparation adds pure contracts,
  instructions and unit tests only; it writes no installed data.

## Prepared behavior

`src/n3-opinions.ts` provides a pure candidate-bound round for two to seven
selected specialist perspectives. It records host-authenticated specialist and
run attribution separately from opinion content, rejects author/reviewer
conflicts, requires the selected mandatory opinions, and forces the Generalist
Reviewer to dispose of every material objection. Old-candidate opinions cannot
enter a new round.

The representative unit scenario selects Product and Security. Product supports
the user outcome; Security raises an evidence-backed project-isolation
objection; the final reviewer preserves both positions and requests the smallest
correction. This is package evidence only, not a native Paperclip execution.

## Remaining integration and native qualification

After N2 is reconciled and merged:

1. consume its merged SHA and confirm the active submission mapping;
2. add N3 state to the N2-owned mission CAS/command path with explicit common-file
   ownership;
3. create/read the selected native child review tasks and bind authenticated
   specialist issue/run identities;
4. connect the synthesis to the sole final-reviewer verdict/application path;
5. expose candidate, attributed opinions, objection dispositions, missing slots,
   uncertainty and next actor in the supported inspection surface;
6. run a separately authorized native scenario with at least two distinct
   eligible specialists on the same corrected candidate, then read back the
   specialist work, final synthesis and actual decision effect.

The native scenario must also demonstrate that a missing required opinion
waits, an author cannot provide independent review, and an opinion for the prior
candidate does not validate the corrected candidate. Simulations and unit tests
do not close these criteria.
