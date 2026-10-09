import { beforeEach, expect, it, vi } from "vitest";
import { campaignMembersSafe } from "../src/repository-campaign.js";

const f = vi.hoisted(() => ({ members: new Map<string, any>(), bindings: [] as any[], uncertain: false }));
vi.mock("../src/missions.js", async original => ({ ...await original<any>(), getMission: async (_ctx: unknown, _company: string, id: string) => f.members.get(id) ?? null }));
vi.mock("../src/native-run-bindings.js", () => ({ nativeRunBindings: () => f.bindings }));
vi.mock("../src/linear-continuity-control.js", () => ({ uncertainLinearEffects: () => f.uncertain }));

const root = { companyId: "company", missionId: "root", projectId: "project", ownerUserId: "owner", aggregate: {} } as any;
function fixture() {
  const member = { companyId: "company", missionId: "leaf", projectId: "project", rootIssueId: "issue", ownerUserId: "owner",
    aggregate: { repositoryCampaign: { campaignRootMissionId: "root" }, completion: { state: "closed" } } };
  f.members.set(member.missionId, member);
  let issueStatus = "cancelled";
  let reservation = { missionId: "leaf", reservationId: "reservation", status: "settled", usage: { status: "known" }, remainingExposure: { status: "known", units: 0 } };
  const ctx = { db: { namespace: "test", query: vi.fn(async (sql: string) => sql.includes("admission_envelopes")
    ? [{ document: { reservations: [reservation] } }] : [{ company_id: "company", mission_id: "leaf" }]) },
    issues: { get: vi.fn(async () => ({ id: "issue", companyId: "company", projectId: "project", status: issueStatus, checkoutRunId: null, executionRunId: null })),
      summaries: { getOrchestration: vi.fn(async () => ({ runs: [], companyId: "company", issueId: "issue" })) } } } as any;
  return { member, ctx, reservation: (next: any) => { reservation = next; }, issueStatus: (next: string) => { issueStatus = next; } };
}
beforeEach(() => { f.members.clear(); f.bindings = []; f.uncertain = false; });

it("keeps root pause and release unsafe while any private member has exposure, uncertainty or lacks proof closure", async () => {
  const x = fixture();
  expect(await campaignMembersSafe(x.ctx, root, "closed")).toBe(true);
  x.reservation({ missionId: "leaf", reservationId: "reservation", status: "unsettled", usage: { status: "unknown" }, remainingExposure: { status: "unknown" } });
  expect(await campaignMembersSafe(x.ctx, root)).toBe(false);
  x.reservation({ missionId: "leaf", reservationId: "reservation", status: "settled", usage: { status: "known" }, remainingExposure: { status: "known", units: 0 } });
  f.uncertain = true; expect(await campaignMembersSafe(x.ctx, root)).toBe(false);
  f.uncertain = false; x.member.aggregate.completion.state = "closing";
  expect(await campaignMembersSafe(x.ctx, root, "closed")).toBe(false);
  expect(await campaignMembersSafe(x.ctx, root, "cancelled")).toBe(true);
  x.issueStatus("backlog"); expect(await campaignMembersSafe(x.ctx, root, "cancelled")).toBe(false);
});
