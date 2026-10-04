# M2 reference transport and owner-assisted recovery

This lot fixes the known reference-transport failure of the [M2 campaign](../reviews/m2-live/REPORT.md). It does not run another campaign, restore the private native backup, modify Paperclip, or apply recovery to the saved mission.

## Preventing the original error

Every new N1 child description includes one self-contained Node command. The agent commits its owned change and executes that block unchanged. The block reads `git rev-parse --verify HEAD^{commit}`, inspects the authenticated child, generates the command UUID and sends JSON directly. A model no longer needs to expand abbreviated Git output or copy a full SHA into a payload. No Council checkout or extra package is needed in the target repository.

The block refuses dirty tracked work, an already-recorded contribution or a moved HEAD. It logs the exact request before its sole mutation and stops on refusal or a lost response; it never regenerates a key or retries automatically. An uncertain result still requires readback with the same logged request identity. This improves the supplied executable path; the server continues to validate the full integrated Git bundle. It does not make arbitrary hand-written agent requests trustworthy.

## B recovery command

The original lead already terminated. Merely correcting a reference would leave integration unfinished, so the owner has one explicit command:

`POST /api/plugins/private.paperclip-council/api/companies/<companyId>/missions/<missionId>/commands`

```json
{
  "command": "recover-integration",
  "commandId": "<generate once for this owner effect>",
  "expectedVersion": 30,
  "contributionId": "4195b52e-72f4-4b8e-a7ef-9851a95d6ac5",
  "previousCommit": "71b5f95145410736c691552b836df8f20df3880e",
  "replacementCommit": "71b5f95ab7428feb24049f2204b97b12446cd528",
  "reason": "Owner-verified recovery of the known M2 recorded-reference mismatch",
  "attachmentId": "<actual upload on the same B root>",
  "expectedSha256": "<prepared bundle SHA-256>",
  "baseCommit": "7959f68ce586b8e0a75d26b1e80490ac26e0cb06",
  "candidateCommit": "654048e902709893cdb3ae22e5715b0d0782a276"
}
```

Use the current owner inspection for the version before first execution. Use the generated preparation JSON for Git identities/hash; do not retype them. The upload ID and command ID in the local rehearsal are fixtures, not native resources or reusable effect keys.

Only the configured mission owner can apply this command. It requires no candidate/review/delivery yet, the exact recorded erroneous reference, two completed attributed children, and all three original native runs succeeded with settled known usage and zero exposure. It verifies the issue-bound bundle, absence of the old reference **in that checked bundle**, real replacement, ownership, contribution ancestry/preservation and one distinct integration commit. A dependent mission retains its accepted predecessor as base.

One CAS records the replacement with owner attribution and the old reference, adds the owner receipt/journal event, and stores the verified candidate at `ready_for_review`. The original contributor receipt, author/run identity, A dependency and admission ledger remain intact. A replay uses the identical payload/key and does not write again. This is owner-assisted integration, not a successful integration performed by the original lead. No agent is launched, no cost is changed and no review, acceptance or GitHub publication is performed by this command.

## Reproducible offline preparation

From the observation worktree with the retained local M2 artifacts:

```sh
pnpm qualification:prepare:m2-recovery
```

The script verifies the historical input hashes, imports the real B bundle into a temporary Git repo and reads both real contributions directly from Git. It creates one deterministic empty integration commit preserving their tree, then exercises the public command handler and real Git verifier with in-memory SDK/database fixtures. It checks receipt/dependency preservation and idempotent replay, saves `artifacts/m2-recovery-prepared.json` and the prepared bundle, and deletes its temporary repo. It opens no HTTP connection and never starts Paperclip or a provider. Saved historical artifacts are not rewritten.

Observed result: candidate `654048e902709893cdb3ae22e5715b0d0782a276`, 15 Git checks, one in-memory write, exact replay without another write. The A accepted commit and B commits `71b5f95a…`/`0be2ff1…` are retained. **This is preparation, not native application or B acceptance.** Product QA/review of this prepared candidate remains required before approval/publication.

## Next native continuation

1. Restore the saved M2 DB/storage into an isolated instance, with all agents paused and timer/demand wakes disabled. Install the reviewed recovery code. Re-read A accepted, B v30 and the original settled ledger before any mutation. Backup restoration itself has not been qualified by this lot.
2. Upload the prepared bundle on the same B root, obtain its real attachment ID, and execute the owner command once with current version and a fresh stable command ID. Read back `ready_for_review`, the correction journal, unchanged original receipt and original costs. Preserve known failures and uncertain effects honestly; no DB edit or fabricated lead run.
3. Only then proceed with authorized B review/acceptance and its single cumulative PR. Confirm an active admission period and a concrete remaining run/token budget before any model call. The original fixed period ends **2026-10-04 23:05:00.481 UTC**; historical reservations prevent reconfiguring/resetting it. If expired, stop before requesting a run and prepare explicit period rollover separately; this command deliberately does not silently extend the budget.

No re-execution of A, contributors, PM or facilitator is needed to prepare this candidate. No merge or production deployment is included.

## One explicit missing-opinion replacement

After the known restored-URL error, the settled Development run submitted no opinion. An owner may now prepare **one** replacement per mission using `replace-missing-opinion` on the same owner commands route:

```json
{
  "companyId": "<exact company>",
  "command": "replace-missing-opinion",
  "commandId": "<generate once>",
  "expectedVersion": 37,
  "taskId": "<first unclosed specialist task>",
  "runId": "<its exact succeeded run>",
  "submissionId": "<current submission>",
  "candidateCommit": "<current exact candidate>",
  "authorizeOneReplacement": true,
  "reason": "<explicit owner authorization and observed cause>"
}
```

Read the actual current version and copy IDs directly from inspection. This is a bounded manual exception, not an automatic retry: the command requires no opinion for that slot, public exact terminal per-run usage matching the existing settled reservation, and the unchanged candidate. One CAS preserves the old task/run/receipts and journals the owner grant while inserting its replacement before the next specialist. The command creates no issue, reservation or wake; replaying its identical key/body has no additional effect.

`reconcile-ordinary-n2` cancels the old issue (its run was already terminal), preserves its explicit absence of opinion, then uses the existing dispatcher. The new reservation is recorded as `resume` ordinal1 with the owner grant identity. Admission re-reads the persisted grant, owner, subject, old settled reservation and exact new task/reservation, rejecting a fabricated exception. The global `maxRetries:0`, elapsed period, concurrency and cumulative token budget remain unchanged. No second replacement is available and no native resume/reassignment can substitute for this command. A replacement opinion is still followed by Quality and the independent Council verdict; a local source review is never accepted as their output.

Before any restored-session wake, update/read back the full plugin configuration with its actual `apiBaseUrl`, preserving secret references and original period. Preparing this command itself exercises the configured Council credential and exact historical run identity through public readback, without a provider or invented run. Keep all agents paused during that preflight/preparation, then require the concrete campaign authorization before the separate reconciliation dispatch. The two known local UI findings are evidence for the native reviewers, not permission to modify the active candidate outside its correction workflow.
