# npm release and installation

The public package name is `@ty000/paperclip-council`. Its Paperclip identity
remains `private.paperclip-council`, and its database namespace remains
`private_paperclip_council`. A package rename or release must never rename either
runtime identity.

Version `0.7.45` was published on 2026-10-10. Publication does not imply host
installation or activation.

## What each check proves

| State | Evidence | Does not prove |
| --- | --- | --- |
| Source | typecheck, unit tests, Python operation tests, build, Fallow diff gate | npm archive contents or installability |
| Package | `pnpm test:package` builds and packs, enforces the archive allowlist, installs the `.tgz` with `--ignore-scripts --omit=dev`, and loads the installed manifest and worker health hook | Paperclip host installation, migrations, restart, or plugin composition |
| Native | an explicit Paperclip install/readback qualification observes the package version, manifest, worker, migrations and restart | provider access, model quality, or target deployment |
| Provider | a separately authorized campaign records the provider, model, usage and business result | implied by any earlier state |

Keep these states separate in release notes and operational evidence.
For the opt-in native archive test, follow the
[npm package pair replay guide](docs/qualification/npm-packages.md).

## Package qualification

From a clean checkout with Node 24.11 or newer:

```sh
pnpm install --frozen-lockfile
pnpm test:package
```

To retain the tested archive for inspection, use an empty directory outside the
checkout:

```sh
pnpm test:package -- --output-dir /absolute/empty/release-artifacts
```

The archive contains `dist/` (including UI, manifest and worker), `migrations/`,
the six Python operation scripts declared in `package.json`, `README.md`,
`LICENSE`, and `package.json`. The smoke refuses source, tests, qualification
evidence, local runtime data, caches and undeclared operation scripts. The
installed consumer does not run package lifecycle scripts or install this
repository's development dependencies.

## One-time bootstrap for a new npm package

For a future package name that does not yet exist, an authorized maintainer
must bootstrap it once before configuring its npm trusted publisher:

1. Select and record a new first release version for that package name.
2. Synchronize `package.json` and `src/manifest.ts`, run all source and package
   checks, and retain the exact `.tgz` plus its digest.
3. Use an interactive npm web login with 2FA and publish that exact archive once:

   ```sh
   npm login
   npm publish /absolute/path/to/ty000-paperclip-council-<VERSION>.tgz --access public --tag <latest-or-next>
   ```

   Use `next` when `<VERSION>` contains a prerelease suffix and `latest` for a
   stable version. Do not create a durable npm automation token. Do not push a
   `v<VERSION>` tag for this manual bootstrap version: `release.yml` would try to
   publish the already-used name/version.
4. Create the GitHub environment `npm-release` and configure its reviewer and
   tag restrictions for releases. In npm package settings, add a GitHub Actions trusted publisher with user or
   organization `ty000`, repository `paperclip-council`, workflow filename
   `release.yml`, and environment `npm-release`. Explicitly enable **Allow npm
   publish**; trusted publishers created after 2026-09-03 otherwise default to
   staged publication only.
5. Within two days, publish a separately authorized, newly versioned release
   through the tag workflow. An unvalidated trusted-publisher configuration
   expires after two days and must then be deleted and recreated.
6. After OIDC publication succeeds, set npm publishing access to require 2FA and
   disallow token publication.

The steady-state workflow uses npm `11.19.0` on Node `24.11.0` and a GitHub-hosted
runner. It has `contents: read` throughout and grants `id-token: write` only to
the `publish` job. There is no npm secret. npm `11.19.0` is below the current
OIDC `npm dist-tag` requirement (`11.21.0` or later), so the workflow selects
`next` or `latest` in the original `npm publish --tag` command and performs no
later OIDC dist-tag mutation.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/), and
[GitHub OIDC permissions](https://docs.github.com/en/actions/reference/security/oidc).

## Normal tagged release

Before pushing a tag, choose a new npm version and update both version fields.
The tag must be exactly `v<package version>`. A prerelease version publishes
under `next`; a stable version publishes under `latest`.

`.github/workflows/release.yml` runs only for `v*` tag pushes in
`ty000/paperclip-council`. Its non-publishing job runs the frozen install, pinned
Fallow gate, Python operation tests, typecheck, unit tests, build, pack and
package smoke. It uploads the one verified `.tgz` and SHA-256 sidecar. The
`npm-release` job downloads and re-verifies those exact bytes, checks tag,
package, manifest and namespace identity, and publishes that archive once
through OIDC. A separate read-only `verify` job checks registry visibility.
Pull requests and branch pushes cannot publish; ordinary CI runs for branches
and pull requests, while tags retain every release qualification gate.

## Registry visibility and verification-only recovery

The upload job makes exactly one `npm publish` call. Only that job has OIDC
permission and the `npm-release` environment. Registry verification has only
`contents: read` and `actions: read`, with no npm credentials or publication.
It compares the archive's name/version and SHA512 with registry metadata and
requires the selected `latest` or `next` tag to point to that exact version.

Visibility polling lasts at most 20 minutes, with at most 160 GETs and a
30-second limit per request (including response body). Temporary transport
errors and HTTP 404/429/5xx are retried within that budget; wrong integrity,
inconsistent metadata and permanent HTTP errors fail immediately. An old
or missing dist-tag waits within the same budget. No publication is retried.

If upload succeeded but verification failed, **do not rerun the failed release
job or publish again**. Run Actions → **Verify existing npm release** from the
trusted default branch and provide only the original release `run_id`, for
example `38059535926`. The workflow requires a completed `release.yml` tag-push
run in this repository, successful release qualification jobs, and its exact
unexpired package artifact. Version comes from that run's `v<version>` tag,
not the current checkout. It reads the archived `package.json` without executing
packaged code. An expired or missing artifact fails closed.

The original failed run remains red; a successful verification-only run is new,
separate evidence. This checks the dist-tag **now**: after a newer publication,
an older release can legitimately stop being `latest` or `next` and will not
pass this check. A timeout also stays red; investigate or replay verification
only, without another upload or automatic dist-tag change.

## Explicit installation and update

First confirm the Paperclip target diagnostics and the exact versions qualified
together. Install npm packages by explicit version:

```sh
paperclipai plugin install @ty000/paperclip-linear-intake --version <INTAKE_VERSION>
paperclipai plugin install @ty000/paperclip-council --version <COUNCIL_VERSION>
```

Package availability alone is not pair compatibility. Record the Paperclip host
version, both package versions, both manifest IDs, both worker health readbacks,
migration readbacks and a restart result before native activation. The plugins
remain separate: Linear Intake owns Linear retrieval/import; Council owns
admission, governed execution, review and verdict.

For an update, take a database backup first, inspect new capabilities, and call
the instance-admin upgrade surface with an explicit target version. Read back
the installed package version, status, manifest, migration ledger and worker
after restart before enabling work. Never allow an omitted version to resolve a
different `latest` during a controlled rollout.

## Rollback boundary

Package rollback and database rollback are distinct operations. Installing an
older npm version does not reverse namespace migrations or make newer persisted
state compatible. Disable or stop the affected plugin, preserve evidence, and
restore a verified pre-upgrade database backup in a maintenance window when a
database rollback is required. Do not delete migration ledger rows or the
plugin namespace by hand.

Council and Linear Intake have independent package versions, manifest IDs and
database namespaces. Roll back only the affected package unless pair evidence
shows a contract mismatch, and decide each database restoration independently.
No rollback procedure authorizes a provider run or target deployment.
