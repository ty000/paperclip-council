import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput, PluginContext } from "@paperclipai/plugin-sdk";
import { publicResponse, publicResponseBody } from "../src/public-response.js";
vi.mock("../src/missions.js", async original => ({ ...await original(), handleMissionApi: vi.fn() }));
import { handleMissionApi, MissionError } from "../src/missions.js";
import { ModelSelectionError } from "../src/model-state.js";
import { handlePluginRequest } from "../src/worker.js";
afterEach(() => vi.mocked(handleMissionApi).mockReset());

const archive = { parts: [{ content: "attributed recovery content" }], limits: { maxArchiveBytes: 16 * 1024 * 1024 } };

describe("public model responses", () => {
  it.each([
    ["mission list", { missions: [{ mission: { aggregate: { modelSelection: { tasks: [{ launches: [{ historyArchive: archive }] }] } } } }] }],
    ["mission detail", { mission: { aggregate: { modelSelection: { tasks: [{ launches: [{ historyArchive: archive, history: { indexKey: "index" } }] }] } } } }],
    ["profile choice", { mission: { aggregate: { modelSelection: { tasks: [{ launches: [{ historyArchive: archive }] }] } } }, choice: { profileId: "sol-high" } }],
    ["measurement reconciliation", { mission: { aggregate: { modelSelection: { tasks: [{ launches: [{ historyArchive: archive, measurement: { inputTokens: 1 } }] }] } } } }],
    ["error details", { code: "model_error", details: { nested: [{ historyArchive: archive, gap: "publication_failed" }] } }],
  ])("removes recovery archives from a %s body without changing the source", (_name, body) => {
    const before = structuredClone(body);
    const result = publicResponse({ status: 200, body });
    expect(JSON.stringify(result)).not.toContain("historyArchive");
    expect(result.body).not.toBe(body);
    expect(body).toEqual(before);
    expect(JSON.stringify(body)).toContain("attributed recovery content");
  });

  it("recursively preserves public arrays, nulls and scalar values", () => {
    expect(publicResponseBody({ values: [null, 0, false, "", { kept: true, historyArchive: archive }] }))
      .toEqual({ values: [null, 0, false, "", { kept: true }] });
  });

  it("rejects a mismatched company path before any route or tool effect", async () => {
    const getCompany = vi.fn();
    const query = vi.fn();
    const execute = vi.fn();
    const request = {
      routeKey: "model-selection-read", method: "GET", path: "/companies/path-company/missions/mission/model-profiles",
      query: { companyId: "authorized-company" }, headers: {}, body: undefined,
      companyId: "authorized-company", params: { companyId: "path-company", missionId: "mission" },
      actor: { actorType: "user", actorId: "owner", userId: "owner" },
    } as PluginApiRequestInput;
    const context = { companies: { get: getCompany }, db: { query, execute } } as unknown as PluginContext;

    await expect(handlePluginRequest(request, context)).resolves.toEqual({
      status: 403,
      body: {
        code: "company_scope_mismatch",
        error: "Path company does not match the host-authorized company scope",
        details: undefined,
      },
    });
    expect(getCompany).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

const sameCompanyRequest = { routeKey: "mission-read", method: "GET", path: "/companies/company/missions/mission",
  query: { companyId: "company" }, headers: {}, body: undefined, companyId: "company", params: { companyId: "company", missionId: "mission" },
  actor: { actorType: "user", actorId: "owner", userId: "owner" } } as PluginApiRequestInput;
it.each(["mission-read", "missions-list"])("filters archives at the actual %s worker boundary", async routeKey => {
  const stored = { aggregate: { modelSelection: { tasks: [{ launches: [{ historyArchive: archive, history: { indexKey: "kept" } }] }] } } };
  const before = structuredClone(stored);
  const body = routeKey === "missions-list" ? { missions: [{ mission: stored }] } : { mission: stored };
  vi.mocked(handleMissionApi).mockResolvedValue({ status: 200, body } as never);
  const response = await handlePluginRequest({ ...sameCompanyRequest, routeKey }, {} as PluginContext);
  expect(handleMissionApi).toHaveBeenCalledOnce();
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).not.toContain("historyArchive");
  expect(JSON.stringify(response.body)).not.toContain("attributed recovery content");
  expect(JSON.stringify(response.body)).toContain("kept");
  expect(stored).toEqual(before);
});
it.each(["mission", "model"])("filters recovery content in an actual %s error response", async kind => {
  const details = { nested: [{ historyArchive: archive, reason: "kept" }] };
  const error = kind === "mission" ? new MissionError(409, "failed", "failed", details)
    : new ModelSelectionError("failed", "failed", details);
  vi.mocked(handleMissionApi).mockRejectedValue(error);
  const result = await handlePluginRequest(sameCompanyRequest, {} as PluginContext);
  expect(result.status).toBe(409);
  expect(JSON.stringify(result.body)).not.toContain("historyArchive");
  expect(JSON.stringify(result.body)).toContain("kept");
  expect(details.nested[0]!.historyArchive).toBe(archive);
});
