# Replay the npm package pair qualification

This qualification exercises built Council and Linear Intake archives through
Paperclip's real npm installation path. It serves the two candidate archives
from a temporary read-only registry on loopback; dependencies come from the
public npm registry. Nothing is published. No npm login is needed.

## Inputs and execution

Use Node 24.11 or newer, pnpm 9.15.4 for Council, npm 11.19.0 for Intake,
Python 3, Git and tar. Keep the source worktrees and Paperclip instance data
separate. The native host helper requires a clean Paperclip checkout at exactly
`61b3fd57a695614dc4a37e2303f426a34a9795cf`; another Paperclip release needs a new
qualification rather than an assumed compatibility claim.

1. In the Intake checkout, run `npm ci`, `npm run check`, and
   `npm run test:package`. Retain the archive in `artifacts/package/`.
2. In this Council checkout, run `pnpm install --frozen-lockfile`,
   `node scripts/ci/run-checks.mjs`, and `pnpm test:package -- --output-dir
   /absolute/empty/council-packages`. Retain that exact archive.
3. Prepare the owned host clone from an available Paperclip source checkout:

   ```sh
   PAPERCLIP_QUALIFICATION_SOURCE=/absolute/paperclip-source \
     pnpm qualification:host:prepare
   pnpm qualification:host:verify
   ```

4. Run the pair test from this checkout, selecting both exact archives:

   ```sh
   PAPERCLIP_TEST_HOST_ROOT="$PWD/.paperclip/qualification/paperclip" \
   COUNCIL_PACKAGE_TARBALL=/absolute/council-packages/ty000-paperclip-council-0.7.42.tgz \
   INTAKE_PACKAGE_TARBALL=/absolute/intake/artifacts/package/ty000-paperclip-linear-intake-0.6.2.tgz \
     pnpm qualification:package-pair
   ```

The final JSON line names `.runtime/lot4/native-*/npm-package-proof.json`.
Keep its archive SHA-256/integrity values with the candidate being evaluated.
The proof records whether the Council test checkout was dirty. Source commit
IDs alone do not identify an archive built from a dirty worktree.

## Assertions and limits

The test starts a fresh embedded PostgreSQL database and a real loopback
Paperclip API. It creates one synthetic company and a non-running agent solely
for Council authentication. Intake retains its disabled default configuration.
It checks:

- Registry installation by explicit name/version, with no local package path.
- Stable manifest IDs and successful native SQL migrations for both plugins.
- Worker PID changes after disable/enable and a same-version npm upgrade.
- Configuration and migration-ledger preservation, installed versions and health.
- Zero issues, heartbeat runs and wake requests; shutdown of workers, server and
  database; unchanged tracked host files.

Council's configured worker reports `ok`. Intake's worker reports `degraded`
while disabled; this is expected. The host plugin records still report `ready`.

This is a package installation/reload qualification, not a version-to-version
data migration, full server reboot, public-registry download, provider campaign,
Linear webhook, Council admission or VPS deployment test. The host clone and
private test runtime are retained locally for inspection. This opt-in test is
not a substitute for the per-repository package smoke run by release CI.
