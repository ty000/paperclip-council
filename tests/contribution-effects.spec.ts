import { randomUUID } from "node:crypto";
import type { Issue } from "@paperclipai/shared";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CONTRIBUTION_ISSUE_ORIGIN_KIND,
  buildContributionIssueOrigin,
  createContributionIssueEffect,
  reconcileContributionIssueEffect,
  type ContributionIssueIntent,
} from "../src/contribution-effects.js";

const ids = {
  intent: randomUUID(),
  company: randomUUID(),
  project: randomUUID(),
  root: randomUUID(),
  mission: randomUUID(),
  contribution: randomUUID(),
  assignee: randomUUID(),
  issue: randomUUID(),
};

function intent(): ContributionIssueIntent {
  return {
    state: "creation_claimed",
    intentId: ids.intent,
    companyId: ids.company,
    projectId: ids.project,
    rootIssueId: ids.root,
    missionId: ids.mission,
    contributionId: ids.contribution,
    assigneeAgentId: ids.assignee,
    title: "Implement the bounded contribution",
    description: "Write only the assigned files and attach evidence.",
    blockedByIssueIds: [randomUUID()],
    actor: { actorAgentId: randomUUID(), actorRunId: randomUUID() },
  };
}

function nativeIssue(value = intent()): Issue {
  const correlation = buildContributionIssueOrigin(value);
  return {
    id: ids.issue,
    companyId: value.companyId,
    projectId: value.projectId,
    projectWorkspaceId: null,
    goalId: null,
    parentId: value.rootIssueId,
    title: value.title,
    description: value.description ?? null,
    status: "backlog",
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: value.assigneeAgentId,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: value.actor?.actorAgentId ?? null,
    createdByUserId: value.actor?.actorUserId ?? null,
    responsibleUserId: null,
    issueNumber: 1,
    identifier: "COU-1",
    originKind: correlation.originKind,
    originId: correlation.originId,
    originRunId: value.actor?.actorRunId ?? null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function context(options: {
  list: () => Promise<Issue[]>;
  create?: (input: unknown) => Promise<Issue>;
}) {
  const list = vi.fn(options.list);
  const create = vi.fn(options.create ?? (async () => nativeIssue()));
  const requestWakeup = vi.fn();
  return {
    ctx: { issues: { list, create, requestWakeup } } as unknown as PluginContext,
    list,
    create,
    requestWakeup,
  };
}

describe("native contribution child-issue effects", () => {
  it("builds stable plugin-owned correlation", () => {
    expect(buildContributionIssueOrigin(intent())).toEqual({
      originKind: CONTRIBUTION_ISSUE_ORIGIN_KIND,
      originId: `mission:${ids.mission}:contribution:${ids.contribution}`,
    });
  });

  it("confirms an existing exact issue without another create", async () => {
    const harness = context({ list: async () => [nativeIssue()] });
    const result = await createContributionIssueEffect(harness.ctx, intent());
    expect(result).toMatchObject({ state: "confirmed", source: "correlation_readback", issue: { id: ids.issue } });
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("creates one inert assigned child after an absent preflight", async () => {
    const harness = context({ list: async () => [] });
    const value = intent();
    const result = await createContributionIssueEffect(harness.ctx, value);
    expect(result).toMatchObject({ state: "confirmed", source: "create_response", issue: { id: ids.issue } });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: ids.company,
      projectId: ids.project,
      parentId: ids.root,
      inheritExecutionWorkspaceFromIssueId: ids.root,
      assigneeAgentId: ids.assignee,
      status: "backlog",
      originKind: CONTRIBUTION_ISSUE_ORIGIN_KIND,
      originId: `mission:${ids.mission}:contribution:${ids.contribution}`,
      blockedByIssueIds: value.blockedByIssueIds,
      actor: value.actor,
    }));
    expect(harness.requestWakeup).not.toHaveBeenCalled();
  });

  it("reconciles a lost create response once without a second create", async () => {
    let reads = 0;
    const harness = context({
      list: async () => (++reads === 1 ? [] : [nativeIssue()]),
      create: async () => { throw new Error("response lost"); },
    });
    const result = await createContributionIssueEffect(harness.ctx, intent());
    expect(result).toMatchObject({ state: "confirmed", source: "correlation_readback", issue: { id: ids.issue } });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(harness.list).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed create with no readback match unknown and non-retryable", async () => {
    const harness = context({
      list: async () => [],
      create: async () => { throw new Error("timeout"); },
    });
    const result = await createContributionIssueEffect(harness.ctx, intent());
    expect(result).toEqual({
      state: "unknown",
      reason: "create_failed_no_match",
      retryAllowed: false,
      nextAction: "manual_reconciliation_required",
      correlation: buildContributionIssueOrigin(intent()),
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("fails closed before create on ambiguous or mismatched correlation", async () => {
    const duplicate = { ...nativeIssue(), id: randomUUID() };
    const ambiguous = context({ list: async () => [nativeIssue(), duplicate] });
    await expect(createContributionIssueEffect(ambiguous.ctx, intent())).resolves.toMatchObject({
      state: "unknown",
      reason: "correlation_ambiguous",
      retryAllowed: false,
    });
    expect(ambiguous.create).not.toHaveBeenCalled();

    const mismatched = context({ list: async () => [{ ...nativeIssue(), assigneeAgentId: randomUUID() }] });
    await expect(createContributionIssueEffect(mismatched.ctx, intent())).resolves.toMatchObject({
      state: "unknown",
      reason: "correlation_mismatch",
      retryAllowed: false,
    });
    expect(mismatched.create).not.toHaveBeenCalled();
  });

  it("fails closed before create when correlation cannot be read", async () => {
    const harness = context({ list: async () => { throw new Error("read unavailable"); } });
    await expect(createContributionIssueEffect(harness.ctx, intent())).resolves.toMatchObject({
      state: "unknown",
      reason: "correlation_read_failed",
      retryAllowed: false,
    });
    expect(harness.create).not.toHaveBeenCalled();
  });

  it("does not accept a mismatched native create response", async () => {
    const harness = context({
      list: async () => [],
      create: async () => ({ ...nativeIssue(), parentId: randomUUID() }),
    });
    await expect(createContributionIssueEffect(harness.ctx, intent())).resolves.toMatchObject({
      state: "unknown",
      reason: "create_response_mismatch",
      retryAllowed: false,
    });
    expect(harness.create).toHaveBeenCalledTimes(1);
  });

  it("offers read-only reconciliation whose absence never implies retry permission", async () => {
    const harness = context({ list: async () => [] });
    await expect(reconcileContributionIssueEffect(harness.ctx, intent())).resolves.toEqual({
      state: "absent",
      correlation: buildContributionIssueOrigin(intent()),
    });
    expect(harness.create).not.toHaveBeenCalled();
  });
});
