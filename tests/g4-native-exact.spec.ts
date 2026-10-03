import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/decision-adapter.js", () => ({ councilNativeRequest: vi.fn() }));
vi.mock("../src/admission.js", async original => ({ ...await original(), settleAdmission: vi.fn() }));
import { councilNativeRequest } from "../src/decision-adapter.js";
import { settleAdmission } from "../src/admission.js";
import { settleNativeExactRunUsage } from "../src/g4-native.js";
const binding = { companyId: "company", issueId: "issue", agentId: "agent", runId: "run", commandId: "command", reservationId: "reservation", periodKey: "period", expectedVersion: 1 };
const run = () => ({ id: "run", companyId: "company", agentId: "agent", nativeIssueId: "issue", contextSnapshot: { issueId: "issue" },
  status: "succeeded", startedAt: "2026-10-03T10:00:00Z", finishedAt: "2026-10-03T10:01:00Z", usageJson: { usageSource: "per_run", inputTokens: 101, cachedInputTokens: 40, outputTokens: 23 } });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: run() }); });
it("settles one public run without relying on aggregate tokens or counting cached tokens twice", async () => {
  await settleNativeExactRunUsage({} as never, binding);
  expect(settleAdmission).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ usage: expect.objectContaining({ units: 124 }), remainingExposure: expect.objectContaining({ units: 0 }) }));
});
it.each([
  ["another run", { id: "other" }, "g4_run_identity_unqualified"],
  ["another agent", { agentId: "other" }, "g4_run_identity_unqualified"],
  ["another issue", { nativeIssueId: "other" }, "g4_run_identity_unqualified"],
  ["running", { status: "running", finishedAt: null }, "g4_run_not_terminal"],
  ["not started", { startedAt: null }, "g4_run_not_terminal"],
  ["missing usage", { usageJson: null }, "g4_usage_unavailable"],
  ["unqualified measurement", { usageJson: { inputTokens: 1, outputTokens: 2 } }, "g4_usage_unavailable"],
  ["zero usage", { usageJson: { inputTokens: 0, outputTokens: 0 } }, "g4_usage_unavailable"],
  ["invalid cached usage", { usageJson: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3 } }, "g4_usage_unavailable"],
])("keeps the reservation held for %s", async (_label, patch, code) => {
  vi.mocked(councilNativeRequest).mockResolvedValue({ status: 200, body: { ...run(), ...patch } });
  await expect(settleNativeExactRunUsage({} as never, binding)).rejects.toMatchObject({ code });
  expect(settleAdmission).not.toHaveBeenCalled();
});
