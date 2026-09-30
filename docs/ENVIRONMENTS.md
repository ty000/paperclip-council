# Qualification environments

This repository uses explicit environment classes. Evidence never promotes
implicitly from one class to another.

| Class | Owned object | Supported claims | Unsupported claims |
| --- | --- | --- | --- |
| `package` | This source checkout and its deterministic checks | Build, types, unit contracts, candidate provenance | Paperclip installation, activation, runtime behavior |
| `local-sandbox` | `.paperclip/qualification/paperclip` plus a fresh runtime created by the functional harness | The exact replayed install, migrations, authentication, API, persistence and restart observations | Durability, multi-plugin composition, real-agent judgment, deployment |
| `integrated-recipe` | Read-only source checkout `/home/davy-lp/workspace/paperclip` plus a separately owned runtime and an explicit plugin manifest | Observed compatibility and interactions among every pinned plugin listed in the manifest | General compatibility, production, durable activation |
| `selected-target` | An explicitly fingerprinted instance, company and project | Installed/configured/readiness states that are read back from that target | Activation or execution without separate authority |
| `active-runtime` | An authorized target with real actors, secrets and budgets | Only attributed effects actually observed and read back | Extrapolation from package, sandbox or recipe evidence |

## Repo-owned sandbox

`qualification/environments.json` pins the Paperclip source and commit. The
following command creates an independent checkout and installs its dependencies
under the ignored `.paperclip/qualification/` root:

```sh
pnpm qualification:host:prepare
pnpm qualification:host:status
```

`PAPERCLIP_QUALIFICATION_SOURCE=/absolute/read-only/source` may provide Git
objects without making that source the qualification environment. The prepared
checkout must remain at the pinned commit with clean tracked files. Existing
dirty, foreign or differently pinned directories are refused rather than reset.
The pinned upstream commit has a known pnpm 9.15.4 lock-metadata mismatch. The
bootstrap accepts only the source lock digest and exact repaired lock/diff
digests recorded in `qualification/environments.json`, performs the frozen
install against that validated temporary repair, then restores the committed
lockfile and verifies that tracked host files are clean.
It then builds the pinned `@paperclipai/plugin-sdk` workspace and its declared
shared dependency, and verifies the exact runtime entry points required by the
Paperclip server before reporting `runtimeReady: true`.
Both generated entry points and the virtual-store lock are checked against
pinned digests. Reusing the checkout reruns the bounded lock repair, frozen
install and host build instead of trusting the mutable cache marker.

`pnpm qualification:bounded` requires a clean committed Council candidate,
verifies or prepares the host, then delegates to the existing functional
harness. That harness owns a fresh `PAPERCLIP_HOME`, instance ID, storage,
listener and embedded PostgreSQL cluster for one run and removes them afterward.
The bounded launcher also installs Chromium into the ignored repo-owned
qualification cache and rejects any final evidence whose candidate SHA or
verdict does not match the committed candidate. Providers and models remain
disabled. The host checkout and browser cache are reusable; the runtime instance
is intentionally ephemeral.

The launcher has five-minute browser-install and fifteen-minute functional-run
deadlines. It manages Playwright browser archives, not operating-system
packages: supported Linux/WSL hosts must already provide Chromium's native
libraries. CI bootstrap may install those packages explicitly; this repository
does not invoke privileged `playwright install --with-deps` implicitly.

## Integrated recipe

`/home/davy-lp/workspace/paperclip` is the source checkout for integrated recipe
work. This repository must not modify its tracked files, default user home,
database or durable instances. A recipe run uses a separately owned home and
records a manifest containing at least two plugins, with each plugin's ID,
commit or archive identity, built distribution digest, redacted configuration
and installation order. Without that manifest, a run is a single-plugin host
qualification, not a multi-plugin recipe result.

## State vocabulary

`installed`, `configured`, `worker-ready`, `prerequisites-ready`, `activated`,
`executed` and `effect-read-back` are distinct states. Package, sandbox or
recipe checks cannot claim activation, deployment or execution on another
target. Any non-sandbox installation requires a target fingerprint, explicit
authorization and native readback. Failures or incomplete cleanup remain
`fail` or `partial`; they are never converted to a green qualification.
