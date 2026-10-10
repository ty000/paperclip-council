import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { assertProjectDeparture } from "../src/project-mandate-guard.js";
import { canonicalPayloadHash } from "../src/mission-primitives.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { repositoryResumptionPublication } from "../src/repository-resumption-publication.js";

const f = vi.hoisted(() => ({ continuity: vi.fn(), repository: vi.fn() }));
// Transport freshness and receipt readback are exercised in linear-continuity.spec.ts.
vi.mock("../src/linear-continuity-control.js", () => ({ assertLinearContinuityDeparture: (...args: unknown[]) => f.continuity(...args) }));
vi.mock("../src/repository-occupation.js", () => ({ ensureMissionRepository: (...args: unknown[]) => f.repository(...args) }));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const mandate = { objective: "Original mandate" }, config = {};
  const resumption = { commandId: randomUUID(), payloadHash: "a".repeat(64), ownerUserId: "owner", policyRevisionId: "revision",
    resumedAt: new Date().toISOString(), heldIntakeVersion: 4,
    decision: { question: "Dépôt occupé", questionAuthor: "Council" as const, response: "Reprendre après vérification de sa libération",
      consequences: "Conserver le mandat et le budget ; départ après relecture du plan" } };
  const intake = { mission_id: "mission", state: { repositoryHold: { status: "released" }, repositoryResumptions: [resumption] } };
  const plan = { intentId: randomUUID(), payload: { campaignPlan: {}, ...repositoryResumptionPublication(intake.state) }, acknowledgement: { reference: {} } } as any;
  const m = { companyId: "company", projectId: "project", missionId: "mission", rootIssueId: "root", ownerUserId: "owner", aggregate: {
    mandate, projectMandate: { revisionId: "revision", operatingProfileHash: operatingProfileHash(config), mandateHash: canonicalPayloadHash(mandate) },
    linearContinuity: { mode: "milestone-fixed-v1", binding: { campaignId: "mission" }, publications: [plan] } } } as any;
  const policy = { company_id: "company", project_id: "project", version: 1, revision_id: "revision", authorized_by: "owner", content: { enabled: true } };
  const ctx = { db: { namespace: "test", query: async (sql: string) => sql.includes("project_task_intakes") ? [intake] : [policy] },
    config: { get: async () => config }, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) } } as any;
  return { ctx, m, intake, plan };
}

it.each(["missing plan", "pending ACK", "withdrawn", "other decision", "other text", "duplicate plan", "legacy decision"])("blocks dependent departures for %s despite an otherwise healthy campaign", async condition => {
  const x = fixture();
  if (condition === "missing plan") x.m.aggregate.linearContinuity.publications = [];
  if (condition === "pending ACK") delete x.plan.acknowledgement;
  if (condition === "withdrawn") x.plan.withdrawn = { reason: "retained" };
  if (condition === "other decision") x.plan.payload.repositoryResumption = { ...x.plan.payload.repositoryResumption, commandId: randomUUID() };
  if (condition === "other text") x.plan.payload.text = "La décision n'est pas publiée";
  if (condition === "duplicate plan") x.m.aggregate.linearContinuity.publications.push(structuredClone(x.plan));
  if (condition === "legacy decision") delete (x.intake.state.repositoryResumptions[0] as any).decision;
  await expect(assertProjectDeparture(x.ctx, x.m)).rejects.toMatchObject({ code: condition === "legacy decision" ? "repository_resume_decision_missing" : "repository_resume_publication_pending" });
  expect(f.repository).not.toHaveBeenCalled();
});

it("allows the exact confirmed decision without replacing the existing authority checks", async () => {
  const x = fixture();
  await expect(assertProjectDeparture(x.ctx, x.m)).resolves.toBeUndefined();
  expect(f.continuity).toHaveBeenCalledOnce(); expect(f.repository).toHaveBeenCalledOnce();
  f.continuity.mockRejectedValueOnce(new Error("receipt revision changed"));
  await expect(assertProjectDeparture(x.ctx, x.m)).rejects.toThrow("receipt revision changed");
  expect(f.repository).toHaveBeenCalledTimes(1);
});

it("keeps historical Todo recovery outside the fixed campaign publication requirement", async () => {
  const x = fixture(); delete x.m.aggregate.linearContinuity.mode;
  delete (x.intake.state.repositoryResumptions[0] as any).decision;
  x.m.aggregate.linearContinuity.publications = [];
  await expect(assertProjectDeparture(x.ctx, x.m)).resolves.toBeUndefined();
});

it("refuses text that the existing publisher would truncate", () => {
  const x = fixture(); x.intake.state.repositoryResumptions[0]!.decision.response = "x".repeat(4000);
  expect(() => repositoryResumptionPublication(x.intake.state)).toThrowError(/text bound/);
});
