
## Explicit variable hierarchy (0.7.13)

Project policy may explicitly declare `hierarchy: { protocol: "council-hierarchy-v1", maxContributions: 1..12, execution: "sequential", adoptExistingChildren: true|false }`. Absence preserves the historical exact-two contract and its serialized evidence. New roots without children allow a bounded variable plan. Existing waiting descendants are adopted only with explicit authority: each leaf has an eligible pinned contributor, a nonempty result and an immutable `council-work` JSON document containing `ownedPaths` only. Paths stay within the project mandate. Native dependencies remain authoritative; cycles, pending external dependencies, active/historical tasks, overlapping ownership, depth beyond eight levels or more than 32 descendants require an owner decision.

Council pins every descendant and relation, orders leaves by their native predecessors, and serializes writes and exact terminal settlement. Existing descriptions and parentage are retained. `materialize` on an adopted leaf writes immutable `council-execution-<missionId>` guidance; it creates no replacement child. A parentless operational coordination task inherits the original workspace and uses the same lead reservation, avoiding the root's pending dependencies without removing them or spoofing a wake reason. Root and intermediate parents remain pending after candidate acceptance/publication until delivery proof closure is implemented and qualified (#53).

A source/document/relation/assignment change suspends new departures. No implicit upgrade applies to an existing mission or intake. To reconsider an intake that asked a question before any preparation, first explicitly include its existing root in the new policy. Owner GET of this mandate route with `rootIssueId` returns its exact intake version. POST `command: "rebind-unstarted-task"`, `commandId`, `rootIssueId`, `policyRevisionId`, `expectedIntakeVersion` and `authorizeRebind: true` changes only an intake with no create payload, snapshot, plan or transition command. Mission identity, old questions and revision history are retained; prepared or uncertain effects refuse rebind.

Qualification distinguishes deterministic model/GitHub content from real native task relations, SDK effects, cron, run accounting, worker restart and artifact verification. No provider campaign is implied.

## Explicit publication and feedback contract (0.7.14)

The optional `publication.contract` is pinned on project intake and requires
`protocol: council-pr-contract-v1`, `draftOnly`, matching `result: draft-pr | reviewed-pr`,
`feedback: review-and-correct`, and 1–20 exact `requiredChecks` names. Existing
policies without this field retain their historical behavior. The contract
never delegates merge or deployment. The publisher creates with `gh pr create
--draft` when required; Council independently checks the native GitHub object's
URL, repository, refs, candidate SHA and draft state. A violation remains
visible and cannot satisfy delivery.

Run `scripts/operations/github_feedback.py` only inside the already admitted
publisher run, inheriting its GitHub environment. It reads complete bounded
checks, combined statuses and PR reviews, then re-reads the PR to exclude a
mixed head cohort. Missing permissions, pagination overflow, ambiguous check
names or changed identity stop the read. Council stores `publisher_run_report`
provenance: these are actor observations, not independent permission or CI
attestations. Native PR identity/head readback remains separate. Operator
booleans cannot replace the new report contract.

Green CI with `CHANGES_REQUESTED` never qualifies delivery or merge readiness.
The installed continuity job pins the report and creates a fresh evidence tuple
for the unchanged candidate. The previously selected independent specialties
advise again; Council alone judges material findings. A material rejection can
consume the mission's existing single cumulative correction, without resetting
admission, history or receipts. The lead corrects in a distinct admitted native
operational task, preserves the original plan, verifies the amended integration
candidate, obtains fresh N2/N3 acceptance, then the publisher updates the same
PR using the explicit old-head lease. Draft state remains pinned. Exhausted
corrections, divergent native readback and uncertain effects stop explicitly.

A native GitHub object may retain the old head until its refresh backoff expires.
The already admitted publisher may wait at most 305 seconds within its original
run/deadline, refresh once, and obtain fresh feedback after exact-head resolution.
It cannot launch an extra probe run or inject operator credentials. If this
bounded path is unavailable, Council retains the intent and exposes the blocker.

`publicationReady` means the delegated PR result and exact settled acceptance
have been observed. `mergeReady` remains false for a draft PR; neither value
authorizes merging. The provider-free installed qualification uses real native
CLI runs, tasks, accounting, scheduled jobs and restart, with deterministic
model content and simulated GitHub transport. It does not qualify live model
judgment or an actual publisher's GitHub permissions.

GitHub source contracts verified 2026-10-07:
[PR reviews](https://docs.github.com/en/rest/pulls/reviews),
[check runs](https://docs.github.com/en/rest/checks/runs),
[gh pr create](https://cli.github.com/manual/gh_pr_create).
