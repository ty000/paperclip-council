# Delegated coordination and bounded facilitation

This extends the [accepted-result dependency](RESULT-DEPENDENCIES.md) for A26/C21 and A27/C22. It implements the bounded nominal contract; fixture qualification is not real M2 coordination or evidence of a facilitator's judgment.

The current company/mission owner includes `coordination` in the **same** `configure-result-dependency` command/CAS. Thus even already accepted A cannot launch B before its PM mandate is installed:

```json
{
  "coordination": {
    "coordinatorAgentId": "<PM UUID>",
    "facilitatorAgentId": "<distinct facilitator UUID>",
    "mandate": "<bounded A-to-B ordering and handoff question>",
    "allowedPriorities": ["medium", "high"],
    "participantAgentIds": ["<lead UUID>", "<quality UUID>"],
    "requestedUnits": 2000000
  }
}
```

Amounts are examples requiring actual authorization. Coordination shares the existing native admission period but each run has its own reservation and exact per-run settlement. The allowance is at most two PM work items and one conditional facilitation. No facilitation or second PM run is created if the PM releases/holds/escalates directly. These are distinct parentless native tasks and agent identities; none takes the integration lead's checkout. The native PM role is metadata; persisted delegation and authenticated task/run binding enforce authority.

The current PM can set **B's native priority** only within `allowedPriorities`, explain a hold, release B subject to the exact A acceptance/accounting gate, or escalate a reserved change. It cannot replace A, change the expected result, mandate, budget, Council verdict or individual contributor dispatch. A remains before B regardless of relative priority. A concrete handoff disagreement can create one facilitator task with question, participants and expected outcome. The facilitator records resolution/evidence/uncertainty or escalation; it has neither priority nor acceptance authority. Resolution returns to a separately admitted PM continuation. No recurring ceremony, hierarchy, scheduler, resource manager or model polling is added.

Both roles use their task description's exact endpoint and injected JWT:

```http
POST /api/plugins/private.paperclip-council/api/issues/<own task>/council/commands
Authorization: Bearer $PAPERCLIP_API_KEY
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
```

First `{ "command":"n6-inspect", "missionId":"<B UUID>" }`. Mutation adds a fresh UUID `commandId` and current inspected `expectedVersion`. PM command `n6-coordinate` requires `action: release|hold|facilitate|escalate`, bounded `reason`, and optional allowed `priority`; `facilitate` additionally requires `question`, `participants` and `expectedOutcome`. Facilitator command `n6-facilitation-outcome` only permits `action: resolved|escalate` and `reason`. The response supplies `finishReport`; return it as the exact final JSON and exit normally. Never PATCH done, reassign or wake. The plugin blocks the own task, waits real terminal/per_run usage, verifies its exact public terminal report, settles G4, then closes and applies the decision. Report preparation alone never releases B.

Hold/escalation points to the owner; release while A is unavailable points to owner/controller reconciliation; a dispatched B points to its integration lead. Pending facilitation/PM continuation identifies that actor. Historical decisions and attributed outcomes remain inspectable after coordinator transfer or restart.

Owner-only commands use the existing B mission `/commands` route, with current `expectedVersion` and retained `commandId`:

- `transfer-result-coordinator`: `coordinatorAgentId`, `reason`. Requires previous PM work closed/settled and no N1 activation. It preserves tasks/guards/intent IDs; a facilitator may still own its separate task. Old PM commands are refused. Its successor reads the persisted history.
- `resolve-result-coordination`: `action: release|hold`, `reason`. Resolves an idle hold/escalation explicitly without a hidden PM run or change of dependency.
- `rebind-result-dependency`: new `expectedResult`, `reason`, optional `preserveCoordinationRelease: true`. Only a different **accepted, settled submission of the same A/root/mandate**, before consumed guard/verification or any N1 intention/activation, with no active coordination task. Exact attachment identity/hash/size are reread. Same guard/intent and unused reservation/activation/start IDs remain; old/new tuple and owner are journaled. Explicit true carries the prior ordering/release forward as an **owner decision**, not a claim PM read V2; otherwise held for owner resolution. Root context declares the old tuple superseded; its projection is idempotently repaired after a lost update/replay.
- `reconcile-result-dependency`: company ID and command only. Recovers native events using existing IDs; unknown creation/wake cannot authorize replacement effects or retry models.

At verified release, `verifiedArtifact` persists native attachment ID/download path, SHA256/byte size, base/candidate and exact result. The authenticated lead's ordinary `inspect` returns `n6Handoff` with that information. Download using injected Bearer auth, verify bundle bytes/Git and use exact A candidate as B's base; never use floating main or assume publication. Attachment mismatch or unknown costs retain the wait.

Source owner or coordinator changes are not inferred from chat. Ownership changes invalidate old execution authority. Replacing an active PM run, more than this finite handoff, arbitrary mission queues/graphs, resource claims and global autonomy remain outside this tranche. Real facilitation value must still be observed on an actual disagreement; synthetic reports prove contracts only.
