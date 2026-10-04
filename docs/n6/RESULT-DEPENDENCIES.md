# N6: one exact accepted-result dependency

This tranche starts from main `a6176cd5c81b5e8fabbd5d02aa8f9db6c8bf7f4b` (merged PR31). Historical M1 produced accepted UI `1165202`, eleven real runs and 7,516,822 settled tokens; its publication was assisted by the owner and its native publisher intent remains unknown. This feature neither rewrites that evidence nor claims that its delivery was autonomously completed.

N6 adds one immutable predecessor to an inactive downstream mission in the same company and project. Its contract consumes an **accepted result**, independently of an open PR or delivery readiness. It pins the exact source mission/root, submission, candidate commit, bundle digest, evidence revision and mandate hash. Only ordinary-cli-v1 sources are currently supported. A different result, changed mandate, missing receipt, unresolved usage or missing referenced reservation preserves the wait. Source issue `done` alone is insufficient.

The configured company/mission owner authorizes the later N1 activation and dispatch up front. Send the existing owner mission command route:

```http
POST /api/plugins/private.paperclip-council/api/companies/<company>/missions/<B>/commands
```

```json
{
  "companyId": "<company UUID>",
  "command": "configure-result-dependency",
  "commandId": "<fresh UUID, retain for replay>",
  "expectedVersion": 1,
  "sourceMissionId": "<A UUID>",
  "expectedResult": {
    "submissionId": "<exact source submission UUID>",
    "candidateCommit": "<40 lowercase hex>",
    "bundleSha256": "<64 lowercase hex>",
    "evidenceRevision": 18,
    "mandateHash": "<64 lowercase hex>"
  },
  "periodKey": "<existing downstream native admission period>",
  "requestedUnits": 1000
}
```

All versions, amounts and identifiers above are examples: use current owner readback and the actual authorized allowance. A must already have an identifiable proposed result; acceptance may still be pending. B must be an inactive draft with an idle backlog/blocked root assigned to its pinned lead. B's team, Council, mandate and owner are the existing mission composition, not a new committee. Configuration authorizes automatic launch of B through N1, immediately if A is already accepted/settled or later when its predicate becomes true. It therefore requires the applicable execution/provider authorization and budget; this implementation qualification uses only local deterministic fixtures.

The plugin persists authorization and stable create/activation/start/reservation identities before effects. It creates a parentless, unassigned native gate and attaches it as a blocker of B, then persists B's blocked status. The root description and mission inspection expose the exact source and waiting reason. Never manually close the gate through the public issue PATCH: that route can wake a dependent before Council admission. The controller closes it through the SDK service, which has no implicit wake, and then invokes existing N1 activation/reservation/baseline/start-lead. The same native blocker remains attached; N1's only requestWakeup owns dispatch. A blocked N1 root is eligible solely with the exact persisted N6 commands, verified source and completed native blocker relation.

After an exact source finished event is reconciled, existing event delivery examines dependent missions by their persisted source identity. The automation journal records its authorizing owner. There is no new scheduler, graph, queue, budget ledger or model retry. Owner recovery uses the same route:

```json
{"companyId":"<company UUID>","command":"reconcile-result-dependency"}
```

Reconciliation after restart uses the original command bodies and IDs. An ambiguous create is recovered only by exact native correlation readback; it never creates a replacement gate. A claimed/unknown wake is never replayed. CAS conflicts permit another deterministic read/reconciliation, not a new logical effect key. Owner changes invalidate the stored authority. Native cycle/scope guards remain in use, supplemented by a simple predecessor-chain cycle check.

The accounting check reads only source N1, current native profile and any persisted N5 continuation periods. It requires all known referenced source reservations—including an admitted publisher—to be present, settled and exposure-free. It does not scan every budget or infer unknown usage from task closure. Changing the profile so the referenced accounting cannot be found fails closed.

## PM and facilitation in the later real M2

The owner/PM chooses the predecessor and result contract before B starts, states why B needs that result, and pins B's bounded mandate. The lead executes B through N1; specialists advise and Council alone accepts. The first useful M2 can consume the exact accepted Delivery UI commit and add a small status/next-action summary to mission cards by reusing its projection. It must not assume main, a PR branch or a merge is the accepted artifact.

Invoke facilitation only for a concrete unresolved handoff question. Its instruction must name the question, affected participants, evidence, decision owner, bounded outcome and next actor—for example, whether the card needs the accepted implementation or a published/deployment-ready result. Persist the actual outcome in the mission's normal plan/evidence. No facilitation engine or ceremony is added; usefulness remains unmeasured until a real mission needs it.

Still open for M2: explicit LIVE/provider authorization and budget, real agents consuming A's artifact, their attributable output and independent acceptance, actual coordination/facilitation value, and any delivery/UI proof required by that future mandate. Priority or coordinator changes and replacing/cancelling a pinned dependency are not implemented in this tranche. No result-dependent delivery-ready/PR contract, N6 graph, or global autonomy qualification is claimed.

## Provider-free qualification

`COUNCIL_N6_DEPENDENCIES=1 pnpm exec tsx tests/functional/ordinary-installed.ts artifacts/n6-installed-<unique>.json` reuses the isolated ordinary harness. It runs local deterministic CLI fixtures through the real codex_local adapter/parser/heartbeat; no Codex model/provider is invoked. It prepares A via existing installed N1/N2/N3 APIs, holds its final fixture until B's durable wait exists, restarts the plugin, then observes A acceptance, N1 admission before B's sole run, settlement and replay with no extra run. Fixture content, judgments and usage are synthetic and declared; native identities/auth/blockers/CAS/dispatch/accounting are real. M1 is not restored or requalified.

B is intentionally bounded to one admitted run and its authenticated N1 inspection. Its fixture waits at a local barrier; the owner observes the exact run/mission, disables further demand wakes, and only then releases normal terminalization, settles usage and closes the probe issue. This prevents native disposition repair of an intentionally unfinished fixture. It does not prove that B implements a deliverable or that general wake deduplication is complete.
