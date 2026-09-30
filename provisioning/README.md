# Council V1 agent profiles and provisioning preparation

Status: **preparation only**. These artifacts do not create, configure, install,
mount, activate or run a Paperclip agent. They prepare reuse-first setup against
Paperclip source `61b3fd57a695614dc4a37e2303f426a34a9795cf` and Council base
`ee262eed809c5d7c96eef0e7ee330e0e56a65104`.

## Challenge outcome

| Proposal | Decision | Preparation result |
| --- | --- | --- |
| Nine prepared profiles imply nine new agents or nine participants per round | Rejected | Profiles are reusable responsibility charters. Reuse eligible existing identities and select only the perspectives required for the pinned mission; preparation does not create identities or impose a committee. |
| Integration Lead is a dedicated identity | Adjusted | It is a mission responsibility normally assigned to an Executor. A second Executor identity is used only for a real second contribution. |
| Appeal Council and Human Owner are agents | Deferred/rejected | Appeal Council is a bounded composition of eligible existing reviewers. Human Owner remains human. No automatic replacement identity is created when eligibility is missing. |
| Shared review wording belongs in every charter | Adjusted | Durable authority stays in each `AGENTS.md`; the reusable review method is extracted to `skills/council-review/SKILL.md`. |
| Plugin-managed `agents.managed` / `skills.managed` are required | Deferred | Existing-agent configuration through supported Paperclip APIs is the default. Managed packaging needs a later ownership/drift decision. |
| One powerful model for all sensitive reviewers | Adjusted | Ordinary execution/review starts at `gpt-5.6-sol` / `medium`; escalation follows the independent mapping and actual problem. Availability is checked at activation. |
| Timer heartbeats should poll for work | Rejected by default | Scheduled heartbeat stays disabled. Event/on-demand wake may be enabled for assigned work after target readback. |

## Profile, identity and responsibility boundary

- A **profile** is the durable charter in `agents/*/AGENTS.md`.
- An **identity** is an existing or newly governed Paperclip agent record with its
  own authentication, configuration, bundle revision and effective rights.
- A **responsibility** is a mission/roster assignment such as contributor,
  Integration Lead, final reviewer or product opinion.
- **Participation** binds one eligible identity to one responsibility for one
  pinned mission/review round.

One identity can reuse a compatible profile across missions. It cannot be both a
recorded author/integrator and a counted reviewer of the same submission.

## Prepared profile matrix

| Profile | Native role / title | Durable responsibility | Model / adapter | Skills | Tools and access | Unresolved before setup |
| --- | --- | --- | --- | --- | --- | --- |
| Executor | `engineer` / `Software Executor` | Produce an identified contribution; optionally carry Integration Lead | `codex_local`, explicit `cli`, WSL; `gpt-5.6-sol` / `medium` | `paperclip` required when mounted; GitHub/implementation skills conditional | Assigned workspace write and relevant tests; GitHub/browser/network/external delivery only when authorized | Existing eligible agent, company/project, reports-to, workspace/environment, auth home, limits, tools, skill keys/versions |
| Generalist Reviewer | `general` / `Generalist Reviewer` | Accountable final verdict and supported application/readback | Same ordinary starting point | `paperclip` + `council-review`; QA/design/domain skills conditional | Exact candidate/evidence read; disposable test output; supported native decision/readback. Candidate modification forbidden by charter, not proven by sandbox | Eligible distinct identity, final-review credential mapping, review route version, candidate access, readback support, tools, skill mounts |
| Product Reviewer | `pm` / `Product Reviewer` | Attributed product opinion on a selected round | Same ordinary starting point | `paperclip` + `council-review`; design/QA conditional | Product and user evidence read; external research/browser only if authorized | Concrete need/slot, eligible distinct identity, evidence sources, owner destination, skill mounts |
| Development Reviewer | `engineer` / `Development Reviewer` | Attributed implementation/local-contract opinion on a selected round | Same ordinary starting point | `paperclip` + `council-review`; language/repository skills conditional | Source/diff read and bounded relevant checks; no candidate edits or GitHub rights implied | Concrete code risk/slot, eligible distinct identity, source/test access, contract evidence, tools, skill mounts |
| Architecture Reviewer | `engineer` / `Architecture Reviewer` | Attributed boundary/interface/irreversibility opinion on a selected round | Same ordinary starting point; reconsider only for a separately framed consequential question | `paperclip` + `council-review`; domain skill conditional | Source, interface, data-flow and contract evidence read; no implementation or infrastructure authority | Concrete cross-component risk/slot, eligible distinct identity, current contracts/constraints, tools, skill mounts |
| UX & Accessibility Reviewer | `designer` / `UX & Accessibility Reviewer` | Attributed usability/accessibility opinion on a selected round | Same ordinary starting point | `paperclip` + `council-review`; `design-critique` and QA conditional | Concrete artifact/source read; browser/design/accessibility tools only if available and authorized | Concrete flow/slot, user job/groups, target formats, artifacts, tools, skill mounts |
| Quality Reviewer | `qa` / `Quality Reviewer` | Attributed quality opinion on a selected round | Same ordinary starting point | `paperclip` + `council-review`; `qa-acceptance` conditional | Candidate/evidence read and relevant authorized checks; disposable outputs only | Concrete risk/slot, eligible distinct identity, test environment/tools, evidence location, skill mounts |
| Security Reviewer | `security` / `Security Reviewer` | Attributed trust/authority/data-risk opinion on a selected round | Same ordinary starting point; title causes no automatic escalation | `paperclip` + `council-review`; domain skill conditional and unverified | Authorized source/redacted evidence read; no intrusive scan, secret collection or external probing | Concrete threat/slot, assets/actors/boundaries, permitted checks/tools, skill mounts |
| Operations Reviewer | `devops` / `Operations Reviewer` | Attributed configuration/runtime/recovery opinion on a selected round | Same ordinary starting point | `paperclip` + `council-review`; target runbook/domain skill conditional | Approved config/log/evidence read and bounded non-live checks; no deploy/restart/config mutation | Concrete operational risk/slot, environment class, recovery/cost evidence, tools, skill mounts |

`search: false` and `fastMode: false` are starting runtime choices, not access
controls. `dangerouslyBypassApprovalsAndSandbox: false` must be explicit because
the inspected create default is `true`. A writable Codex workspace does not
enforce reviewer non-modification; stronger filesystem/network confinement must
be selected and qualified separately.

The ordinary `gpt-5.6-sol` / `medium` recommendation comes from the independent
`shared/model-selection/model-effort-mapping.md`, updated 2026-09-05. It is
advisory until the target exposes and accepts those options. Escalate for the
problem actually present, not for hierarchy, missing sources or denied rights.

## Permission preparation

Start with `canCreateAgents: false` and `canCreateSkills: false` for all nine
profiles. Request `canAssignTasks: false` unless a concrete Integration Lead
workflow needs assignment authority. Then read back effective access.

In the inspected Paperclip source, active membership can still produce effective
`canAssignTasks: true` through `simple_default`, and the permission update reports
the effective value separately. Therefore the requested boolean is not a proven
denial. Do not claim least privilege until membership/grants and the returned
effective source have been inspected. Conversely, do not remove a right needed
by a legitimate, selected Integration Lead flow without first mapping that flow.

Likewise, `canCreateSkills: false` is stored intent, not the whole effective
company-skill authorization policy. Company boundary, current skill policy and
actual grants must be checked. A new hire also receives the current default
`tasks:assign` grant after creation; if least privilege requires removal, that is
a distinct post-approval operation and readback, not a creation-payload claim.

Profiles grant no network, API, browser, GitHub, filesystem or delivery rights.
Those surfaces are target/mission configuration and must be independently
available and authorized. Final-reviewer native secret references are identity-
specific configuration; no secret belongs in these files.

## Composition examples

### Simple L3 path — two identities

1. Identity A uses the Executor profile and authors the submission.
2. Distinct identity B uses the Generalist Reviewer profile and owns the final
   verdict.

No specialist opinion is automatically required. This is a simple independent
review path, not proof of multidisciplinary reasoning.

### Two contributions — three identities

1. Executor A authors contribution A and carries Integration Lead.
2. Executor B authors contribution B in a non-conflicting workspace or serialized
   write window.
3. Distinct Generalist Reviewer C reviews the integrated submission.

The lead must list both contributors. Completion of either contribution does not
accept the integrated result.

### Multidisciplinary qualification example — five identities

Use the three identities above plus distinct Product Reviewer D and Quality
Reviewer E, both reviewing the same immutable submission/evidence/mandate tuple.
Their opinions inform Generalist Reviewer C; they do not acquire root closure
rights. C is not silently counted as either required specialist opinion.

This five-identity composition is an unambiguous example, not a universal
minimum and not evidence that judgments are independent or better.

Product and Quality are illustrative choices. A round may instead select one or
more other relevant specialists, but it fixes required opinions before review.
Every required position remains attributed and visible before final synthesis;
absence is never agreement. The final reviewer disposes of objections without
rewriting specialist opinions to manufacture consensus.

For appeal, exclude recorded authors/integrators and the issuer of the disputed
opinion from the counted independent appeal role. If no configured participant
is eligible, escalate to the owner; do not create an agent automatically.

## Specialist solicitation examples

This is a simple selection aid, not a router, automatic trigger or mandatory
committee. Use the smallest set that addresses consequential unresolved risk.

| Question in the pinned mission | Usually solicit | Add only when |
| --- | --- | --- |
| Local code correction, API/function contract, edge case or error path | Development Reviewer | Quality evidence is separately insufficient or regression exposure is material |
| Component boundary, interface/data flow, coupling or hard-to-reverse choice | Architecture Reviewer | The question is consequential across components, not merely a local implementation preference |
| Concrete screen, interaction or user journey | UX & Accessibility Reviewer | A real artifact/user job and relevant target formats or accessibility risk exist |
| Authentication, authorization, isolation, secret or sensitive-data path | Security Reviewer | A bounded asset/actor/trust-boundary question can be stated and checks are authorized |
| Configuration, compatibility, deployment, diagnosis, recovery or runtime cost | Operations Reviewer | The current result creates a material operational or recovery question |
| User outcome, commitment, affected-group or essential-use trade-off | Product Reviewer | The issue exceeds routine mandate interpretation or needs an owner decision |
| Observable behavior, coverage, environment or evidence sufficiency | Quality Reviewer | A distinct validation judgment changes the decision |

## Review responsibility boundaries

| Responsibility | Primary question | Not a substitute for |
| --- | --- | --- |
| Development Reviewer | Is the implementation correct against its local code contracts, including relevant edge/error paths? | The Executor's correction work, full behavior coverage or the root verdict |
| Architecture Reviewer | Are component boundaries, interfaces, data flows and consequential structural choices coherent and sufficient? | General code review, speculative roadmap design or infrastructure authorization |
| Quality Reviewer | Is observable behavior covered by adequate, candidate-bound evidence in the relevant environment? | Editing the implementation or waiving criteria |
| Generalist Reviewer | How are all applicable evidence, opinions, objections and authority limits synthesized into the accountable root verdict? | A specialist opinion or owner-reserved decision |

## Skill decisions

- `paperclip`: source present in the inspected Paperclip checkout and required
  for native coordination when actually mounted. Generic execution checkout
  guidance must not override an already active review-stage contract.
- `council-review`: new source prepared here because final and specialist
  reviewers share one concrete candidate/evidence method. Company-library
  installation, desired selection and runtime mount are unknown.
- `qa-acceptance`: source present; conditional for relevant feature/release or
  user-visible acceptance. Preserve valid evidence and narrow the pass.
- `github-pr-workflow`: source present; conditional only for explicitly
  authorized GitHub work. Its generic rebase, push, review and branch deletion
  advice remains subordinate to repository ownership and mission authority.
- `design-critique`: source present; conditional on a concrete artifact and user
  job. Critique is not Council acceptance.
- Development/Architecture/Security/Operations domain skills: none is assumed or
  invented. Select an actually available method only for a concrete authorized
  need; a title never supplies tools, access or permission.

The profile charters contain an autonomous minimum so a missing optional skill
does not silently remove safety constraints. Missing `paperclip` or
`council-review` at activation is a readiness blocker for the intended governed
workflow, even though the role text remains readable.

## Provisioning order and readback

1. Select the target instance/company/project and candidate existing identities.
2. Read each identity, org relation, configuration, effective access,
   instructions bundle mode/revision/hash, desired skills and skill snapshot.
3. Compare identity/profile fit and conflicts. Prefer reuse; propose a governed
   hire only when no eligible identity exists.
4. Prepare field-level diffs from
   [`CONFIGURATION-TEMPLATES.md`](CONFIGURATION-TEMPLATES.md). Preserve unrelated
   adapter settings, skills and customized instructions.
5. Update configuration, instructions and permissions through their dedicated
   supported APIs. A creation `instructionsBundle` is not an update mechanism.
6. Ensure required company skills exist, then add exact desired keys/versions.
   Read back desired state and effective mount; library presence is insufficient.
7. Read back agent configuration, effective permissions, bundle content and
   revision/hash, skill snapshot, model/auth mode and available tools.
8. Verify roster eligibility and identity-specific final-reviewer secret mapping
   without revealing secret values.
9. Only after separate authorization: activate the selected identities/rosters
   and run a bounded trial. This preparation grants no such authorization.

A timeout or disconnected future write has unknown outcome: read the actual
state before retrying. Preserve revisions/hashes and never replace existing
custom content with a template merely because the template is newer.

## Current contract status

The Council source currently supports roster roles, distinct Integration Lead /
final-reviewer validation and persisted pinned draft missions. The specialist
opinion/verdict/appeal routes in the TAD remain proposed, not current code; the
existing `/issues/:issueId/decision` route is a narrower legacy prototype.
The inspected native `paperclip` instructions also support ordinary execution-
policy review through the current participant's normal issue PATCH. A future
setup must choose the actual retained route; no profile may silently substitute
one path for another.

At preparation time, `origin/main` is
`ee262eed809c5d7c96eef0e7ee330e0e56a65104`; PR #10's documentation is merged and
the owner-accepted G3/G4 record is on main. The observed pre-L3 PR #9 remains
open and behind main at `a385a7d31729a77908b845991a9da5f5fd4e2003`. It adds
bounded qualification infrastructure and environment-class documentation, but
does not turn the proposed specialist opinion/verdict/appeal contract into an
available runtime route. Its commands and environment boundaries remain
provisional until merge and reconciliation with the selected candidate.

Those decisions are preserved here: minimal supported native
decision readback belongs to G3; no blind retry follows a lost response. G4 uses
prudent task/period reservation and admission control, with unknown usage never
zero and no absolute monetary guarantee. Their owner decisions are adopted, but
their technical qualifications remain open under `docs/G3-G4-DECISIONS.md`.
Neither guarantee is implemented by an agent profile or this provisioning
preparation.
