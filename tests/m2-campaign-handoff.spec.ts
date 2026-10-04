import { expect, it } from "vitest";
import { m2CampaignHandoff } from "./functional/m2-campaign-handoff.js";
import { m2MissionSpecs } from "./functional/m2-campaign-spec.js";
it("exposes one cumulative B publication and exact deferred dependency input, never a fabricated A subject or manual B wake", () => {
  const c = { companyId: "company", projectId: "project", missionId: "A", secondMission: { missionPath: "/B" },
    operatingProfile: { periodKey: "period", runReservationUnits: 2_000_000 }, agents: Object.fromEntries(["pm", "pmSuccessor", "facilitator", "lead", "quality"].map(id => [id, { id }])) };
  const a = { configureDelivery: {}, reconcileDelivery: {}, requestCorrection: {}, upgradeAcceptedBuild: {}, sequence: ["unsafe generic configure delivery"], activate: { allowed: true }, startLead: {}, missionId: "A" };
  const b = { configureDelivery: { cumulative: true }, activate: {}, startLead: {}, sequence: ["unsafe generic activate"], missionId: "B" };
  const handoff = m2CampaignHandoff(c, a, b);
  expect(handoff.missions.A).not.toHaveProperty("configureDelivery"); expect(handoff.missions.A).not.toHaveProperty("sequence"); expect(handoff.missions.A).not.toHaveProperty("upgradeAcceptedBuild"); expect(handoff.missions.A).toHaveProperty("activate");
  expect(handoff.missions.B).not.toHaveProperty("startLead"); expect(handoff.missions.B).not.toHaveProperty("sequence"); expect(handoff.missions.B.configureDelivery).toEqual({ cumulative: true });
  expect(handoff.configureDependency.body.sourceMissionId).toBe("A");
  expect(handoff.configureDependency.body.expectedResult.submissionId).toBe("READ_A_CURRENT_SUBMISSION_ID");
  expect(handoff.configureDependency.body.coordination.coordinatorAgentId).toBe("pm");
  expect(m2MissionSpecs.map(m => m.work.flatMap(w => w.ownedPaths))).toEqual([
    ["src/coordination-presentation.ts", "tests/coordination-presentation.spec.ts"], ["src/ui/coordination-panel.tsx", "src/ui/index.tsx"],
  ]);
});
