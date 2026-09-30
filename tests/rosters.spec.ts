import { describe, expect, it } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  executeRosterCommand,
  parseRosterDraft,
  RosterError,
} from "../src/rosters.js";

describe("Council roster contracts", () => {
  it("rejects duplicate agents and missing accountable responsibilities", () => {
    expect(() => parseRosterDraft({
      kind: "team",
      name: "Duplicate team",
      members: [
        { agentId: "agent-1", responsibilities: ["integration_lead"] },
        { agentId: "agent-1", responsibilities: ["contributor"] },
      ],
      integrationLeadAgentId: "agent-1",
      finalReviewerAgentId: null,
      requiredPerspectives: [],
    })).toThrowError(RosterError);
  });

  it("derives mutation authority from company configuration, never request ownerUserId", async () => {
    const ctx = {
      companies: {
        get: async () => ({ id: "company-1", defaultResponsibleUserId: "owner-1" }),
      },
    } as unknown as PluginContext;

    await expect(executeRosterCommand(ctx, {
      companyId: "company-1",
      actorUserId: "intruder-1",
      body: {
        command: "create",
        ownerUserId: "owner-1",
        roster: {
          kind: "team",
          name: "Unauthorized",
          members: [{ agentId: "agent-1", responsibilities: ["integration_lead"] }],
          integrationLeadAgentId: "agent-1",
          finalReviewerAgentId: null,
          requiredPerspectives: [],
        },
      },
    })).rejects.toMatchObject({ status: 403, code: "owner_required" });
  });
});
