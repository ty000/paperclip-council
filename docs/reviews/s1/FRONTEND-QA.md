# Sprint 1 frontend QA

Verdict: **PASS for the installed Sprint 1 configuration page on the pinned host/candidate.**

Tested candidate: `bbfecc39c93f4a6a395f3447ff5b6f3233fb23b9`

Host: Paperclip `61b3fd57a695614dc4a37e2303f426a34a9795cf`

Browser: local Chromium headless shell revision 1243 at the explicit path recorded in `evidence/functional.json`

| Check | Method | Result |
| --- | --- | --- |
| Actual installed page and bridge | Real plugin install/restart, host route `/CPQ/council-rosters`, authenticated session | PASS |
| Owner action | Focus `New roster`, press Enter, select an existing integration lead, create draft, read success and saved roster | PASS |
| Loading and empty states | Delay the real installed data-bridge request on an empty fixture company; observe loading status then empty guidance | PASS |
| Error state | Intercept only the browser bridge transport with a deterministic `500`; observe visible alert | PASS |
| Unauthorized state | Second authenticated host administrator who is not the configured company owner sees read-only status and disabled mutation | PASS |
| Stale version | Publish a concurrent revision after page load; attempted browser revision receives visible stale alert | PASS |
| Lifecycle/history | API journey creates, validates/activates, revises, suspends and retires; current and historical revisions remain readable | PASS |
| Keyboard and focus | Native buttons/labels/selects; Enter activates focused `New roster`; action errors are focus targets | PASS |
| Non-color meaning | Text labels state owner/read-only, lifecycle, mission activation unavailable and G3/G4 partial | PASS |
| Narrow/reflow boundary | Layout uses responsive grids and horizontal table overflow; read-only scenario exercised at 760 px | PASS with limited visual breadth |

The screenshot `evidence/ui-page.png` captures the successful owner journey at 1180×820. Automated browser checks cover the acceptance states; visual inspection found no blocking clipping, missing labels or ambiguous activation claim in the captured viewport.

Limits: this is not broad cross-browser, mobile, screen-reader or design-system qualification. The error transport is deliberately injected at the browser boundary. No mission dashboard, review interface, provider behavior or L2 interaction is present or claimed.
