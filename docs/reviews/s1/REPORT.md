# Paperclip Council Sprint 1 — configuration increment review

Date: 2026-09-30 (Europe/Paris)

Runtime-tested candidate: `fd4661dc3d3c665f5a2819b62abfb5db856c5fdd` on `codex/council-s1`

Documentary base: `b1c76d34b1c0166c6cf675089dce877c6f88b693` (`origin/main`)

Integrated L0 report revision: `a2b9be7dc76d3edcec702f8d14fd7d84ca3cc86c`; L0 implementation `939c49ad4b170652f4b1adc1f85c87a8a7ab5082`; L0 runtime candidate `7fcf5c7716c71905b60b2fbe2ac89955353a334a`

Host: `/home/davy-lp/workspace/paperclip` at `61b3fd57a695614dc4a37e2303f426a34a9795cf`; SDK/shared `2026.916.1`

## Verdict

**Sprint 1 S1-01–S1-03 configuration increment: PASS.** The exact clean candidate installs on the pinned authenticated/private Paperclip host, applies both migrations to a fresh embedded PostgreSQL database, persists immutable revisioned rosters, enforces configured-owner and company boundaries, handles concurrent publication with one head winner, exercises the full roster lifecycle, and exposes a real installed configuration page whose authenticated actions and required UI states pass in Chromium.

The larger statuses remain unchanged: **L1 is partial** until an active mission pins a roster revision; **L0 G3/G4 remain partial**; **mission activation is unavailable**; **V1 is incomplete**. Roster activation means eligibility for future selection only. It starts no mission, dispatches no agent and proves no provider/model behavior.

## Sprint results

| Ticket | Observable result | Runtime proof | Status |
| --- | --- | --- | --- |
| S1-01 — revisioned rosters | Company-scoped immutable revision rows plus CAS-protected mutable heads; reads expose the current revision and full history | Real install/restart/migration; concurrent revisions at the same expected version yield one published head and one `409`, with history remaining immutable | PASS |
| S1-02 — ownership, validation and lifecycle | Create, validate pair, atomically activate pair, revise to draft, suspend and retire; configured company owner is derived from authoritative company state; request-body owner spoofing is ignored | Wrong configured owner receives `403` with no mutation; cross-company overwrite receives `404`; an asymmetric stale pair activation receives `409` with both heads unchanged; other stale transitions also preserve the head; invalid composition/project/agent conflicts are rejected | PASS |
| S1-03 — installed configuration UI | Page lists and edits existing-agent rosters, shows revision history and explicit mission prerequisites, and exposes no mission-enable/dispatch control | Installed bundle + bridge pass; real authenticated browser creates a roster; loading, empty, injected transport error, read-only actor and stale-version feedback are exercised; keyboard activation and non-color status text pass | PASS |

## Implementation boundary

- `migrations/002_revisioned_rosters.sql` adds plugin-private `roster_revisions` and `roster_heads`; no host schema is changed.
- Revision identifiers are UUIDs and published revision rows are never updated or deleted. A losing concurrent candidate can remain unreferenced for auditability; only the CAS winner becomes the head.
- `src/rosters.ts` validates company/project scope, eligible agent status, declared responsibilities, team/council role conflicts and lifecycle versions. Pair activation is one guarded SQL update whose locking subquery must match both expected heads before either head can be updated.
- The mutation authority is the authenticated user matching `company.defaultResponsibleUserId`; client-supplied owner identifiers do not grant authority.
- `src/ui/index.tsx` uses the host bridge identity, Paperclip tokens and existing agents/projects. It distinguishes saved configuration, eligible roster pairs, mission activation unavailability and the inherited G3/G4 limitations.
- No L2 mission model, active-mission pinning, dispatch, provider call, model call, budget reservation, G3 reconciliation, learning/memory, deployment, publication or durable `council-local` mutation is included.

## Evidence and frontend QA

- Structured runtime trace: `docs/reviews/s1/evidence/functional.json`, SHA-256 `6e5df8e7ef1e8cea4a7060dd7ea57b105a2a21b5af62d7d003fdd3fc3cf4cc41`.
- Installed-page capture: `docs/reviews/s1/evidence/ui-page.png`, SHA-256 `b3c957348dff337295f34c7ec253e5fbbb38b793a5e07c0a8c2158dce834a4b6`.
- Frontend QA detail: `docs/reviews/s1/FRONTEND-QA.md`.
- The trace records candidate source archive SHA-256 `287265a994916943b510bfa449f2dbcb8d7e8e06ef7033ef17b7aa3ced5ca75e` and built distribution SHA-256 `eb4dae3f2d6fc2f704b524c6378adcc054f916598cded92137ae5447a9382598`.
- The host source was a clean local clone of `/home/davy-lp/workspace/paperclip` checked out detached at the exact pinned commit. The harness records `hostTrackedFilesClean: true` and now fails before runtime if tracked host files differ from that commit.
- All actors, companies, projects, rosters and issues in the replay are synthetic fixtures. The run uses no model. Ephemeral agent credentials are not serialized in evidence and the isolated app/database/runtime are removed afterward.

Non-blocking observations: the integrated L0 manifest still produces its pre-existing strict-schema warning for `councilApiKey`; the pinned host emits Vite deprecation warnings and expected websocket/join-request noise during browser use. These warnings did not invalidate the tested S1 paths and were not broadened into this lot.

## Replay

```bash
COREPACK_HOME=/tmp/council-s1-corepack pnpm install --offline --frozen-lockfile
COREPACK_HOME=/tmp/council-s1-corepack pnpm typecheck
COREPACK_HOME=/tmp/council-s1-corepack pnpm test
COREPACK_HOME=/tmp/council-s1-corepack pnpm build

COUNCIL_HOST_PROOF_DIR=$(mktemp -d /tmp/paperclip-s1-host-proof.XXXXXX)
git clone --shared --no-checkout /home/davy-lp/workspace/paperclip "$COUNCIL_HOST_PROOF_DIR/paperclip"
git -C "$COUNCIL_HOST_PROOF_DIR/paperclip" checkout --detach 61b3fd57a695614dc4a37e2303f426a34a9795cf
while IFS= read -r -d '' source_dir; do
  relative_path=${source_dir#/home/davy-lp/workspace/paperclip/}
  if [ "$relative_path" != node_modules ] && [ -d "$COUNCIL_HOST_PROOF_DIR/paperclip/${relative_path%/node_modules}" ]; then
    ln -s "$source_dir" "$COUNCIL_HOST_PROOF_DIR/paperclip/$relative_path"
  fi
done < <(find /home/davy-lp/workspace/paperclip -path '*/node_modules' -prune -print0)
ln -s /home/davy-lp/workspace/paperclip/node_modules "$COUNCIL_HOST_PROOF_DIR/paperclip/node_modules"

COREPACK_HOME=/tmp/council-s1-corepack \
COUNCIL_PACKAGE_EXPECTED_COMMIT=fd4661dc3d3c665f5a2819b62abfb5db856c5fdd \
PAPERCLIP_TEST_HOST_ROOT="$COUNCIL_HOST_PROOF_DIR/paperclip" \
PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH=/home/davy-lp/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
COUNCIL_PACKAGE_EVIDENCE_PATH="$PWD/docs/reviews/s1/evidence/functional.json" \
COUNCIL_UI_SCREENSHOT_PATH="$PWD/docs/reviews/s1/evidence/ui-page.png" \
pnpm test:functional
rm -rf -- "$COUNCIL_HOST_PROOF_DIR"
```

Expected: typecheck/build succeed; 6 test files and 32 tests pass; functional output ends with `SPRINT 1 CONFIGURATION INCREMENT VALIDATED` and every result is `PASS`.

## Independent-review remediation

The first independent review correctly rejected the earlier candidate: pair activation could update one current head before discovering that the other expected version was stale, and the replay accepted a dirty host checkout. The rebased candidate `fd4661d` contains both remediations. Activation now locks and counts both eligible heads inside the single permitted `UPDATE` statement before mutation; the real-host replay asserts an asymmetric `409` leaves both heads at draft/version 1. The harness also rejects tracked host drift, and the successful post-rebase replay used a clean detached clone of the exact host commit. The initial failure evidence remains outside the repository as diagnostic history and is not closure proof.

## Deferrals and next minimum

- Close this bounded Sprint 1 increment only. Do not close L1 or V1.
- The smallest next product increment is L2 mission persistence with an exact pinned roster revision and explicit proof that later roster edits do not alter an active mission.
- Before any affected dispatch, retain the existing DEP-G4 blocker or qualify an atomic task/period reservation and native in-flight exposure contract.
- Before L3 application recovery, retain DEP-G3 or qualify supported canonical decision readback after an uncertain response.
- Durable activation, real agents, budgets, owner-account setup, provider/model execution and external delivery require separate explicit inputs and authorization.
