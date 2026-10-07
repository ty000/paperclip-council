import { MissionError } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";

export type HierarchyPolicy = { protocol: "council-hierarchy-v1"; maxContributions: number; execution: "sequential"; adoptExistingChildren: boolean };
export type HierarchyLeaf = { contributionId: string; issueId: string; parentId: string; assigneeAgentId: string;
  title: string; descriptionHash: string; documentRevisionId: string; ownedPaths: string[]; blockedByIssueIds: string[]; pendingBlockerIds: string[] };
export type HierarchyNode = { issueId: string; parentId: string | null; title: string; descriptionHash: string; assigneeAgentId: string | null; blockedByIssueIds: string[] };
export type HierarchyState = HierarchyPolicy & { leaves?: HierarchyLeaf[]; ancestorIds?: string[]; nodes?: HierarchyNode[] };

export function parseHierarchyPolicy(value: unknown): HierarchyPolicy | undefined {
  if (value === undefined) return undefined;
  const v = value as Partial<HierarchyPolicy> | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || v.protocol !== "council-hierarchy-v1" || v.execution !== "sequential"
      || !Number.isSafeInteger(v.maxContributions) || v.maxContributions! < 1 || v.maxContributions! > 12 || typeof v.adoptExistingChildren !== "boolean") {
    throw new MissionError(422, "hierarchy_policy_required", "Explicit sequential hierarchy policy with 1–12 contributions and an adoption choice required");
  }
  return { protocol: v.protocol, maxContributions: v.maxContributions!, execution: v.execution, adoptExistingChildren: v.adoptExistingChildren };
}

export function contributionCountAllowed(m: MissionRecord, count: number) {
  const policy = m.aggregate.hierarchy;
  return policy ? count >= 1 && count <= policy.maxContributions : count === 2;
}

export function leadIssueId(m: MissionRecord): string {
  const coordination = m.aggregate.n1?.coordination as { issueId?: string | null } | undefined;
  return coordination?.issueId ?? m.rootIssueId;
}
