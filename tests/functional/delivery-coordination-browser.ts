import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const accepted = {
  submissionId: "10000000-0000-4000-8000-000000000001",
  candidateCommit: "a".repeat(40), bundleSha256: "b".repeat(64),
  evidenceRevision: 0, mandateHash: "c".repeat(64),
};
const prUrl = "https://github.com/example/synthetic-council/pull/7";

function deliveryFixture(candidateCommit: string, state: "unknown" | "opened") {
  return {
    plan: { documentId: "synthetic-plan", revisionId: "synthetic-plan-v1" },
    authority: { publisherAgentId: "synthetic-publisher" },
    publication: {
      state, submission: { candidateCommit },
      observation: state === "opened" ? {
        url: prUrl, headSha: candidateCommit, state: "open", draft: false, matchesCandidate: true,
      } : null,
      checks: { headSha: candidateCommit, state: "passed" },
      reviews: { headSha: candidateCommit, state: "approved" },
    },
    ready: state === "opened", nativeReadbackFresh: state === "opened",
    nextActor: "synthetic-publisher",
    nextAction: state === "opened" ? "Hand off the observed PR; merge is separate" : "Inspect the uncertain publication without repeating it",
  };
}

function missionFixture(original: any, objective: string) {
  const inspection = structuredClone(original);
  inspection.mission.aggregate.mandate.objective = objective;
  // Only the display contract is simulated. No mission/decision is written.
  return { ...inspection, n1: null, n2: null, n3: null, n5: null, n6: null, admission: null };
}

async function visibleText(region: any, text: string) {
  await region.getByText(text, { exact: true }).waitFor({ state: "visible" });
}

async function inspectCandidateValues(region: any) {
  await visibleText(region, accepted.submissionId);
  await visibleText(region, accepted.candidateCommit);
  await visibleText(region, accepted.bundleSha256);
  await visibleText(region, String(accepted.evidenceRevision));
  await visibleText(region, accepted.mandateHash);
}

async function inspectCandidateFields(coordination: any) {
  await coordination.getByText("Source candidate identities", { exact: true }).click();
  const expected = coordination.getByRole("heading", { name: "Expected accepted candidate", exact: true }).locator("..");
  await inspectCandidateValues(expected);
}

async function inspectPopulatedPanels(page: any, missionsUrl: string, downstream: any, screenshotPath: string) {
  const coordination = page.getByRole("region", { name: "Coordination", exact: true });
  const delivery = page.getByRole("region", { name: "Delivery", exact: true });
  await page.goto(missionsUrl, { waitUntil: "networkidle" });
  await visibleText(coordination, "Coordination status: Coordination held");
  await visibleText(coordination, "Waiting: Source result has not been accepted and settled");
  await visibleText(coordination, "synthetic-coordinator");
  await visibleText(coordination, "high");
  await inspectCandidateFields(coordination);
  await visibleText(coordination, "Verified accepted candidate: not recorded");
  await visibleText(delivery, "Delivery status: Publication outcome unknown");
  await visibleText(delivery, "Next action: Inspect the uncertain publication without repeating it — actor synthetic-publisher");
  assert.equal(await delivery.getByRole("link", { name: /^Open pull request/ }).count(), 0);
  await page.screenshot({ path: resolve(screenshotPath, "held-unknown.png"), fullPage: true });

  downstream.n6.state = "verified";
  downstream.n6.blockage = null;
  downstream.n6.coordination.state = "released";
  downstream.n6.coordination.reason = "Exact accepted result and settled usage verified";
  downstream.n6.verifiedArtifact = { expectedResult: accepted };
  downstream.n6.nextActor = "synthetic-lead";
  downstream.n6.nextAction = "Start the authorized downstream mission";
  downstream.n5 = deliveryFixture("d".repeat(40), "opened");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await visibleText(coordination, "Coordination status: Coordination released");
  await visibleText(coordination, "Coordination reason: Exact accepted result and settled usage verified");
  assert.equal(await coordination.getByText(/^Waiting:/).count(), 0);
  await visibleText(coordination, "Next action: Start the authorized downstream mission — actor synthetic-lead");
  await inspectCandidateFields(coordination);
  const verified = coordination.getByRole("heading", { name: "Verified accepted candidate", exact: true }).locator("..");
  await inspectCandidateValues(verified);
  await visibleText(delivery, "Delivery status: Ready for handoff");
  assert.equal(await delivery.getByRole("link", { name: /^Open pull request/ }).getAttribute("href"), prUrl);
  await delivery.getByText("Technical delivery details", { exact: true }).click();
  assert.equal(await delivery.getByText("d".repeat(40), { exact: true }).count(), 2);
  await visibleText(delivery, "passed");
  await visibleText(delivery, "approved");
  await page.screenshot({ path: resolve(screenshotPath, "released-ready.png"), fullPage: true });

  downstream.n6.state = "started";
  downstream.n6.nextAction = "Continue the admitted downstream mission";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await visibleText(coordination, "Coordination status: Downstream mission started");
  await visibleText(coordination, "Coordination reason: Exact accepted result and settled usage verified");
  assert.equal(await coordination.getByText(/^Waiting:/).count(), 0);
  assert.equal(await coordination.getByRole("button").count(), 0, "inspection must not invent execution controls");
}

/** Installed UI with explicitly synthetic GET bodies, never a native mission proof. */
export async function runDeliveryCoordinationBrowser(options: {
  browser: any; authenticate(context: any): Promise<void>; baseUrl: string; companyId: string;
  sourceInspection: any; downstreamInspection: any; screenshotPath: string;
}) {
  const { browser, authenticate, baseUrl, companyId, screenshotPath } = options;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await authenticate(context);
  const source = missionFixture(options.sourceInspection, "Synthetic source A — accepted result");
  const downstream = missionFixture(options.downstreamInspection, "Synthetic dependent B — coordination");
  const sourceId = source.mission.missionId;
  assert.notEqual(sourceId, downstream.mission.missionId);
  source.n5 = deliveryFixture(accepted.candidateCommit, "opened");
  downstream.n5 = deliveryFixture("d".repeat(40), "unknown");
  downstream.n6 = {
    state: "waiting", blockage: "Source result has not been accepted and settled",
    sourceMissionId: sourceId, sourceRootIssueId: source.mission.rootIssueId,
    expectedResult: accepted, verifiedArtifact: null, publicationRequired: false,
    coordination: { state: "held", coordinatorAgentId: "synthetic-coordinator", priority: "high", reason: "Await the exact accepted predecessor result" },
    nextActor: "synthetic-coordinator", nextAction: "Reconcile the accepted source result",
  };
  let sourceInList = true;
  let exactSourceReads = 0;
  const pageErrors: string[] = [];
  const intercepted: Array<{ method: string; path: string; status: number }> = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => pageErrors.push(error.message));
    await page.route(`**/api/plugins/*/api/companies/${companyId}/missions**`, async (route: any) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(request.method(), "GET", "these browser scenarios must not issue mission commands");
      assert.equal(url.searchParams.get("companyId"), companyId);
      // Fetch first: exercise the real authenticated read route, then replace
      // its display payload only within this browser context.
      const response = await route.fetch();
      intercepted.push({ method: request.method(), path: url.pathname, status: response.status() });
      assert.equal(response.status(), 200);
      if (url.pathname.endsWith("/missions")) {
        await route.fulfill({ response, json: { missions: sourceInList ? [downstream, source] : [downstream] } });
      } else if (url.pathname.endsWith(`/missions/${downstream.mission.missionId}`)) {
        await route.fulfill({ response, json: downstream });
      } else {
        assert(url.pathname.endsWith(`/missions/${sourceId}`));
        exactSourceReads += 1;
        await route.fulfill({ response, json: source });
      }
    });
    await mkdir(screenshotPath, { recursive: true });
    const missionsUrl = `${baseUrl}/CPQ/council-missions`;
    await inspectPopulatedPanels(page, missionsUrl, downstream, screenshotPath);

    const navigation = [];
    for (const inList of [true, false]) {
      sourceInList = inList;
      await page.goto(missionsUrl, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: downstream.mission.aggregate.mandate.objective, exact: true }).waitFor();
      assert.equal(await page.locator(`option[value="${sourceId}"]`).count(), inList ? 1 : 0);
      const readsBefore = exactSourceReads;
      const link = page.getByRole("link", { name: "Open source mission", exact: true });
      assert.equal(await link.getAttribute("href"), `?missionId=${sourceId}`);
      await link.click();
      await page.getByRole("heading", { name: source.mission.aggregate.mandate.objective, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("missionId"), sourceId);
      assert.equal(await page.getByLabel("Select mission").inputValue(), sourceId);
      assert.equal(exactSourceReads > readsBefore, !inList, "an absent source must be read through its authenticated exact route");
      await visibleText(page.getByRole("region", { name: "Delivery", exact: true }), "Delivery status: Ready for handoff");
      await page.reload({ waitUntil: "networkidle" });
      await page.getByRole("heading", { name: source.mission.aggregate.mandate.objective, exact: true }).waitFor();
      assert.equal(await page.getByLabel("Select mission").inputValue(), sourceId);
      navigation.push({ sourceInList: inList, sourceSelected: true, reloadPreservedSelection: true, exactSourceReads: exactSourceReads - readsBefore });
    }
    await page.screenshot({ path: resolve(screenshotPath, "source-outside-list.png"), fullPage: true });
    assert.deepEqual(pageErrors, []);
    return {
      kind: "installed-browser-synthetic-response-fixtures", nativeMissionQualification: false,
      states: ["held/publication-unknown", "released/delivery-ready", "started"],
      navigation, intercepted, pageErrors, screenshotPath,
    };
  } finally {
    await context.close();
  }
}
