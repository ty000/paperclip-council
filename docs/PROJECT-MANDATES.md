
## Explicit variable hierarchy (0.7.13)

Project policy may explicitly declare `hierarchy: { protocol: "council-hierarchy-v1", maxContributions: 1..12, execution: "sequential", adoptExistingChildren: true|false }`. Absence preserves the historical exact-two contract and its serialized evidence. New roots without children allow a bounded variable plan. Existing waiting descendants are adopted only with explicit authority: each leaf has an eligible pinned contributor, a nonempty result and an immutable `council-work` JSON document containing `ownedPaths` only. Paths stay within the project mandate. Native dependencies remain authoritative; cycles, pending external dependencies, active/historical tasks, overlapping ownership, depth beyond eight levels or more than 32 descendants require an owner decision.

Council pins every descendant and relation, orders leaves by their native predecessors, and serializes writes and exact terminal settlement. Existing descriptions and parentage are retained. `materialize` on an adopted leaf writes immutable `council-execution-<missionId>` guidance; it creates no replacement child. A parentless operational coordination task inherits the original workspace and uses the same lead reservation, avoiding the root's pending dependencies without removing them or spoofing a wake reason. Root and intermediate parents remain pending after candidate acceptance/publication until delivery proof closure is implemented and qualified (#53).

A source/document/relation/assignment change suspends new departures. No implicit upgrade applies to an existing mission or intake. To reconsider an intake that asked a question before any preparation, first explicitly include its existing root in the new policy. Owner GET of this mandate route with `rootIssueId` returns its exact intake version. POST `command: "rebind-unstarted-task"`, `commandId`, `rootIssueId`, `policyRevisionId`, `expectedIntakeVersion` and `authorizeRebind: true` changes only an intake with no create payload, snapshot, plan or transition command. Mission identity, old questions and revision history are retained; prepared or uncertain effects refuse rebind.

An intake retained with `repository_occupied` never resumes merely because the other campaign releases the repository. Its question's `confirmed` flag records publication only. The current company owner reads the retained intake through the same GET route, then POSTs `command: "resume-repository-intake"`, a stable UUID `commandId`, the original `rootIssueId`, current pinned `policyRevisionId`, `expectedIntakeVersion` and `authorizeResume: true`. This records an explicit recovery decision and permits the existing job to recheck the original request; it does not launch an agent, change mandate, replace identities or reset budgets. The original command replays without another decision. If the repository is still occupied, the request is held again and replaying the previous command cannot release that new hold.

For a `milestone-fixed-v1` campaign, the resume command additionally requires
`reason` (1–1000 characters after trimming). Council retains the blocking question,
owner, answer and consequences, and includes the decision that actually releases
the intake in the first campaign plan. Its Linear acknowledgement is required
before departure. Earlier attempts remain in Paperclip history. Historical fixed
resumptions without a retained decision are refused; an already emitted plan is
not silently rewritten to adopt a later decision. Ordinary Todo intake retains
its historical command contract.

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


## Proof closure (0.7.15)

An explicit project `completion: { protocol: "council-proof-close-v1", result: "draft-pr" }` authorizes proof closure for a sequential adopted native hierarchy (1–12 contributions). `draft-pr` or `reviewed-pr` must match the explicit PR contract; `accepted-candidate` requires `publication: null`. Absence preserves historical behavior. Installation, merge, deployment and Linear synchronization are separate results and are never inferred.

The lead pins the full `sourceBaseCommit` in `plan`. The contributor's generated command uploads a self-contained bundle to its own admitted child issue, using isolated UUID refs. Council verifies digest, attachment binding, bounded Git integrity/history, nonempty changes and exact ownership before recording. The helper retains a private local one-shot intent before attachment/report effects and stops on refusal or uncertainty without uploading another attachment or replacing the request. Council parks the child blocked until its exact attributed admitted run succeeds and known terminal usage settles with zero remaining exposure. Sequential successors and common integration require that observed proof closure.

The existing native continuity job consolidates all child proofs, the current accepted candidate, independent Council decisions and the exact authorized delivery with settled mission costs. It writes one immutable proof document on the original root, closes necessary parents bottom-up only when native children and blockers finish, then confirms one agent-attributed native final comment. Lost responses are reconciled under the original identity; an unobserved claimed notification remains unknown without another send. Candidate/evidence drift cannot consume the retained closure. A confirmed closure preserves its historical receipt without a new provider run or retroactive dependence on an expired GitHub observation.

A draft PR proves only an expressly authorized draft result. Publisher GitHub reports remain attributed actor reports, not independent attestations. The provider-free installed scenario exercises three existing children, a dependency, one material correction, independent reviews, the same draft PR, worker restart, original parent closure and one native notification with no manual Codex task transition. Deterministic model content/usage and GitHub transport do not qualify real agent judgment or effective real publisher rights. The actual recipe installation does not configure or activate a project mandate.
