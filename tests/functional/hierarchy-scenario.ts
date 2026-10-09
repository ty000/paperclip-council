import assert from "node:assert/strict";
import { hierarchyLaunchGuidance } from "../../src/hierarchy-guidance.js";
import type { MissionRecord } from "../../src/missions.js";

/** Only native task/document/dependency APIs; no hidden mission or contributor IDs. */
export async function prepareHierarchyTasks(api: any, companyId: string, projectId: string, actors: Record<string, string>, count: number) {
  const create = (body: any) => api("POST", `/api/companies/${companyId}/issues`, { projectId, status: "backlog", ...body });
  const root = await create({ title: "Variable hierarchy result", description: "Produce the existing attributed leaves, obtain independent review and the authorized publication" });
  const group = count > 1 ? await create({ title: "Intermediate parent", description: "Aggregate alpha and beta; keep pending until proof closure", parentId: root.id }) : null;
  const leaves = [];
  for (const name of ["alpha", "beta", "gamma"].slice(0, count)) {
    const issue = await create({ title: name, description: `Preserved ${name} product result. Read the Council execution document before work.`,
      parentId: name === "gamma" ? root.id : group?.id ?? root.id, assigneeAgentId: actors[name] });
    await api("PUT", `/api/issues/${issue.id}/documents/council-work`, { title: "Explicit leaf scope", format: "markdown", body: JSON.stringify({ ownedPaths: [`${name}.txt`] }) });
    leaves.push(issue);
  }
  if (count > 1) {
    await api("PATCH", `/api/issues/${leaves[1]!.id}`, { blockedByIssueIds: [leaves[0]!.id] });
    await api("PATCH", `/api/issues/${group!.id}`, { blockedByIssueIds: leaves.slice(0, 2).map(issue => issue.id), status: "blocked" });
  }
  // Assignment occurs while Backlog. The existing native scheduler later admits only the coordinator.
  await api("PATCH", `/api/issues/${root.id}`, { assigneeAgentId: actors.lead });
  await api("PATCH", `/api/issues/${root.id}`, { blockedByIssueIds: group ? [group.id, leaves[2]!.id] : [leaves[0]!.id] });
  const source = await Promise.all([root, ...(group ? [group] : []), ...leaves].map(issue => api("GET", `/api/issues/${issue.id}`)));
  assert.equal(source.find(issue => issue.id === root.id).status, "backlog");
  return { root, source, leaves, group, count };
}

export async function verifyHierarchyTasks(api: any, proof: any, rootId: string) {
  const pinned = proof.mission.aggregate.hierarchy, state = proof.mission.aggregate.n1;
  assert.equal(pinned.leaves.length, proof.hierarchyTasks.count);
  assert(state.coordination.issueId && state.coordination.issueId !== rootId);
  const after = await Promise.all(proof.hierarchyTasks.source.map((issue: any) => api("GET", `/api/issues/${issue.id}`)));
  for (const original of proof.hierarchyTasks.source) {
    const current = after.find((issue: any) => issue.id === original.id);
    for (const key of ["title", "parentId", "assigneeAgentId"]) assert.deepEqual(current[key], original[key]);
    const guidance = hierarchyLaunchGuidance(proof.mission as MissionRecord, original.id);
    assert.equal(current.description, original.description + (guidance ? `\n\n${guidance}` : ""));
    assert.deepEqual(current.blockedByIssueIds, original.blockedByIssueIds);
  }
  assert.equal(after.find((issue: any) => issue.id === rootId).status, proof.mission.aggregate.completion?.state === "closed" ? "done" : "blocked");
  if (proof.hierarchyTasks.group) assert.equal(after.find((issue: any) => issue.id === proof.hierarchyTasks.group.id).status, proof.mission.aggregate.completion?.state === "closed" ? "done" : "blocked");
  assert(proof.hierarchyTasks.leaves.every((leaf: any) => after.find((issue: any) => issue.id === leaf.id).status === "done"));
  assert.deepEqual(new Set(state.contributions.map((slot: any) => slot.childIssueId)), new Set(proof.hierarchyTasks.leaves.map((leaf: any) => leaf.id)));
  assert.equal(proof.runs.filter((run: any) => run.contextSnapshot.issueId === rootId).length, 0);
  proof.hierarchyTasks.final = after;
  proof.hierarchyTasks.checks = { existingLeafIds: "PASS", descriptionsAndRelationsPreserved: "PASS", allLeavesDone: "PASS", productParentsNotPrematurelyClosed: "PASS", originalLeadReservation: "PASS" };
}
