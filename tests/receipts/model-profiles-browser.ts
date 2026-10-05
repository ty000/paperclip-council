import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { MODEL_CATALOGUE, MODEL_PROFILES } from "../../src/model-catalogue.js";
import type { ModelEstimate } from "../../src/model-estimates.js";
import type { VariantInspection } from "../../src/model-variants.js";

// Isolated GET fixtures only. This never connects to a Paperclip instance.
const output = process.env.COUNCIL_MODEL_UI_EVIDENCE_DIR;
const host = process.env.PAPERCLIP_TEST_HOST_ROOT;
assert(output && host, "Set fresh COUNCIL_MODEL_UI_EVIDENCE_DIR and PAPERCLIP_TEST_HOST_ROOT");
await mkdir(output, { recursive: false });
const requireUi = createRequire(resolve(host, "ui/package.json"));
const { chromium } = requireUi("@playwright/test");
const estimates: ModelEstimate[] = [
  { roleKey: "generalist-reviewer", family: "review", profileId: "sol-high", mappingRevision: "1", variantRevision: "1", sampleCount: 2, inputTokens: 1500, outputTokens: 250, durationMs: 6000 },
  { roleKey: "security-reviewer", family: "review", profileId: "sol-high", mappingRevision: "1", variantRevision: "1", sampleCount: 3, inputTokens: 900, outputTokens: null, durationMs: 2000 },
  { roleKey: "generalist-reviewer", family: "review", profileId: "sol-high", mappingRevision: "2", variantRevision: "1", sampleCount: 1, inputTokens: 99999, outputTokens: 99999, durationMs: 99999 },
];
const variants: VariantInspection[] = [
  { roleKey: "generalist-reviewer", profileId: "sol-medium", revision: "1", logicalAgentId: "inventory-logical-ready", agentId: "inventory-physical-ready", ready: true,
    expected: { model: "gpt-5.6-sol", effort: "medium" }, observed: { model: "gpt-5.6-sol", effort: "medium", availability: "configured" }, gaps: [] },
  { roleKey: "security-reviewer", profileId: "astra-high", revision: "1", logicalAgentId: "inventory-logical-missing", agentId: null, ready: false,
    expected: { model: "gpt-6-astra", effort: "high" }, observed: { availability: "missing" }, gaps: ["variant_missing"] },
];
const catalogue = { mapping: MODEL_CATALOGUE, profiles: MODEL_PROFILES, estimates, variants, roles: [
  { key: "generalist-reviewer", title: "Generalist Reviewer", revision: "1" }, { key: "security-reviewer", title: "Security Reviewer", revision: "1" },
], enabledForNewMissions: true, availability: "not_validated_live", estimate: "indicative" };
const launch = { taskKey: "task-1", interventionKey: "review-1", launchKey: "launch-2", logicalAgentId: "logical-reviewer-1", agentId: "physical-reviewer-sol-high-v1",
  roleKey: "generalist-reviewer", profileId: "sol-high", requestedProfileId: "sol-high", family: "review", rationale: "Inspect the changed authorization boundary.",
  authority: "user", mappingRevision: "1", variantRevision: "1", selectedAt: "2026-10-05T12:00:00Z", state: "bound", issueId: "issue-1", runId: "run-2", ascent: true,
  // Rendering fixture only; this does not qualify native fallback execution.
  fallback: { from: "astra-high", reason: "Alternative confirmed unavailable before execution." },
  history: { indexKey: "council-history-fixture-index", gapCount: 2, cutoff: "2026-10-05T11:59:00Z" } };
const uncalibrated = { ...launch, interventionKey: "review-new", launchKey: "launch-3", profileId: "astra-high", requestedProfileId: "astra-high",
  agentId: "physical-reviewer-astra-high-v1", rationale: "New review awaiting comparable history.", state: "selected", runId: null, ascent: false, fallback: undefined, history: undefined };
const inspection = { estimates, state: { protocol: "native-variants-v1", choices: [], tasks: [{ taskKey: "task-1", mapping: MODEL_CATALOGUE, variantRevision: "1", ascentLaunchKey: "launch-2", launches: [launch, uncalibrated] }] },
  statuses: [{ launchKey: "launch-2", ready: false, expected: { model: "gpt-5.6-sol", effort: "high" }, observed: { model: "other-model", availability: "blocked" }, gaps: ["adapter_config_drift:model"] }],
  measurements: [{ taskKey: "task-1", runCount: 2, inputTokens: 1200, outputTokens: 350, durationMs: 4500 }] };
const bundle = await build({
  stdin: { contents: `import {createRoot} from "react-dom/client"; import {useState} from "react";
    import {ModelProfilesPanel} from "./src/ui/model-profiles-panel.tsx";
    function Fixture(){ const [companyId,setCompany]=useState("company-1"); return <>
      <nav aria-label="Fixture controls">{["company-1","company-inventory","company-slow","company-2","company-error",""] .map(id=><button key={id} onClick={()=>setCompany(id)}>{id||"No company"}</button>)}</nav>
      <ModelProfilesPanel companyId={companyId} missionId={companyId==="company-inventory"?null:"mission-1"}/></>; }
    createRoot(document.getElementById("root")).render(<Fixture/>);`, resolveDir: process.cwd(), loader: "tsx" },
  bundle: true, write: false, format: "iife", jsx: "automatic",
  alias: { "react-dom/client": requireUi.resolve("react-dom/client"), react: dirname(requireUi.resolve("react")) },
});
const requests: Array<{ method: string; path: string }> = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  requests.push({ method: request.method ?? "", path: url.pathname });
  if (request.method !== "GET") { response.writeHead(405); response.end(); return; }
  if (url.pathname === "/bundle.js") { response.setHeader("content-type", "application/javascript"); response.end(bundle.outputFiles[0]!.text); return; }
  if (url.pathname.startsWith("/api/")) {
    const company = url.searchParams.get("companyId");
    if (company === "company-1") await new Promise(done => setTimeout(done, 100));
    if (company === "company-slow") await new Promise(done => setTimeout(done, 400));
    response.setHeader("content-type", "application/json");
    if (company === "company-error") { response.writeHead(503); response.end(JSON.stringify({ error: "fixture unavailable" })); return; }
    response.end(JSON.stringify(url.pathname.includes("/missions/") ? company === "company-2" ? { state: null, statuses: [], measurements: [] } : inspection
      : company === "company-2" ? { ...catalogue, variants: [] } : catalogue)); return;
  }
  response.setHeader("content-type", "text/html");
  response.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Council profile fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--border:#cbd5e1}*{box-sizing:border-box}body{font:16px system-ui;color:#172033;background:#fff;margin:0;padding:16px}nav{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}button{padding:8px}#root{max-width:1200px;margin:auto}a{color:#1749b0}</style><h1>Council profiles — isolated fixture</h1><div id="root"></div><script src="/bundle.js"></script></html>');
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert(address && typeof address !== "string");
let browser: any;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.route("**/*", async (route: any) => {
    assert(new URL(route.request().url()).origin === `http://127.0.0.1:${address.port}`, "No external network permitted");
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${address.port}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Loading model catalogue…", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "review-1 · gpt-5.6-sol · high", exact: true }).waitFor();
  const panel = page.getByRole("region", { name: "Model profiles", exact: true });
  assert.equal(await panel.locator("tbody tr").count(), 7);
  assert.equal(await panel.getByRole("button").count(), 0, "Read panel has no mutation control");
  await panel.getByText(/Inspect the changed authorization boundary/).waitFor();
  await panel.getByText(/input 1,200 tokens · output 350 tokens · duration 4.5 s/).waitFor();
  await panel.getByText(/History: 2 gaps/).waitFor();
  const reviewed = panel.getByRole("article", { name: "Intervention review-1", exact: true });
  await reviewed.getByText("logical-reviewer-1", { exact: true }).waitFor();
  await reviewed.getByText("physical-reviewer-sol-high-v1", { exact: true }).waitFor();
  await reviewed.getByText(/Indicative estimate: 2 comparable successful runs · input 1,500 tokens · output 250 tokens · duration 6 s/).waitFor();
  await panel.getByRole("article", { name: "Intervention review-new", exact: true }).getByText("Indicative estimate: Not calibrated", { exact: true }).waitFor();
  await panel.getByText(/Generalist Reviewer: 2 comparable successful runs/).waitFor();
  await panel.getByText(/Security Reviewer: 3 comparable successful runs · input 900 tokens · output Unavailable tokens/).waitFor();
  await panel.getByText(/latest 50 company missions/).waitFor();
  assert.equal(await panel.getByText(/99,999/).count(), 0, "Different mapping revision is not comparable");
  await panel.getByText("Expected and observed configuration", { exact: true }).click();
  await panel.getByText(/"other-model"/).waitFor();
  await panel.getByText("Preconfigured variants (2)", { exact: true }).click();
  const readyVariant = panel.getByRole("article", { name: "Variant generalist-reviewer sol-medium revision 1", exact: true });
  const missingVariant = panel.getByRole("article", { name: "Variant security-reviewer astra-high revision 1", exact: true });
  await readyVariant.getByText("Configuration: matches expected settings.", { exact: true }).waitFor();
  await readyVariant.getByText("inventory-physical-ready", { exact: true }).waitFor();
  await missingVariant.getByText("variant_missing", { exact: true }).waitFor();
  await missingVariant.getByText("Not prepared or unreadable", { exact: true }).waitFor();
  await missingVariant.getByText("Expected and observed variant settings", { exact: true }).click();
  await missingVariant.getByText(/"missing"/).waitFor();
  await page.screenshot({ path: resolve(output, "profiles-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile body must not overflow");
  await page.screenshot({ path: resolve(output, "profiles-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "company-inventory", exact: true }).click();
  await panel.getByText("Select a mission to inspect its selected variants.", { exact: true }).waitFor();
  await panel.getByText("Preconfigured variants (2)", { exact: true }).click();
  await readyVariant.getByText("inventory-physical-ready", { exact: true }).waitFor();
  await missingVariant.getByText("variant_missing", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("article", { name: "Intervention review-1", exact: true }).count(), 0);
  assert(!requests.some(request => request.path.includes("company-inventory/missions/")), "Prelaunch inventory needs no mission request");
  await page.screenshot({ path: resolve(output, "inventory-no-mission.png"), fullPage: true });
  await page.getByRole("button", { name: "company-slow", exact: true }).click();
  await panel.getByText("Loading mission profiles…", { exact: true }).waitFor();
  assert.equal(await panel.getByText("logical-reviewer-1", { exact: true }).count(), 0, "Prior identity hidden during loading");
  await page.getByRole("button", { name: "company-2", exact: true }).click();
  await panel.getByText(/This mission has no variant bindings/).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await panel.getByText("logical-reviewer-1", { exact: true }).count(), 0, "Late prior-company response ignored");
  await page.getByRole("button", { name: "company-error", exact: true }).click();
  await panel.getByRole("alert").first().waitFor();
  assert.equal(await panel.locator("tbody tr").count(), 7, "Seven families remain visible on error");
  assert.equal(await panel.getByText("logical-reviewer-1", { exact: true }).count(), 0);
  await page.screenshot({ path: resolve(output, "profiles-error.png"), fullPage: true });
  await page.getByRole("button", { name: "No company", exact: true }).click();
  await panel.getByText("Select a company to inspect model profiles.", { exact: true }).waitFor();
  assert.equal(await panel.getByRole("alert").count(), 0);
  assert.deepEqual(errors, []);
  assert(requests.every(request => request.method === "GET"));
  const screenshots = await Promise.all(["profiles-desktop.png", "profiles-mobile.png", "profiles-error.png", "inventory-no-mission.png"].map(async name => ({ name, bytes: (await stat(resolve(output, name))).size })));
  assert(screenshots.every(image => image.bytes > 0));
  const result = { scope: "isolated-component-fixtures", nativeRuntime: false, pass: true,
    checks: ["seven-families", "profile-rationale-identities", "mapping-ascent-fallback-render-only", "history-gaps", "observed-tokens-duration", "calibrated-estimate", "uncalibrated-estimate", "role-specific-estimates", "estimate-revision-filter", "estimate-history-window", "expected-observed-drift", "preconfigured-ready-variant", "preconfigured-missing-variant", "inventory-without-mission", "loading", "legacy-empty", "error", "company-reset", "stale-response-rejection", "responsive", "GET-only"],
    requests, pageErrors: errors, screenshots };
  await writeFile(resolve(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await new Promise<void>(done => server.close(() => done()));
}
