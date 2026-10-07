# Council mission continuity

Council consumes the existing Paperclip plugin job contract (`jobs.schedule`,
`manifest.jobs`, `ctx.jobs.register`). The host runs `mission-continuity` every
minute, records its runs, prevents overlap and schedules it again after worker
restart. Council adds no process watcher or replacement scheduler.

An owner may send `configure-continuity` to a new draft ordinary v2 mission,
with `authorizeProgression: true` and an explicit two-to-seven independent N3
slot selection. The existing mandate, owner, selected slots and elapsed deadline
are pinned. The elapsed bound starts at delegation, includes setup/waiting time
and is never reset by restart. Activation remains an explicit admission command.
`suspend-continuity` retains the policy and history and blocks further departures
under that delegated policy; it does not cancel an already running model.

After activation, the job can dispatch the already reserved lead, observe its
terminal run, settle its usage and promote its already verified candidate, start
the declared independent review, reconcile existing review/correction tasks, and
reconcile a publication already authorized through `configure-delivery`.
It does not grant publication, recover a missing candidate, replace a failed
specialist, escalate a model, issue a new-attempt mandate, resume an uncertain
wake or execute a post-publication owner resume. These require their existing
explicit authority. Historical missions receive no delegated behavior.

Before a delegated command runs, Council persists the command ID and complete
payload (including expected version), together with the originating native job
run and owner delegation. Restart reuses that identity. Existing CAS, native
idempotency keys and exact readback govern effects. A stale command, a lost
unqualified response or drift of owner/mandate remains blocking; no replacement
command bypasses the original effect.

The job observes unknown costs again without launching a model. Terminal costs
of an unsuccessful lead or a lead without a verified candidate can be settled,
while the candidate stays unpromoted. Existing review settlements remain possible
after expiry; every subsequent departure checks the original deadline and the
admission ledger. Reservations remain accounting holds, not provider ceilings.

The root task receives immutable status documents for meaningful changes. The
current observation and its exact document key are retained in plugin state and
returned by the Council mission API. SDK document updates on the qualified host
omit the required base revision; Council therefore consumes SDK creation/readback
and plugin state without changing the SDK or injecting an operator credential.

The job saves a sequence and document key before creation, reads that exact key
afterwards, and confirms it in durable state. Restart finishes an outstanding
status intent before recording another. Repeated conditions create no document
or revision. A condition that recurs later receives its next sequence. Existing
status documents are never updated or overwritten. Missing confirmed documents
or mismatching bodies remain visible errors, with no replacement identity.
This is task-visible status, not an email, push or Slack notification. A failed
status read/write is reported as a failed native job without starving other
missions; a status failure does not authorize any additional provider departure.

The job uses a dedicated Council database scan, separate from the 50-row dashboard
list. Up to 200 delegated missions are supported per pass. Above that bound it
stops visibly rather than silently dropping older missions. Task intake, project
mandates and variable task trees remain separate issues (#50 and #51). PR contract
and final child/parent delivery closure remain #52 and #53.
