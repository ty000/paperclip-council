# Native Council agent variants

Implementation checkpoint, 2026-10-05. Base: `ef817493bf99606d324cac6ef572c23de839a9ab`.

## Scope and authority

The owner approved a Council-only implementation using preconfigured native agents,
without modifying Paperclip or its SDK. The existing standard CLI path is the
target. Historical missions and the experimental runner path remain unchanged.
The local implementation and offline checks do not authorize installing the
plugin, provisioning agents on an active instance, or making model calls.

The new worktree is `/home/davy-lp/.codex/worktrees/council-native-variants/paperclip-council`,
branch `codex/council-native-variants`. The remote main reference matched the base
above and the exact-head Git base gate passed. Existing sibling worktrees are
outside the write scope. Dependencies were installed from the unchanged lockfile.

## Approved contract

| Family | Default | Allowed higher profiles |
| --- | --- | --- |
| Synthesis / extraction | Terra low | Sol medium |
| Implementation | Sol medium | Sol high |
| Diagnosis / correction | Sol medium | Sol high, Astra high |
| Review | Sol medium | Sol high, Astra high |
| Test / validation | Sol medium | Sol high |
| Design / arbitration | Sol medium | Sol high, Astra high |
| Orchestration / supervision | Sol medium | Sol high, Astra high |

Terra = `gpt-5.6-terra`; Sol = `gpt-5.6-sol`; Astra = `gpt-6-astra`.
These are approved policy IDs, not proof of model/account availability.

A logical agent retains its responsibilities and independence identity across
physical variants. Each attempt binds a preexisting physical variant, profile,
revision and rationale before any wake. User choices take precedence; otherwise
the lead selects the lightest sufficient allowed profile. The first lead uses
the orchestration default unless the owner supplies an explicit choice.

A task pins the mapping at its first launch. Later catalogue revisions may affect
unstarted tasks of eligible missions. One ascent is shared by the task and is
available only on an independently authorized new attempt. Initial selection for
another intervention does not consume it. Replay retains its binding. Technical
failure or uncertain effects never authorizes a replacement, another key or a
new intervention identity. Existing admission and retry controls still apply.

There is at most one explicitly declared unavailability alternative per profile,
usable only after confirmed unavailability before execution. No alternatives are
invented. Unexpected configuration drift blocks and shows expected/observed;
repair is explicit. Planned changes use new variant revisions, retaining old
ones while engaged tasks depend on them. No automatic reset or retirement.

Only Council catalogue templates are in scope. Dedicated setup prepares variants;
there is no per-task agent creation or arbitrary agent cloning. Variants share
their role instructions, skills and permissions. Unselected variants must not
execute periodic background work. Two variants of one logical identity never
constitute independent author and reviewer.

An ascent supplies the available public detailed history of its intervention,
including provenance, cutoff and explicit gaps. Private provider traces, other
missions and protected independent opinions are excluded. Oversized collected
history is preserved in indexed files for progressive reading, not replaced by
an automatic summary. Missing data is acceptable only when prior execution state
and effects remain known. Preserved content does not mean content actually read.

Estimates use comparable history, otherwise `non calibré`; tokens and elapsed
duration remain indicative and independent of admission. Record execution
measurements and task totals, with input/output separation where available.
The UI is consultative: catalogue, variant readiness/drift, selected profile,
rationale, revisions, substitutions and available measurements. Reuse the same
format and validators for the future editor without implementing its form now.

## Acceptance and evidence register

| ID | Required outcome | Required evidence |
| --- | --- | --- |
| V01 | Revisioned seven-family catalogue and validation | Valid/invalid configuration tests |
| V02 | Native setup, fixed profiles and drift refusal | Public SDK contract and offline setup/readback tests |
| V03 | All standard launch paths bind before wake | Lead, contributor, specialist, reviewer, correction, publisher and coordination tests |
| V04 | Stable logical authority and independence | Authentic actor/run and cross-variant conflict tests |
| V05 | Pinned revisions, replay, one shared ascent, bounded fallback | Concurrency and failure-path tests; no replacement on unknown effects |
| V06 | Detailed public history with explicit gaps/indexed overflow | Collection, pagination, provenance and inaccessible-source tests |
| V07 | Indicative measurements, estimates and readable UI | Aggregation tests and rendered browser evidence |
| V08 | Historical compatibility and Council-only change | Existing checks, scoped diff, independent final review |

The [final local proof report](reviews/native-agent-variants-local-2026-10-05.md)
records observed results for these IDs. Simulated tests are not native instance
or model-execution evidence.

## Technical checkpoints

1. Confirm the installed SDK rather than assuming host-source types match it.
2. Qualify managed setup and observable instructions/skills/configuration using
   public interfaces. Reconcile alone is not a full configuration sync.
3. Detect surviving issue overrides: assignment alone does not guarantee the
   effective profile. Never patch an unsupported field to hide this conflict.
4. Preserve exact native issue/run attribution. A reassignment must not clear an
   active lock or turn unknown effects into a new launch.
5. Bind the durable selection before native side effects, read back assignment,
   and keep uncertain effects blocked. Native update and wake are not atomic.
6. Collect history from durable run IDs, not a bounded dashboard summary.

Stop the affected implementation path if public capabilities cannot enforce its
contract without Paperclip/SDK modifications. Record the exact limitation and
retain independent completed work; do not label a partial path complete.

## Implemented identity and task boundaries

The configuration boundary uses the shared draft-07 catalogue schema, while
runtime reads retain the same matrix validation. A selected family must belong
to the resolved role charter; supported multi-family classification remains
possible. N1 defaults test and design contributors to their corresponding
families.

The logical identity is the UUID of the managed `sol-medium-v1` anchor for a
catalogue role. Physical identities are resolved by exact managed resource keys,
not display names. Lead, contributor-1 and contributor-2 are separate logical
agents even though they reuse the executor charter. A different physical variant
cannot be used as another roster identity: it is not a logical anchor.

| Standard path | Task key | Stable intervention key |
| --- | --- | --- |
| Root lead and authorized correction | Root issue UUID | `lead` |
| Ordinary specialists and final review | Same root issue UUID | `specialist:<slotId>` / `reviewer` |
| N1 contribution | Contribution UUID | Same contribution UUID |
| N5 initial/update publication | `delivery` | `publisher` |
| N6 dependency coordination | `coordination` | Existing task kind |

The root task therefore shares its one ascent across lead, specialists and
reviewer, including subsequent review rounds. Contribution, publication and
coordination tasks pin their own mappings at their first launch. Dispatchers
derive these keys from existing workflow state; selecting a profile grants no
permission to invent another intervention or attempt.

The aggregate stores an optional `native-variants-v1` state; no database migration
or historical aggregate rewrite is required. Opt-in is captured only when both
`modelVariantsEnabled: true` and `n2RuntimeProfile: "ordinary-cli-v1"` apply at
mission creation. Such missions retain ordinary review routing if company config
later changes. Historical missions lack this state and keep their prior paths.
Creation checks every roster member against a prepared, readable managed anchor
before inserting the mission. Existing incompatible rosters cannot accidentally
produce an opted-in mission that cannot launch.
Structured responsibilities are checked as well: `lead` for integration,
`generalist-reviewer` for the final verdict, execution templates for contributors,
and specialist reviewer templates for other Council members. Review admission
checks the selected specialist's exact perspective. Every dispatcher also passes
the allowed template role to the common launch guard, including publication and
coordination. Free-text responsibility labels grant no extra authority.

Each launch progresses through `selected`, `assignment_claimed` where needed,
`ready`, `wake_claimed`, and `bound` (or `unknown`). Version-checked updates persist
the binding before native effects. Exact readback can complete a known assignment;
an uncertain wake cannot be repeated. A pre-wake N5 correction interrupted during
preparation can resume under its exact command/receipt/reservation; once the
owner resume action has been handed off, replay grants no second action.

Recovery archives remain internal even when publication fails: every public
worker response, including errors and the tool gateway, removes `historyArchive`
without changing the stored recovery snapshot. Company path scope is checked
before dispatching any public route.

Public APIs do not make assignment, document publication and wake atomic. Council
serializes its own claims and checks native locks/assignment immediately before
claiming wake. A concurrent external configuration change remains an instance
qualification concern, not something a mock test can eliminate.

## Setup and inspection surfaces

No setup runs from plugin activation, a timer, or task dispatch. Once instance
setup is separately authorized, the owner can prepare one declared variant using
the existing board plugin API prefix `/api/plugins/private.paperclip-council/api`:

```text
POST /companies/:companyId/model-profiles
{ "companyId": "...", "command": "prepare-variant",
  "roleKey": "lead", "profileId": "sol-high", "revision": "1" }
```

Setup reconciles only resources confirmed missing, prepares the stable anchor and
shared review skill where relevant, then checks actual instructions, model/effort,
permissions and heartbeat configuration. Existing drift returns expected/observed
without reset. Native approvals still apply. Read failure or lost creation
response grants no blind retry. Rosters must use the returned `logicalAgentId`.

`GET /companies/:companyId/model-profiles?companyId=...` exposes the shared format,
seven families, roles, prepared/missing variant inventory and comparable estimates.
`GET /companies/:companyId/missions/:missionId/model-profiles?companyId=...` exposes
the mission's recorded choices, bindings, current drift and usage. Both are
owner-only and read-only. The Council page renders these data without setup or
editing controls.

Through the mission command route, the owner or authenticated active root lead
can send `select-model-profile` with `missionId`, `expectedVersion`, `taskKey`,
`interventionKey`, `family`, `profileId` and `rationale`. Lead access is also wired
through the existing `mission-command` tool. Only the owner can supersede an
explicit owner choice. This command neither reserves admission nor wakes anyone.
Existing dispatch and attempt authorization remain required. The owner can use
`reconcile-model-measurements` to read terminal metrics without a provider call.

## Remaining native qualifications and explicit limits

- The default mapping declares **no fallback alternatives**. The format supports
  at most one declaration per profile, but this V1 **does not execute automatic
  fallback**: public configuration/readiness and cached model discovery do not
  establish confirmed provider/account unavailability before execution. Missing,
  paused, pending-approval, divergent or unreadable variants block. A future
  fallback path needs a verifiable availability signal; no substitute is invented.
- Only revision `1` templates are delivered. Future code/catalogue revisions must
  retain old templates and managed keys while tasks refer to them. Unsupported
  revisions block instead of resolving to the current template. No purge exists.
- Mapping revisions may choose an ordered subset and default within the approved
  family/profile matrix; the shipped defaults are exactly the approved table.
  Profiles outside that matrix require an explicit implementation change.
- Model/account availability, installed instruction/skill mounts, actual CLI
  arguments and native execution settings have **not** been qualified on an active
  instance. SDK `2026.916.1` contracts and readback simulations are the local proof.
- History comes only from public interfaces and exact recorded run IDs. Shared
  issue bodies and documents without explicit intervention attribution are
  excluded with gaps. Raw native logs/events can mix inputs, private traces and
  protected opinions, so they are not fetched or transferred; each run records
  `raw_transcript_attribution_unproven` for these missing sources. Attributed
  journal entries, public comments/interactions, explicitly referenced documents
  and revisions, verified attachments, run metadata and numeric usage remain
  available. This archive is not a complete transcript.
  Collection limits (256 pages, 16 MiB archive, 2 MiB per
  attachment) also produce gaps. Exact parts are indexed in issue documents;
  their SDK lacks atomic create-only/CAS semantics. Private sessions are never read.
  The aggregate retains the archive only during publication recovery; verified
  publication atomically replaces it with the index key, SHA-256, cutoff and gap
  count. Full content then resides in the indexed documents.
- Indicative estimates average successful matching role/family/profile/mapping/
  variant revisions within the latest 50 company missions. Conflicting duplicate
  run IDs are excluded. Missing metrics remain unknown, never zero. Terminal run
  measurements and task totals are distinct from admission, which is unchanged.

## Replayable local checks

From the isolated checkout with the frozen dependencies installed:

```sh
COREPACK_HOME=/tmp/council-native-variants-corepack node scripts/ci/run-checks.mjs
COREPACK_HOME=/tmp/council-native-variants-corepack pnpm audit:static --base-ref ef817493bf99606d324cac6ef572c23de839a9ab
```

Browser QA uses an isolated local fixture with GET-only responses and no connection
to a Paperclip instance. Provide `PAPERCLIP_TEST_HOST_ROOT` pointing at a local host
checkout with React DOM and Playwright already installed,
`PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH` when needed, and a fresh
`COUNCIL_MODEL_UI_EVIDENCE_DIR`, then run `pnpm test:profiles:browser`.
The output includes assertions, request inventory and nonempty desktop/mobile/
error screenshots. It proves component rendering, not an installed plugin.
