import type { MissionRecord } from "./missions.js";
import { MissionError } from "./mission-primitives.js";

const PROJECT_WORKFLOW_ROLES = ["lead", "contributor", "integration", "specialist", "council", "correction", "publisher"] as const;
export type ProjectWorkflowRole = typeof PROJECT_WORKFLOW_ROLES[number];
export type ProjectWorkflowCommand = {
  key: string;
  kind: "prepare" | "verify" | "audit";
  command: string;
  roles: ProjectWorkflowRole[];
  tool?: { name: string; versionCommand: string; expectedVersion: string };
};
export type ProjectWorkflow = { protocol: "council-project-workflow-v1"; commands: ProjectWorkflowCommand[] };

function boundedText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\r\n]/.test(value)) {
    throw new MissionError(422, "project_workflow_input", `${label} must be one bounded line`);
  }
  return value.trim();
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new MissionError(422, "project_workflow_input", `${label} contains an unsupported field`);
  }
}

function commandRoles(value: unknown): ProjectWorkflowRole[] {
  if (!Array.isArray(value) || !value.length || value.length > PROJECT_WORKFLOW_ROLES.length
      || value.some(role => !PROJECT_WORKFLOW_ROLES.includes(role as ProjectWorkflowRole))) {
    throw new MissionError(422, "project_workflow_input", "Every command needs one or more supported roles");
  }
  return [...new Set(value)] as ProjectWorkflowRole[];
}

function commandTool(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(422, "project_workflow_input", "Tool pin must be an object");
  }
  const tool = value as Record<string, unknown>;
  exactKeys(tool, ["name", "versionCommand", "expectedVersion"], label);
  return { name: boundedText(tool.name, "tool.name", 80),
    versionCommand: boundedText(tool.versionCommand, "tool.versionCommand", 1000),
    expectedVersion: boundedText(tool.expectedVersion, "tool.expectedVersion", 80) };
}

function workflowCommand(raw: unknown, index: number, seen: Set<string>): ProjectWorkflowCommand {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MissionError(422, "project_workflow_input", `commands[${index}] must be an object`);
  }
  const item = raw as Record<string, unknown>;
  exactKeys(item, ["key", "kind", "command", "roles", "tool"], `commands[${index}]`);
  const key = boundedText(item.key, `commands[${index}].key`, 80);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key) || seen.has(key)) {
    throw new MissionError(422, "project_workflow_input", "Command keys must be unique lowercase slugs");
  }
  seen.add(key);
  if (!["prepare", "verify", "audit"].includes(String(item.kind))) {
    throw new MissionError(422, "project_workflow_input", "Command kind must be prepare, verify or audit");
  }
  const command: ProjectWorkflowCommand = { key, kind: item.kind as ProjectWorkflowCommand["kind"],
    command: boundedText(item.command, `commands[${index}].command`, 1000), roles: commandRoles(item.roles) };
  if (item.tool !== undefined) command.tool = commandTool(item.tool, `commands[${index}].tool`);
  if (command.kind === "audit" && !command.tool) {
    throw new MissionError(422, "project_workflow_input", "Audit commands require an exact tool version check");
  }
  return command;
}

export function parseProjectWorkflow(value: unknown): ProjectWorkflow | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MissionError(422, "project_workflow_input", "Workflow must be an explicit bounded object");
  }
  const workflow = value as Record<string, unknown>;
  exactKeys(workflow, ["protocol", "commands"], "workflow");
  if (workflow.protocol !== "council-project-workflow-v1" || !Array.isArray(workflow.commands)
      || !workflow.commands.length || workflow.commands.length > 16) {
    throw new MissionError(422, "project_workflow_input", "Workflow requires protocol v1 and 1-16 commands");
  }
  const seen = new Set<string>();
  const commands = workflow.commands.map((raw, index) => workflowCommand(raw, index, seen));
  return { protocol: "council-project-workflow-v1", commands };
}

function compact(value: string, maximum = 800) {
  const first = value.trim().split(/\n\s*\n/)[0] ?? value.trim();
  return first.length <= maximum ? first : `${first.slice(0, maximum - 1)}…`;
}

const finishByRole: Record<ProjectWorkflowRole, string> = {
  lead: "Finish after the bounded plan or integration handoff is recorded, or with one exact blocker; do not self-review.",
  contributor: "Finish after the exact commit, checks and Council contribution handoff are recorded; do not close the mission.",
  integration: "Finish after the exact integrated candidate and composed checks are handed off; do not issue the verdict.",
  specialist: "Finish after one attributed opinion on the current candidate; do not edit or approve it.",
  council: "Finish after one candidate-bound verdict and its supported readback, or one explicit evidence wait.",
  correction: "Finish after the bounded corrected candidate and affected checks are resubmitted; do not broaden scope.",
  publisher: "Finish after the authorized publication/readback result or one retained unknown effect; do not merge unless separately authorized.",
};

export function projectRoleContext(mission: MissionRecord, role: ProjectWorkflowRole, details: {
  paths?: readonly string[]; predecessor?: string | null; finish?: string;
} = {}): string | null {
  const workflow = mission.aggregate.projectMandate?.workflow;
  if (!workflow) return null;
  const commands = workflow?.commands.filter(item => item.roles.includes(role)) ?? [];
  const paths = details.paths ?? mission.aggregate.projectMandate?.allowedPaths ?? [];
  const predecessor = details.predecessor ?? (mission.aggregate.deliveryPredecessor
    ? `${mission.aggregate.deliveryPredecessor.sourceMissionId} integrated at ${mission.aggregate.deliveryPredecessor.result.integratedCommit}`
    : "none declared");
  return [
    "## Targeted assignment context",
    `Role: ${role}`,
    `Objective: ${compact(mission.aggregate.mandate.objective)}`,
    `Paths: ${paths.length ? paths.join(", ") : "read-only candidate/evidence scope from the assigned issue"}`,
    `Predecessor: ${predecessor}`,
    "Acceptance criteria:",
    ...mission.aggregate.mandate.acceptanceCriteria.map(item => `- ${item}`),
    "Commands available for this role:",
    ...(commands.length ? commands.flatMap(item => [
      `- ${item.key} (${item.kind}): ${item.command}`,
      ...(item.tool ? [`  Tool check: ${item.tool.versionCommand}; expected ${item.tool.name} ${item.tool.expectedVersion}`] : []),
    ]) : ["- none assigned to this role; use the task-specific Council handoff only"]),
    `Finish condition: ${details.finish ?? finishByRole[role]}`,
    "Configured commands are instructions, not proof of availability. Attribute their execution and report exact refusal or version drift.",
  ].join("\n");
}
