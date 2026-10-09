import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { handleProjectMandate } from "../src/project-mandate-configuration.js";
import { operatingProfileHash } from "../src/project-mandate-state.js";

function fixture() {
  const companyId = randomUUID(), projectId = randomUUID(), rootIssueId = randomUUID(), revisionId = randomUUID(), config = {};
  const policy = { company_id: companyId, project_id: projectId, revision_id: revisionId, authorized_by: "owner", version: 1,
    content: { enabled: true, operatingProfileHash: operatingProfileHash(config) } };
  let row: any = { company_id: companyId, project_id: projectId, root_issue_id: rootIssueId, policy_revision_id: revisionId,
    mission_id: randomUUID(), version: 4, state: { createBody: { commandId: randomUUID() }, questions: { repository_occupied: { confirmed: true } }, commands: {} } };
  const execute = vi.fn(async (_sql: string, params: any[]) => {
    if (row.version !== params[4]) return { rowCount: 0 };
    row = { ...row, state: JSON.parse(params[0]), version: row.version + 1 }; return { rowCount: 1 };
  });
  const ctx = { db: { namespace: "test", execute, query: async (sql: string, params: string[]) => {
    if (sql.includes("project_mandates")) return params[0] === companyId && params[1] === projectId ? [policy] : [];
    return params[0] === row.company_id && params[1] === row.project_id && params[2] === row.root_issue_id ? [structuredClone(row)] : [];
  } }, projects: { get: async () => ({ companyId, archivedAt: null }) },
  companies: { get: async () => ({ defaultResponsibleUserId: "owner" }) }, config: { get: async () => config } } as any;
  const input = { companyId, method: "POST", params: { projectId }, actor: { actorType: "user", userId: "owner" },
    body: { command: "resume-repository-intake", commandId: randomUUID(), rootIssueId, policyRevisionId: revisionId,
      expectedIntakeVersion: 4, authorizeResume: true } } as any;
  return { ctx, input, policy, execute, row: () => row };
}

it("uses the authenticated existing Board API, preserving legacy questions and exact effect identities", async () => {
  const f = fixture(), before = structuredClone(f.row());
  expect((await handleProjectMandate(f.ctx, f.input)).body.outcome).toBe("applied");
  expect(f.row()).toMatchObject({ mission_id: before.mission_id, policy_revision_id: before.policy_revision_id,
    state: { createBody: before.state.createBody, questions: before.state.questions, commands: before.state.commands,
      repositoryHold: { status: "released" }, repositoryResumptions: [{ commandId: f.input.body.commandId, ownerUserId: "owner", heldIntakeVersion: 4 }] } });
  expect((await handleProjectMandate(f.ctx, f.input)).body.outcome).toBe("replayed");
  expect(f.execute).toHaveBeenCalledTimes(1);
  f.input.body.authorizeResume = false;
  await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_resume_identity" });
});

it.each(["agent", "other owner", "other root", "other project", "policy drift", "disabled", "profile drift", "no authorization", "stale version", "not held"])("refuses %s without a recovery write", async reason => {
  const f = fixture();
  if (reason === "agent") f.input.actor = { actorType: "agent", agentId: "owner" };
  if (reason === "other owner") f.input.actor.userId = "other";
  if (reason === "other root") f.input.body.rootIssueId = randomUUID();
  if (reason === "other project") f.input.params.projectId = randomUUID();
  if (reason === "policy drift") f.policy.revision_id = randomUUID();
  if (reason === "disabled") f.policy.content.enabled = false;
  if (reason === "profile drift") f.policy.content.operatingProfileHash = "changed";
  if (reason === "no authorization") f.input.body.authorizeResume = false;
  if (reason === "stale version") f.input.body.expectedIntakeVersion = 3;
  if (reason === "not held") f.row().state.questions = {};
  await expect(handleProjectMandate(f.ctx, f.input)).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
});

it("retains the original hold after failed CAS, without a replacement command or retry", async () => {
  const f = fixture(); f.execute.mockResolvedValueOnce({ rowCount: 0 });
  await expect(handleProjectMandate(f.ctx, f.input)).rejects.toMatchObject({ code: "project_resume_version" });
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.row().version).toBe(4); expect(f.row().state.repositoryResumptions).toBeUndefined();
});
