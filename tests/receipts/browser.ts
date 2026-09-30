import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

export async function checkReceiptBrowser(options: { read(): Promise<unknown>; act(payload: any, actor: string): Promise<unknown>; operationId: string }) {
  const host = process.env.PAPERCLIP_TEST_HOST_ROOT!;
  const requireUi = createRequire(resolve(host, "ui/package.json"));
  const { chromium } = requireUi("@playwright/test");
  const bundle = await build({
    stdin: { contents: 'import {createRoot} from "react-dom/client"; import {CouncilDecisionReceipts} from "./src/ui/decision-receipts.tsx"; createRoot(document.getElementById("root")).render(<CouncilDecisionReceipts/>);', resolveDir: process.cwd(), loader: "tsx" },
    bundle: true, write: false, format: "iife", jsx: "automatic",
    alias: { "@paperclipai/plugin-sdk/ui": resolve("tests/receipts/ui-fixture.tsx"), "react-dom/client": requireUi.resolve("react-dom/client"), react: dirname(requireUi.resolve("react")) },
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/bundle.js") { response.setHeader("content-type", "application/javascript"); return response.end(bundle.outputFiles[0]!.text); }
      if (request.url === "/data") { response.setHeader("content-type", "application/json"); return response.end(JSON.stringify(await options.read())); }
      if (request.url === "/action") {
        let body = ""; for await (const chunk of request) body += chunk;
        const result = await options.act(JSON.parse(body), String(request.headers["x-fixture-actor"]));
        response.setHeader("content-type", "application/json"); return response.end(JSON.stringify(result));
      }
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><html lang="en"><title>Council receipt fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--border:#889;--background:#fff}body{font:16px sans-serif;color:#18202b;margin:0}dd{margin-bottom:.7rem}button:disabled{opacity:.65}</style><h1>Council</h1><div id="root"></div><script src="/bundle.js"></script></html>');
    } catch { response.statusCode = 403; response.end("refused"); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address(); assert(address && typeof address !== "string");
  let browser: any;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PAPERCLIP_PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const failures: string[] = []; page.on("pageerror", (error: Error) => failures.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const item = page.getByRole("article", { name: `Decision ${options.operationId}`, exact: true });
    await item.getByText("Indeterminate — dependent Council actions blocked").waitFor();
    await item.getByLabel(`Owner note for ${options.operationId}`).fill("Investigated; native completion remains unknown.");
    await item.getByRole("button", { name: "Acknowledge uncertainty" }).click();
    await item.getByText(/acknowledge · owner/).waitFor();
    await page.reload();
    await item.getByText(/Investigated; native completion remains unknown./).waitFor();
    await item.getByRole("button", { name: "Record abandonment" }).click();
    await item.getByText(/abandon · owner/).waitFor();
    await item.getByText("Indeterminate — dependent Council actions blocked").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile viewport has no horizontal overflow");
    await page.goto(`http://127.0.0.1:${address.port}/?actor=intruder`);
    await item.getByText(/abandon · owner/).waitFor();
    assert.equal(await item.getByRole("button", { name: "Acknowledge uncertainty" }).isDisabled(), true);
    assert.equal(await item.getByRole("button", { name: "Record abandonment" }).isDisabled(), true);
    assert.deepEqual(failures, []);
  } finally { await browser?.close(); await new Promise<void>((done) => server.close(() => done())); }
}
