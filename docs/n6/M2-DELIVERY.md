# M2 coordination UI — assisted delivery and next environment

October 5, 2026. This checkpoint concerns the source delivery, not a new native
Council acceptance or a deployment. The owner authorized publication and merge
after local validation and GitHub CI.

## Delivered behavior

The Missions page shows the authoritative N6 coordination state, source links,
expected and verified candidate identities, coordinator, reason and next action.
It does not infer acceptance or permission to start from those display values.
Source links select the requested mission and use authenticated inspection when
it is outside the latest-50 list. Released/started reasons are not labelled as
waiting. Candidate field rendering and the panel's visual sections are kept
small without changing the resulting elements, styles or attributes.

This cumulative delivery preserves A's projection/tests and B's UI work. The
local refactor `a129cd41d469dce7ef64258d51735fed35118395` follows native V2
`60fc6904150424f84d8ce0e264ffabca6078c073`; it is an operator-assisted code change.
The branch was reconciled with main including recovery PRs #33 and #34.

## Validation and retained limits

- `node scripts/ci/run-checks.mjs`: 464 tests, typecheck and build passed after
  reconciliation with main.
- `pnpm audit:static --base-ref <PR-base>`: pinned Fallow 3.23.0 gate passed with
  zero blocking findings. Raw audit debt and moderate warnings remain declared;
  no audit policy or suppression was added.
- The local before/after comparison covered 1,232 element-tree configurations,
  including optional fields, revision zero, status tones and links. This is not
  a browser or installed-target observation.
- Final local source review found no blocking issue in this publication diff.
  It is not an independent native Council verdict.

[The native report](../reviews/m2-live/REPLACEMENT.md) remains immutable: A was
accepted; B reached a real correction and fresh specialist/Council review, but
V2 was rejected for the then-failing static gate. Eighteen runs and reservations
were settled at 13,863,240 tokens with zero exposure. B remains `reviewing` v91
in its preserved backup after the second-correction refusal. The local refactor
and GitHub merge do not rewrite that result or credit the native publisher.

Source delivery can therefore finish with owner assistance while native M2
qualification remains partial. No new provider run, native state mutation,
Paperclip core change or installation is part of this publication.

## Recommended next step: persistent local acceptance environment

1. Preserve the M2 reports, backup and Git identities; record the merged source
   as an assisted delivery. Do not restart A or extend the expired campaign just
   to replace its historical verdict.
2. Select the exact target instance/company/project and inventory its host,
   installed plugin path/configuration and existing agents. The local
   `paperclipai-council-local.service` was observed active and enabled; its loaded
   Council build and compatibility with this commit have not been verified.
3. After installation authorization, back up the target, use a stable checkout
   outside temporary campaign directories, build the merged commit, and use the
   native install or same-path upgrade procedure. Preserve the existing instance
   and plugin configuration; keep affected agents paused during the update.
4. Without model calls, read back worker readiness, package/build identity and
   the served UI; verify rosters, Missions/Delivery/Coordination inspection,
   source navigation and persistence after restart. Capture the actual target
   UI. A snapshot or fixture must remain labelled as such.
5. Then propose one useful, separately bounded mission in that environment to
   observe ordinary review, known usage and publication end to end. Fix only
   blockers of that nominal use. This tests usability; it does not retroactively
   turn historical M2 into an autonomous success.

The [environment classes](../ENVIRONMENTS.md) and [ordinary CLI recipe](../n5/ORDINARY-CAMPAIGN.md)
apply. Installation, activation and real-agent execution are separate effects.
Executive, connector integration and general retry/scheduler work remain outside
this next step. No infrastructure expansion or new runner is proposed.
