# Paperclip Council standalone extraction report

## Extraction

- Candidate repository: `paperclip-council`, branch
  `codex/extract-council-plugin`, based on
  `307101af5f3f28e57db52d6ec4a8725e1a7b9544`.
- Source behavior: read-only prototype
  `packages/plugins/paperclip-council/` in Paperclip commit
  `61b3fd57a695614dc4a37e2303f426a34a9795cf`.
- Extracted behavior: one agent-authenticated plugin route validates the
  configured Council identity, resolves its `secret_ref`, and maps explicit
  `changes_requested` / `approved` verdicts to Paperclip's native issue update.
- Standalone dependency boundary: exact registry packages
  `@paperclipai/plugin-sdk@2026.916.1` and
  `@paperclipai/shared@2026.916.1`; no workspace protocol, local tarball, or
  monorepo module link remains.
- Licensing: the repository's MIT license is retained. No additional source
  notice was present in the untracked prototype package.

## Candidate verification

Run from `/home/davy-lp/workspace/paperclip-council-extraction` on 2026-09-29:

| Command | Result |
| --- | --- |
| `pnpm install` | FAIL — pnpm's default global store was read-only (`ERR_PNPM_EROFS`); no package defect identified |
| `pnpm install --store-dir .pnpm-store` | PASS — 56 packages installed; exact SDK/shared releases resolved |
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 2 files, 4 tests |
| first `PAPERCLIP_TEST_HOST_ROOT=/home/davy-lp/workspace/paperclip pnpm test:functional` | FAIL — standalone harness retained monorepo-relative imports |
| `pnpm typecheck` after correction | PASS |
| second `PAPERCLIP_TEST_HOST_ROOT=/home/davy-lp/workspace/paperclip pnpm test:functional` | PASS — 6 functional checkpoints |

The affected typecheck and functional replay were rerun after the import fix.

Final verification before handoff:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --store-dir .pnpm-store` | PASS — lockfile current |
| `pnpm build` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm test` | PASS — 2 files, 4 tests |
| `PAPERCLIP_TEST_HOST_ROOT=/home/davy-lp/workspace/paperclip pnpm test:functional` | PASS — candidate loaded; 6 checkpoints |
| `pnpm pack --dry-run --pack-destination .runtime` | FAIL — pnpm 9 does not support `--dry-run`; no artifact produced |
| `pnpm pack --pack-destination .runtime` | PASS — package contents limited to `dist`, README, license, and metadata |

## Isolated candidate load and replay

The functional harness required the host checkout to resolve exactly to
`61b3fd57a695614dc4a37e2303f426a34a9795cf`. It created a fresh authenticated
Paperclip instance and embedded PostgreSQL cluster, built and installed this
candidate by local path through the normal plugin lifecycle, configured a
company-scoped encrypted secret reference, restarted the application, and
confirmed the plugin worker loaded.

All fixture agents, issues, execution policies, heartbeat runs, and result
markers were synthetic harness preparation. The executor and Council were
distinct synthetic agents. The replay persisted:

1. Executor V1 submission.
2. Council `changes_requested` decision for V1.
3. Executor corrected V2 submission.
4. Council `approved` decision for V2.
5. Native readback with final issue status `done`, last outcome `approved`, and
   two Council decisions attributed to two distinct active Council run IDs.

The Council token moved only in process memory from the native key response to a
fresh `local_encrypted` secret. The trace contains non-secret fixture IDs but no
tokens, cookies, passwords, raw request headers, or authentication files. The
temporary instance and database were removed by the harness. The redacted
structured trace remains ignored at `artifacts/functional.json` for Paperclip
attachment only; it is not part of Git.

## Real ticket review

Candidate self-tests are not acceptance. ETY-2 must transition through its
native review stage to the distinct Council. The Council must inspect the exact
local commit and attached evidence, rerun affected checks as needed, and persist
its own decision through the already installed supervising plugin. This report
does not pre-judge that decision.

## Human intervention and consumption

- Human intervention: the owner authorized this bounded extraction and
  uncapped run count on the existing Codex CLI / ChatGPT subscription. No later
  human correction or exception was needed during implementation.
- Available consumption: native billed-cents data does not price these
  subscription-backed runs. Cost is unknown, not zero.
- No paid API key, model call from the candidate, publication, push, PR,
  deployment, merge, or supervisor installation was performed.

## Limitations

- The plugin is trusted local code and uses the configured Council agent's
  standard key authority; Paperclip has no review-only key scope here.
- Secret rotation does not revoke the old Paperclip key; operators must revoke
  it separately after verifying the replacement.
- The extraction qualifies compatibility only with the named Paperclip commit,
  not an unverified release range.
- It does not implement Council reasoning, voting, learning, adversarial
  security, delivery control, durable production configuration, or external
  delivery.
