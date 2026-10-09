import { expect, it } from "vitest";
import type { MissionRecord } from "../src/missions.js";
import { parseProjectWorkflow, projectRoleContext } from "../src/project-workflow.js";

const workflow = { protocol: "council-project-workflow-v1", commands: [
  { key: "prepare", kind: "prepare", command: "pnpm install --frozen-lockfile", roles: ["lead", "contributor"] },
  { key: "test", kind: "verify", command: "pnpm test", roles: ["contributor", "correction"] },
  { key: "static-audit", kind: "audit", command: "pnpm exec fallow audit --base origin/main", roles: ["contributor", "council"],
    tool: { name: "fallow", versionCommand: "pnpm exec fallow --version", expectedVersion: "3.23.0" } },
] } as const;

function mission(): MissionRecord {
  return { missionId: "mission", aggregate: { mandate: { objective: "Deliver the bounded project change\n\nLong background",
    acceptanceCriteria: ["Behavior is covered", "Audit is attributable"] }, projectMandate: { allowedPaths: ["src", "tests"], workflow } } } as unknown as MissionRecord;
}

it("pins exact role commands and emits a compact targeted context", () => {
  const parsed = parseProjectWorkflow(workflow)!;
  expect(parsed.commands[2]).toMatchObject({ command: "pnpm exec fallow audit --base origin/main",
    tool: { versionCommand: "pnpm exec fallow --version", expectedVersion: "3.23.0" } });
  const context = projectRoleContext(mission(), "contributor", { paths: ["src/feature.ts"], predecessor: "issue-1" })!;
  expect(context).toContain("Objective: Deliver the bounded project change");
  expect(context).toContain("Paths: src/feature.ts"); expect(context).toContain("Predecessor: issue-1");
  expect(context).toContain("pnpm test"); expect(context).toContain("pnpm exec fallow --version");
  expect(context).not.toContain("OpenAPI");
});

it("rejects ambiguous or unversioned audit instructions", () => {
  expect(() => parseProjectWorkflow({ ...workflow, commands: [{ key: "audit", kind: "audit", command: "pnpm exec fallow audit", roles: ["lead"] }] }))
    .toThrow(/exact tool version/);
  expect(() => parseProjectWorkflow({ ...workflow, commands: [workflow.commands[0], workflow.commands[0]] }))
    .toThrow(/unique lowercase slugs/);
  expect(() => parseProjectWorkflow({ ...workflow, commands: [{ ...workflow.commands[0], command: "pnpm test\nrm bad" }] }))
    .toThrow(/one bounded line/);
});
