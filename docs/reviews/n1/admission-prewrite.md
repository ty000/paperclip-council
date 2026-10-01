# N1 G4 admission migration precontrol

Date: 2026-09-30 (Europe/Paris)

Scope: additive plugin-private admission storage only. No durable Paperclip
instance is inspected or changed by this precontrol.

## Candidate and host inspected

- Council base: `46669b3b77f760b0f481bb927d3ff3f53bf9b42c` on
  `codex/council-n1`.
- Repo-owned qualification host: Paperclip
  `61b3fd57a695614dc4a37e2303f426a34a9795cf`, prepared under the ignored
  `.paperclip/qualification/paperclip` sandbox.
- SDK/shared contract: `2026.916.1`. `PluginContext.db` exposes restricted
  single-statement `query` and `execute` calls plus affected row count. It
  exposes no plugin transaction, provider usage, price, budget, or exposure
  service.

## Applied migration and data inspection

The clean baseline was installed through `tests/functional/run.ts` in a fresh
ephemeral repo-owned harness before writing migration 004. Host activation
applied migrations 001 through 003 and the replay exercised persisted roster
revisions, roster heads, and missions across a worker restart. The run ended
with all 19 named storage and API checks passing; the optional browser launch
was non-conclusive because the local Playwright browser binary was absent.

The immutable source checksums observed before this write were:

| Migration | SHA-256 | Existing data exercised by the harness |
| --- | --- | --- |
| `001_foundation_probe.sql` | `f59c729d115d08fe91062eecd92e55ac57919dbe917af88fc628e4f71efbf7d2` | Existing table retained; no backfill planned. |
| `002_revisioned_rosters.sql` | `a81cdd28d5d069057267a389999bf4ebf820dcadd3b2daf621f1ab030dc055df` | Team/council revisions and heads were created, revised, suspended/retired, and read after restart. |
| `003_missions.sql` | `a8058452db90d51f2b90b857997e0d53c4abb798dd4034d89ce79161370cafe2` | A mission row with pinned roster revisions and command receipts survived restart and later roster changes. |

Paperclip records each applied plugin migration key and SHA-256 checksum in
`public.plugin_migrations` and rejects checksum drift. The harness applied the
above exact package files. No prior migration is rewritten by N1.

## Migration decision

Durable unsettled reservations are required for restart-safe G4 admission, so
in-memory or mission-aggregate-only state is insufficient. Migration 004 may
add one `admission_envelopes` table in the existing plugin namespace, keyed by
company and explicit period. The row contains a versioned JSON document so a
single compare-and-swap `UPDATE` can atomically account for the period,
per-task allowance, concurrency, attempt limits, and reservation state despite
the SDK's lack of multi-statement transactions.

The migration must have no backfill, no mutation of tables 001 through 003,
and no default monetary values. A new period remains absent until an authorized
caller supplies explicit measurement, allowance, exposure, and operational
limit inputs. Unknown inputs are persisted as blockers.

The component stores source labels and numeric inputs; it does not authenticate
their provenance or read provider usage. A caller-provided `known` value is
therefore configuration data, not proof of real measurement. Only the explicit
N1 fixture boundary may use deterministic fixture values, and those values
cannot qualify production G4.

## Prewrite verdict

`PASS` for an additive 004 migration under this boundary. Runtime G4 remains
unproven until the changed package is installed and competing admission,
settlement, and restart are replayed on the supported sandbox. The SDK cannot
atomically update both this envelope and a separate mission row; therefore a
crash between envelope reservation and mission CAS conservatively leaves the
allowance reserved and must never authorize a duplicate dispatch.
