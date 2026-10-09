# Campaign closure authority and proof guard

Refs #73. Base: `38483d5ab3d26ecfae7b1a5ca8b8e1d0b2e8e8b4` (version 0.7.31).

After the terminal Linear publication was acknowledged, the campaign could close
native parents without rechecking the current project/company authority. It could
also mark its aggregate closed after the pinned global proof document disappeared
or changed revision. Local regression witnesses reproduced both paths.

Every new native closure claim and the final aggregate closure now require the
existing project departure guard and the exact published proof body and revision.
This covers owner replacement, disabled/revised project policy, operating-profile
drift, missing evidence, changed content and same-content/new-revision rewrites.
Finalization reads the document without creating or replacing it.

A previously claimed native effect retains its identity. A Done readback can be
confirmed while authority is revoked, but no new parent PATCH or aggregate closure
is authorized. An uncertain readback stays claimed without repeating its PATCH.
When the original authority and proof become valid again, the existing closure can
continue without another review, publication, reservation or wake.

## Local checks

```sh
pnpm exec vitest run --config ./vitest.config.ts tests/campaign-closure-runtime.spec.ts
pnpm test
pnpm typecheck
pnpm build
pnpm audit:static --base-ref 38483d5ab3d26ecfae7b1a5ca8b8e1d0b2e8e8b4
pnpm audit:static --base-ref 91b4e583abf6e1b47796a4501f07e9953175c670
```

The targeted suite passes 17 tests. The full suite passes 1,286 tests with one
existing skip; typecheck, build and the Fallow 3.23.0 diff gate pass. Closure tests
use the real authority predicate for owner/policy/profile revocation and simulated
database CAS and native issue/document responses. They do not prove concurrent
host behavior.

The cumulative stack gate also passes after extracting the existing intake
authority predicate into a local helper. The closed-campaign early return,
short-circuit conditions, awaited checks and subsequent CAS/effect order are
unchanged. The 45 intake/campaign-conflict tests pass; no gate or threshold changed.

The historical installed campaign receipt remains bound to Council `ee6535a`
and its recorded intake/host pair. It has not been replayed with this new guard.
No native host qualification, recette activation or provider execution was run
for this change. Integration onto main must retain its newer version and the
existing workflow, publication-authority and composed-validation contracts.
