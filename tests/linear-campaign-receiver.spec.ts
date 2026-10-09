import { describe, expect, it } from "vitest";
import { campaignFixture } from "./linear-campaign-fixture.js";
import { linearFixture } from "./linear-intake-fixture.js";
import { readLinearIntake } from "../src/linear-intake-validation.js";
import { validateLinearCampaign } from "../src/linear-campaign-validation.js";
import { parseLinearReadiness, parseLinearSource } from "../src/linear-intake-contract.js";

describe("fixed milestone campaign receiver", () => {
  it("accepts a complete native readback while retaining original external Linear parents", async () => {
    const f = campaignFixture();
    const snapshot = await readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory());
    expect(snapshot.body.campaign).toEqual(f.campaign);
    expect(snapshot.nodes.find(node => node.nativeId === f.ids.alpha)?.parentId).toBe(f.ids.root);
    const doc = parseLinearSource(f.documents.get(f.docKey(f.ids.alpha!, "linear-source-v1")).body);
    expect(doc.source.parentId).toBe("External Linear parent");
    expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(["policy", "mapping", "material", "state", "reference", "duplicate-root"])("rejects inconsistent %s before preparation effects", async kind => {
    const f = campaignFixture();
    if (kind === "policy") delete f.policy.content.linearContinuity;
    if (kind === "mapping") f.campaign.nativeMapping[1]!.sourceParentId = "Invented parent";
    if (kind === "material") f.campaign.materialSourceSha256 = "a".repeat(64);
    if (kind === "state") f.campaign.stateCompatibility.observationSha256 = "b".repeat(64);
    if (kind === "reference") f.sourceDocuments[0]!.campaign.referenceContents.prd.content += "changed";
    if (kind === "duplicate-root") f.sourceDocuments[1]!.campaign = f.sourceDocuments[0]!.campaign;
    const body = parseLinearReadiness(JSON.stringify({ ...f.readiness, campaign: f.campaign }));
    expect(() => validateLinearCampaign(f.policy, body, f.sourceDocuments)).toThrow();
    expect(f.update).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
  it("does not silently interpret an ordinary Todo as a fixed milestone campaign", async () => {
    const f = linearFixture();
    f.policy.content.linearContinuity = { protocol: "council-linear-continuity-v1", mode: "milestone-fixed-v1" };
    await expect(readLinearIntake(f.ctx, f.policy, f.ids.root!, f.inventory())).rejects.toMatchObject({ code: "linear_campaign_policy" });
  });
  it("rejects an invented native parent even if both campaign copies agree", () => {
    const f = campaignFixture();
    f.campaign.nativeMapping[1]!.nativeParentSourceId = f.ids["source-beta"]!;
    f.refreshReadiness();
    expect(() => validateLinearCampaign(f.policy, parseLinearReadiness(f.readinessDocument.body), f.sourceDocuments)).toThrow();
  });
});
