# M2 preparation: coordinated A → B, one cumulative PR

This is executable preparation, not authorization to run models or publish. It reuses the ordinary `prepare|session|stop` bootstrap and clean pinned host `61b3fd57a695614dc4a37e2303f426a34a9795cf`. The proposed controller source must be committed and clean. No Delivery or coordination UI is implemented by preparation.

A produces the pure `src/coordination-presentation.ts` projection and an independent `tests/coordination-presentation.spec.ts` contribution. B consumes the exact accepted A bundle, adds `src/ui/coordination-panel.tsx`, and integrates the summary in `src/ui/index.tsx`. Both have separate native roots, plans, contributions, specialist opinions and Council acceptance. **A has no publisher. Only B creates one cumulative A+B PR**, proposed repository `ty000/paperclip-council`, head `codex/council-delivery-m2-coordination-cards`, base `main`. No merge/deploy authority is implied.

The ten reused identities are lead, backend, frontend, Development, Quality, Council, publisher, PM, successor PM and facilitator. Seven delivery identities are used sequentially across missions. PM identities use native role `pm`, facilitator `general`; others report to the prepared PM. Plugin delegation, not the reporting line, determines decisions. All use explicit `codex_local`/`engine:cli`, proposed `gpt-5.6-sol`/`medium`, with timer/demand wakes disabled at preparation. Managed instruction bundles supply exact API/auth, role boundaries and terminal-closure rules. No Codex catalogue or extra skill installation is assumed; M2 plan skill lists start empty for the lead to refine only against actual availability.

Proposed envelope: **16 nominal runs with useful facilitation (A6+B7+PM/facilitator/successor3), maximum25 if A adds one four-run correction and B adds one five-run correction/publication; 2M reserved units/run and 50M total, maxConcurrent2, zero retries, one correction per mission, 150-minute period.** Fewer runs if facilitation is unnecessary. These inputs require a future concrete authorization; reservation is not a hard provider cap, and preparation does not reset or extend an executed period.

## Prepare a usable session

```sh
node -e 'const fs=require("fs"),cp=require("child_process");const p=JSON.parse(fs.readFileSync("qualification/ordinary-m2.example.json"));p.candidateSha=cp.execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();fs.writeFileSync("/tmp/council-m2-profile.json",JSON.stringify(p,null,2))'
PAPERCLIP_TEST_HOST_ROOT="$PWD/.paperclip/qualification/paperclip" pnpm qualification:ordinary session /tmp/council-m2-profile.json
```

`prepare` can replace `session` to destroy resources immediately after preparation. Session keeps this owned instance, two **inactive** missions, ten disabled agents, admission period, plans and fresh private owner auth available without waking anything. The isolated workspace has installed frozen-lockfile dependencies, correct GitHub origin and branch; plugin packagePath is this same directory, with same-path upgrade tested. Native credentials are inherited only during a future run, not copied. Host binary/auth presence does not prove access in the model subprocess. `test-environment` invokes a provider and is excluded.

Evidence `artifacts/ordinary-campaign-session-<source SHA>.json` contains real IDs and `ordinaryCampaign.handoff`, with one authoritative M2 sequence and separate mission payloads. It deliberately removes A publication/upgrade and B manual activation/start commands. Owner API curl configuration is a private mode-0600 file named in `ordinaryCampaign.session.ownerCurlConfig`; never print or commit it. The common [ordinary session recipe](../n5/ORDINARY-CAMPAIGN.md) explains local login, owner curl and cleanup mechanics; the M2 handoff governs business sequencing.

After future authorization, start A and use established owner assistance for terminal N1 child settlement/closure while lead demand wakes are held. As soon as A's actual review submission exists, configure B's exact dependency and PM mandate together—before acceptance when possible—to observe a real explained wait. Never invent a future tuple. Restore lead demand wakes for source correction/ordinary transitions; when B is admitted later, hold that lead's demand wakes again while its N1 children execute.

PM/facilitation can settle the real question of which next action belongs on the card while accepted source, scheduling permission and publication differ. Use facilitation only if that cooperation question remains unresolved. Owner may transfer coordinator between PM work items; successor reads the recorded outcome. If A is corrected to V2, perform the [bounded same-mandate owner rebind](COORDINATION.md), without new source/gate/effect IDs or a provider replay. This operator action is part of an eventual authorized campaign, not a mandatory separate human approval of each ordinary continuation.

B starts only via N6→N1. Its lead uses authenticated `inspect.n6Handoff`, downloads/verifies A's bundle, requires clean shared HEAD equal the accepted A candidate, and establishes that exact commit as B's base. Preserve A ancestry, GitHub origin and the cumulative branch; stop on mismatch rather than resetting. N5 authority is configured only for B from its current plan revision. On actual correction, same PR and explicit remote lease apply.

After all work is terminal/settled, install/reload the exact accepted cumulative build at this instance's packagePath and observe the actual UI. Preserve source/artifact hashes and native/Git evidence before stopping. No UI, real PM/facilitator judgment, provider access, campaign execution or PR success is qualified by the preparation snapshot.

```sh
pnpm qualification:ordinary stop artifacts/ordinary-campaign-session-<source SHA>.json
```

Wait for the original launcher to exit and confirm `session.state: stopped`, final run readback and owned runtime removal. Fields ending `AtPreparation` describe that snapshot only. The stop action touches only this owned session's resources.
