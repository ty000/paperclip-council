# Workspace preflight — autonomy issue #47, first tranche

An ordinary fixed-profile mission can now reject a sandbox that cannot write
the target clone's Git metadata before selecting a launch or creating its child
issue. The same probe runs again before claiming a wake, including replayed
preparation. No model turn, agent wake, GitHub call or real-index mutation is
part of this check. A failed probe retains the existing launch and admission
identities; it does not repair the workspace or authorize another attempt.

## Prepare and inspect a clone

Use the exact standalone clone, not a linked worktree whose Git directory belongs
to another checkout. Establish its expected HEAD and the **observed effective
native adapter Codex home** first. The probe requires an existing explicit home;
it neither searches for credentials nor copies or modifies its configuration.
The home must already trust the project if its project policy is to be consumed.
No automatic trust override is added.

```bash
python3 scripts/operations/workspace_preflight.py prepare \
  --repo /absolute/path/to/clone --expected-head <sha>

python3 scripts/operations/workspace_preflight.py probe \
  --repo /absolute/path/to/clone --expected-head <sha> \
  --codex-home /absolute/path/to/observed-native-home
```

`prepare` exclusively creates `.codex/config.toml` granting this clone's `.git`.
It refuses an existing file, a symlink, an unexpected HEAD or a shared Git
directory. It does not overwrite another policy, edit the native home, change
agent configuration, reset Git or grant access to a sibling checkout. Preparing
a policy is not a successful probe. This local file may be untracked; keep it
outside product changes according to the project's existing rules.

`probe` starts the local Codex app server and permits only `initialize`,
`config/read` and `command/exec`. It verifies the effective workspace-write
policy and rejects wider writable roots or another permissions profile. Network
access is disabled for this probe. Git writes an exclusively owned temporary
index inside `.git`; the real HEAD, index, worktree status, project policy and
home configuration must remain unchanged. Cleanup removes only the probe's
UUID paths. Output contains bounded structured evidence, not raw transport
diagnostics or authentication values. A refusal exits with code 1.

For Codex installations whose `command/exec` cannot locate `codex-linux-sandbox`,
pass `--sandbox-helper /absolute/path/to/native/codex` (the official Linux
multicall executable), or an existing dedicated helper. The tool creates a
temporary helper alias and supplies it to the probe's PATH. It does not install
an alias globally or bypass the sandbox. `--codex-command` can select an explicit
local executable. This projection does not prove the future native agent's PATH.

## Opt in future missions

Preserve the current company configuration and register this optional object
through the existing plugin configuration API:

```json
{
  "workspacePreflight": {
    "codexHome": "/absolute/path/to/observed-native-home",
    "codexCommand": "/absolute/path/to/codex",
    "sandboxHelper": "/absolute/path/to/native/codex"
  }
}
```

`codexHome` is required; executable fields are optional. This is supported only
with `modelVariantsEnabled: true` and `n2RuntimeProfile: "ordinary-cli-v1"`.
Unsupported combinations fail at mission creation rather than ignoring the
requested gate. Each new mission pins the registration. Changing company
configuration does not retrofit or rewrite historical missions. Without this
object, historical behavior remains available.

The check reads the current project's explicit primary workspace on every
launch. Fixed variants already reject per-issue adapter overrides and divergent
agent settings. Workspace changes therefore cause a fresh probe; no stored pass
is reused as permission to wake. Preparation and wake claims share this gate for
lead, contributor, specialist, reviewer, correction and publisher variants.

## Proof boundaries and remaining #47 work

A `pass` proves a local sandbox projection can write a temporary Git index in
the registered workspace while preserving the observed state. It does not prove
that a future native adapter selects the registered home, that its helper PATH
is available, that its skills are mounted, or that it can complete a model turn,
commit, push or create a PR. Re-register only after observing a changed effective
native home; never infer it from an interactive shell's home.

The GitHub publisher's actual credential/capability projection and its automated
pre-issue refusal remain in [#47](https://github.com/ty000/paperclip-council/issues/47).
Publication authority, draft compliance and subsequent corrections are tracked
separately in [#52](https://github.com/ty000/paperclip-council/issues/52). This
tranche can be installed independently with the new gate unconfigured; package
installation alone is not activation or native execution proof.
