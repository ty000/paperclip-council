import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { canonicalPayloadHash, type MissionRecord } from "../src/missions.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";
import { assertProjectDeparture, assertProjectPaths, assertProjectPublication } from "../src/project-mandate-guard.js";

function fixture() {
  const config = { n2RuntimeProfile: "ordinary-cli-v1", n1OperatingProfile: { periodKey: "p" } };
  const mandate = { objective: "Pinned task" };
  const pinned = { revisionId: "revision", authorizedBy: "owner", operatingProfileHash: operatingProfileHash(config),
    mandateHash: canonicalPayloadHash(mandate), allowedPaths: ["src/safe"], publication: { publisherAgentId: "publisher", repository: "owner/repo", baseRef: "main", headRefPrefix: "codex/task" } };
  const m = { companyId: "company", projectId: "project", missionId: "mission", ownerUserId: "owner", aggregate: { mandate, projectMandate: pinned } } as unknown as MissionRecord;
  const row = { company_id: "company", project_id: "project", version: 1, revision_id: "revision", authorized_by: "owner", content: { enabled: true } };
  const ctx = { db: { namespace: "council", query: async () => [row] }, config: { get: async () => config }, companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) } } as unknown as PluginContext;
  return { ctx, m, row, config };
}
describe("pinned project departure authority", () => {
  it("accepts the pinned policy and prevents disabled, revised, owner and accounting drift before departures", async () => {
    const f = fixture(); await expect(assertProjectDeparture(f.ctx, f.m)).resolves.toBeUndefined();
    f.row.content.enabled = false; await expect(assertProjectDeparture(f.ctx, f.m)).rejects.toMatchObject({ code: "project_authority_changed" });
    f.row.content.enabled = true; f.row.revision_id = "new";
    await expect(assertProjectDeparture(f.ctx, f.m)).rejects.toMatchObject({ code: "project_authority_changed" });
    f.row.revision_id = "revision"; f.row.authorized_by = "other";
    await expect(assertProjectDeparture(f.ctx, f.m)).rejects.toMatchObject({ code: "project_authority_changed" });
    f.row.authorized_by = "owner"; f.config.n1OperatingProfile.periodKey = "reset";
    await expect(assertProjectDeparture(f.ctx, f.m)).rejects.toMatchObject({ code: "project_authority_changed" });
  });
  it("bounds path prefixes and prevents a sibling prefix or broader ownership", () => {
    const { m } = fixture(); expect(() => assertProjectPaths(m, ["src/safe/file.ts", "src/safe/"])).not.toThrow();
    expect(() => assertProjectPaths(m, ["src/safety/file.ts"])).toThrow();
    expect(() => assertProjectPaths(m, ["src/"])).toThrow();
  });
  it("allows only the named publisher and mission branch, including explicit no-publication policies", () => {
    const { m } = fixture(); const actual = { publisherAgentId: "publisher", repository: "owner/repo", baseRef: "main", headRef: "codex/task-mission" };
    expect(() => assertProjectPublication(m, actual)).not.toThrow();
    for (const change of [{ publisherAgentId: "other" }, { repository: "owner/other" }, { baseRef: "release" }, { headRef: "codex/task-other" }]) {
      expect(() => assertProjectPublication(m, { ...actual, ...change })).toThrow();
    }
    m.aggregate.projectMandate!.publication = null; expect(() => assertProjectPublication(m, actual)).toThrow();
  });
  it("binds controller feedback authority separately without changing historical operating-profile hashes", () => {
    const { m, config } = fixture(), secretRef = { type: "secret_ref" as const, secretId: "secret", version: "latest" as const };
    const actual = { publisherAgentId: "publisher", repository: "owner/repo", baseRef: "main", headRef: "codex/task-mission",
      contract: { protocol: "council-pr-contract-v1" as const, draftOnly: true, result: "draft-pr" as const, feedback: "review-and-correct" as const,
        requiredChecks: ["ci"], feedbackRefresh: { protocol: "controller-github-feedback-v1" as const, secretRef } } };
    m.aggregate.projectMandate!.publication = { ...m.aggregate.projectMandate!.publication!, contract: actual.contract };
    expect(() => assertProjectPublication(m, actual)).not.toThrow();
    expect(() => assertProjectPublication(m, { ...actual, contract: { ...actual.contract, feedbackRefresh: undefined } })).toThrow();
    expect(operatingProfileHash(config)).toBe(operatingProfileHash({ ...config, githubFeedbackToken: secretRef }));
  });
  it("leaves historical missions outside project delegation", async () => {
    const { m } = fixture(); delete m.aggregate.projectMandate;
    await expect(assertProjectDeparture({} as PluginContext, m)).resolves.toBeUndefined();
    expect(() => assertProjectPaths(m, ["any"])).not.toThrow();
  });
});
