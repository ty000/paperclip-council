# N2 intermediate ordinary-task feasibility

2026-10-04 — **PASS for the bounded provider-free structural feasibility claim.**

The proposed sequence works through real Paperclip ordinary tasks and real
`codex_local` CLI runs: technical review V1 → admission → independent Council V1
`changes_requested` → terminal run and token settlement → admitted developer
correction → technical review V2 → admission → Council V2 `accepted` → terminal
run and settlement. All five runs succeeded, with no cancellation or extra run.

## Findings and limits

1. **A controller and G4 adaptation remain necessary.** The sole dispatcher is
   this explicit owner-assisted probe. It validates the public run identity
   through `id`, `companyId`, `agentId`, and `contextSnapshot.issueId`, requires
   successful terminal status and positive `per_run` token usage, then calls the
   unchanged Council `settleAdmission` CAS utility. CLI runs have
   `nativeIssueId=null`; the existing product `settleNativeExactRunUsage` rejects
   that identity. This probe does not qualify that helper or deliver an
   integrated production controller.
2. **Accounting is proved per run, not through the aggregate cost API.** Every
   public run readback contains input=120, cached input=20, output=30,
   `usageSource=per_run`, `billingType=subscription_included`, and
   `costStatus=unpriced`. Cached input is already included in input. Five real
   Council reservations settle at 150 tokens each, total 750, with zero remaining
   token exposure. The public issue `cost-summary` returns zero tokens and zero
   cents. That zero is not evidence of zero monetary consumption or of successful
   aggregate G4 reconciliation. Provider invoice/dollar accounting is unproved.
3. **The topology deliberately avoids implicit dispatch.** Five parentless
   tasks have no dependency relations, no execution policy, and no native review
   state. The absence of recovery/extra runs is established for this topology,
   not for a dependency-driven design. References in descriptions and comments
   bind the exact candidate and technical review to the Council decision.
4. **Judgment and candidate content are synthetic.** A deterministic executable
   replaces Codex/provider execution and emits the CLI JSONL protocol. The
   adapter, parser, heartbeat lifecycle, APIs, run persistence, and admission CAS
   are real. The fixture developer makes a real Git commit in an owned temporary
   repository. No model judgment quality, production N2 acceptance state, native
   runner, LIVE execution, or N6 qualification is claimed.

## Observed evidence

Canonical artifact: `artifacts/n2-intermediate-development-4.json`.
SHA-256: `b976650abebe8ee1e063d9d48185be766eaa5a5c657b82f50981b44bb2697be5`.

| Stage | Run ID | Public report | Run | Settled tokens |
| --- | --- | --- | --- | ---: |
| Technical V1 | `d10547a8-be14-47b2-9870-710a528643d2` | correction_required | succeeded | 150 |
| Council V1 | `6fb94e52-cbf9-4178-811f-f90ee73af778` | changes_requested | succeeded | 150 |
| Developer correction | `4068b524-2d40-4a63-bf05-cdde1621fb8d` | one Git commit | succeeded | 150 |
| Technical V2 | `8b7f22fd-4568-4c9e-831c-176ef5d830be` | pass | succeeded | 150 |
| Council V2 | `96cae130-59b4-4935-a61f-b990bea597e3` | accepted | succeeded | 150 |

V1: `b010d28b2147428599607b02e7b5a7739380931c`.
V2: `351232f47e49b38535c5c2b51852f9b826398944`, whose sole parent is V1.
The artifact retains the actual Git diff, identities, full public run readbacks,
public comments, CLI argv, task states, chronological events, and reservations.
The temporary Git repository was removed with its owned runtime; replay creates
equivalent new fixture commits and new run IDs.

For each stage the report is observable while the run is still `running`; both
premature settlement and admission are rejected while its reservation is held.
The controller then releases the fixture process, observes `succeeded` and its
usage, closes the task, and settles before creating/admitting the next task.
Closing Council V1 as `done` preserves `changes_requested`; task completion is
therefore distinct from candidate acceptance. No active run is reassigned.
Every comment's server-recorded `createdByRunId` and `authorAgentId` matches its
expected run/actor (also confirmed independently from the saved artifact).

## Replay and provenance

From the authorized Council worktree, with the existing dependencies and clean
qualification host at `61b3fd57a695614dc4a37e2303f426a34a9795cf`:

```sh
node_modules/.bin/tsx docs/reviews/n2-intermediate/probe.ts artifacts/n2-intermediate-replay-UNIQUE.json
```

The observed successful command used `artifacts/n2-intermediate-development-4.json`
and exited 0. Output paths must be new. Council base was
`84d79cd7779de706e99f4bea1df45743cf3186cb`, branch
`codex/council-n2-intermediate-proof`. Exact source SHA-256 values:

- `fixture-cli.mjs`: `d740fce9deda594e40f1568f9e66a2530859caad1e62ae3a3ca8b4f5a7a4a6fa`
- `probe.ts`: `177c8cf69ded31ee7d13961fc9fc3971d78f464a1e4fde364b65a1530e34ee6f`

Only isolated owner identity/company setup uses fixture DB inserts. Business
issues, comments, statuses, wakeups, heartbeat runs, and token usage pass through
real APIs/services; no synthetic heartbeat/cost rows are inserted. The fixture
handshake file controls observation timing, while reports consumed by the
controller and Council are read through the public comments API. The context
bridge is local test scaffolding; no plugin installation/configuration or secret
resolution behavior is qualified by it.

Setup attempts 1–3 remain separate evidence: dependency resolution, missing
ephemeral agent JWT, then missing responsible owner membership. They are not
successful scenarios. Attempt 4 contains the first complete passing path. The
setup failures showed that the embedded shutdown helper can reset a failed
process's exit status; consumers must inspect the JSON `outcome` and cleanup
fields, not infer success solely from exit 0.

Cleanup readback confirms the ephemeral DB, HTTP server, and owned runtime were
removed; no fixture/probe/PostgreSQL process remained. Host tracked source is
unchanged. Saved evidence contains no JWT, API-key value, or private-key marker
in the scoped pattern scan. Independent targeted review found no blocker for
this narrow claim; its nonblocking suggestion was to add an explicit assertion
for comment `createdByRunId` on a future revision (already observed equal in all
five saved comments). No broader qualification suite was run.
