# Receipt increment handoff to L03

Date: 2026-09-30. This increment closes only the engaged receipt/operator slice.
The next product objective is **complete L03**; no L03 implementation is launched
by this handoff.

## Directly reusable

- The existing Council verdict route journals and atomically claims a private
  attempt before the native PATCH. Same-content duplicates read the receipt;
  content/target conflicts and equivalent keys during uncertainty are refused.
- Indeterminate attempts survive interruption/restart. A configured owner can
  inspect, acknowledge or abandon in the existing Council page. Human history
  and native observations are separate; acknowledgement/abandonment do not
  clear uncertainty or authorize another equivalent action.
- The isolated PostgreSQL, fault, process-kill and browser replay plus focused
  unit tests cover this path. This is a building block, not L03 acceptance.

## Dependencies and changed contracts

- Council package/manifest 0.4.0 adds private migration
  `004_decision_receipts.sql`; existing data and migrations remain intact.
- Verdict callers must supply a stable `operationId`. It is unique per company
  and binds issue, configured actor, native target and content. Replays retain
  the original run attribution. Read `receipt.state` and `nativeObservation`;
  a 202 indeterminate response is not completion.
- A usable native response records only available native evidence. There is no
  distributed exactly-once promise or inference that another run started.
- The owner is the host company's current `defaultResponsibleUserId`; no new
  authority service or notification system is introduced.
- DEC-G3-02 supersedes mandatory host D-H/automatic ambiguous-result recovery
  for V1. Paperclip source/SDK/schema/permissions and the running instance stay
  unchanged. No upstream PR is required. Deployment remains a separate action.
- Never downgrade to a worker that ignores retained receipts/holds. Do not
  delete receipts or create a fresh key to bypass an uncertain operation. Safe
  resumption without a supported contract remains blocked.

## Still required for the L03 journey

Use Executive `docs/L03-FRAMING.md` as the remaining acceptance authority:
A1 actor/permission enforcement; A2 approach direction/revision and matching
observed continuation; A3 exact subject and evidence; A4 bounded correction;
A5 integration of this receipt behavior into the full journey; A6 persistent
shared limits and D-LIMIT; A7 distinct attributed opinions; A8 operator
visibility across the journey. D-C and actual runtime qualification remain
open. Qualify correction through a new exact submission and final acceptance,
plus attributable owner continuation, before declaring complete L03.

No model/provider campaign, live installation, activation, host deployment or
V1 completion is claimed here. Preserve historical audit failures as dated
findings under their original contract; do not relabel them as passes.
