# Abandon an unused draft

From version 0.7.44, the configured company owner who owns the mission may send
`abandon-unused-draft` to the existing company-scoped mission command endpoint:

```json
{
  "command": "abandon-unused-draft",
  "commandId": "<fresh UUID retained for all reconciliation>",
  "expectedVersion": 2,
  "reason": "Disposable draft is no longer needed"
}
```

The host's company access controls and Council's existing owner checks still
apply, including for an archived company. Instance administration is not a
substitute for the configured owner's authority.

Eligibility is deliberately narrow: inactive draft, no N1–N6 work, delegation,
hierarchy, effect intent, model task, historical native run or admission
reservation. Its native root must be waiting, unlocked, without children,
approvals or recorded cost. An owner-selected profile alone does not execute
work and is preserved. Incomplete or unknown evidence retains occupation.
Started missions continue to use their existing cancellation and reconciliation.

The command records actor, reason, date and original command identity. Phase
remains `draft`, control becomes blocked, and the permanent `draftAbandonment`
marker prevents activation, creation replay and mandate changes. It does not
manufacture an accepted result, close a native issue, delete history, wake an
agent, or change another mission's repository holder.

Repository release follows the committed marker and a second zero-effect check.
A reservation locks the same mission row so it cannot cross an abandonment
marker unnoticed. If interrupted, replay the **same command ID and payload**;
never replace its identity. The release checks the original mission version and
reconciles only its own holder. If any concurrent effect is observed, the marker
remains and the holder is retained for explicit investigation. Source and
isolated database tests do not prove installation or native use.

For replayable isolated SQL qualification, use an already installed, read-only
Paperclip checkout with its embedded PostgreSQL dependencies:

```sh
PAPERCLIP_TEST_HOST_ROOT=/absolute/paperclip-checkout pnpm test:unused-draft
```

The test creates and removes its own temporary database; it never connects to an
installed instance. Unit boundaries run with `pnpm test`.
