# Publisher preflight — Council only

New ordinary N5 publication authorizations pin `publisher-run-report-v1` by
default. Publisher configuration and fixed-variant readiness are checked before
its child/wake. GitHub access is checked in its actual environment at the start
of the **already admitted publisher run**, before the one-shot publication claim.
This run consumes its normal reservation/usage even if the preflight refuses.
There is no second agent, free/untracked run, budget reset, operator token,
Paperclip/SDK change or new permission grant.

The generated N5 instructions invoke the packaged `publisher_preflight.py` with
the exact mission, intent, candidate, repository, base and head bindings. It
inherits the native publisher's Git/gh environment; secrets are not discovered,
copied or printed. It checks Git/gh availability, repository root/origin, exact
local HEAD, clean tracked files, repository read access and reported push
permission. Read-only `ls-remote` must observe the accepted base and either an
absent new head or the previous observed head for an update's explicit lease.
No push, PR, model call or configuration write occurs during this probe.

Pass the parsed JSON report as `preflight` in the existing `n5-claim-publication`
command. Council requires all checks, this exact active run/issue/intent/candidate,
the authorized repository/refs, the previous observed head for an update, and a
fresh timestamp. Missing, stale, mismatched or refused reports cannot consume the
one-shot intent or obtain `effectPermission=execute`. The successful claim stores
only selected bindings and a report hash under `publisher_run_report` provenance.
Claim replay keeps its original identity and never grants another publication.

A reported `permissions.push: true` is **not** proof of a push or PR creation.
The native GitHub work product/document/external-object readback remains the
separate post-effect proof. The report is attributed publisher evidence, not an
independent host attestation. A GitHub permission or branch may change after the
probe; the explicit lease, one-shot claim and unknown-effect safeguards still
apply. A refused/ambiguous publication never authorizes a blind retry.

Historical authorizations without this protocol keep their prior contract.
`n5PublisherPreflightEnabled: false` can explicitly retain that contract for
future authorizations; existing pinned authorities are unaffected by subsequent
configuration changes. Experimental runner authorizations are not upgraded by
the ordinary-runtime default. The sandbox workspace gate is a separate opt-in
and requires its explicit native-home registration.

Qualification uses deterministic GitHub responses plus an installed ordinary
publisher fixture; it does not establish live credentials/model availability or
launch a provider campaign on the recipe instance. Draft compliance and the
post-publication review/correction controller are tracked in issue #52.
