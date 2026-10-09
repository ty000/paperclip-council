import type { MissionRecord } from "./missions.js";
import { ordinaryTaskInstructions } from "./n2-ordinary-instructions.js";
import type { OrdinaryTask } from "./n2-ordinary-state.js";
import { projectRoleContext, type ProjectWorkflowRole } from "./project-workflow.js";

/** Add project-specific context without changing the stable ordinary command contract. */
export function projectOrdinaryTaskInstructions(mission: MissionRecord, task: OrdinaryTask) {
  const role: ProjectWorkflowRole = task.kind === "council" ? "council" : task.kind;
  const context = projectRoleContext(mission, role);
  const instructions = ordinaryTaskInstructions(mission, task);
  return context ? `${context}\n\n${instructions}` : instructions;
}
