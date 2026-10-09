import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { MissionError, canonicalPayloadHash } from "./mission-primitives.js";
import type { MissionRecord } from "./missions.js";

export type N1Coordination = { intentId: string; issueId: string | null; state: "preparing" | "claimed" | "confirmed";
  commandId: string; commandHash: string; ownerUserId: string; preparedVersion: number; instructionsVersion?: "lead-commands-v1" };
type Persist = (m: MissionRecord, coordination: N1Coordination) => Promise<MissionRecord>;

function instructions(m: MissionRecord) {
  if ((m.aggregate.n1?.coordination as N1Coordination | undefined)?.instructionsVersion === "lead-commands-v1") return `Coordinate Council mission ${m.missionId}, original root ${m.rootIssueId}, on this admitted native task. Read Council inspect with missionId=${m.missionId}; inspect.n1.leadCommands contains the executable plan/materialize shell block and its usage. Use it to generate technical identities and a fresh version. The pinned hierarchy is the plan; do not invent IDs or replacement leaves. Before planning, read this task's mandate and hierarchy below. The council-execution documents exist only after materialization and are for contributors.
Preserve a journaled request after any refusal, lost response or mismatched business readback. Stop for exact readback; do not retry with a new identity. Dispatch and publish remain subject to existing Council admission, predecessor settlement and exact candidate proof. No direct wake, dependency removal or extra budget. The parent remains pending delivery evidence.
Plugins/skills à utiliser : accès Paperclip authentifié et Council inspect, puis son bloc leadCommands pour plan/materialize ; ensuite les contrôles Git/Paperclip déjà accessibles pour dispatch, settlement et publish. Aucune installation de skill ni modification de droits.
Modèle et effort recommandés : conserver le modèle et l'effort du profil Council déjà épinglé pour ce lead ; réévaluer uniquement sur ambiguïté substantielle via une nouvelle autorisation. Mapping indépendant absent du checkout et du chemin partagé vérifiés le 2026-10-09 ; aucun modèle de substitution n'est configuré. Disponibilité sur la cible non vérifiée par ce texte.
Mandate: ${JSON.stringify(m.aggregate.mandate)}
Hierarchy: ${JSON.stringify(m.aggregate.hierarchy)}
${m.aggregate.deliveryPredecessor ? `Before plan, fetch the authorized repository and check out the exact previous integrated commit ${m.aggregate.deliveryPredecessor.result.integratedCommit}; verify a clean worktree and pin this SHA as sourceBaseCommit. Never consume its pre-merge candidate or floating main. Predecessor: ${JSON.stringify(m.aggregate.deliveryPredecessor)}` : ""}`;
  return `Coordinate the existing hierarchy for Council mission ${m.missionId}, original root ${m.rootIssueId}. This operational task avoids the root's unresolved child dependencies; it grants no additional budget or rights.
If inspect.n1.proofPolicy is council-proof-close-v1, pin sourceBaseCommit from the full Git base SHA in the plan command before any contribution. Keep that base for publish; each child must supply the verified child bundle using its generated reporting command and Council closes it only after exact terminal settlement.
Read Council inspect on this exact task with missionId=${m.missionId}. Use the pinned hierarchy leaves as the contribution plan: preserve contribution IDs, existing child IDs, descriptions, assignees, ownership and native blockers. Call materialize for each mapped leaf: it creates only an immutable council-execution document with the authenticated reporting command; contributors must read that document before starting. The controller admits each child only after its predecessors finish and their exact usage settles. No replacement child, direct wakeup or blocker removal. Publish only the common verified candidate after all leaf evidence and settlement. The original parent remains pending delivery evidence.
Plugins/skills à utiliser : outil natif Council mission-command pour inspect, plan, dispatch, reconcile-usage et publish, dans cet ordre ; utiliser les skills Git/Paperclip déjà accessibles au lead, sans installation ou changement d'instructions. Leur disponibilité doit être observée sur la cible.
Modèle et effort recommandés : cible lead de coordination suivant un plan borné ; gpt-5.6-sol, medium comme recommandation de cadrage (mapping indépendant /home/davy-lp/.codex/shared/model-selection/model-effort-mapping.md, révision 2026-09-05, consultée 2026-10-07). Motif : coordination de dépendances explicites. Réévaluer sur ambiguïté ou conflit substantiel. Le profil réellement choisi reste celui de l'admission Council existante ; ce texte ne change aucune configuration et ne vérifie pas la disponibilité du modèle sur cette cible. Aucun changement silencieux ou nouvel essai n'est autorisé.
Mandate: ${JSON.stringify(m.aggregate.mandate)}
Hierarchy: ${JSON.stringify(m.aggregate.hierarchy)}
${m.aggregate.deliveryPredecessor ? `Before plan, fetch the authorized repository and check out the exact previous integrated commit ${m.aggregate.deliveryPredecessor.result.integratedCommit}; verify a clean worktree and pin this SHA as sourceBaseCommit. Never consume its pre-merge candidate or floating main. Predecessor: ${JSON.stringify(m.aggregate.deliveryPredecessor)}` : ""}`;
}

export async function prepareHierarchyCoordinator(ctx: PluginContext, initial: MissionRecord, body: Record<string, unknown>, persist: Persist) {
  if (!initial.aggregate.hierarchy?.leaves?.length) return initial;
  let m = initial; let intent = m.aggregate.n1?.coordination as N1Coordination | undefined;
  if (!intent) {
    intent = { intentId: randomUUID(), issueId: null, state: "preparing", commandId: String(body.commandId),
      commandHash: canonicalPayloadHash(body), ownerUserId: m.ownerUserId, preparedVersion: m.version + 1, instructionsVersion: "lead-commands-v1" };
    m = await persist(m, intent);
  }
  if (intent.commandHash !== canonicalPayloadHash(body) || intent.ownerUserId !== m.ownerUserId) throw new MissionError(409, "hierarchy_coordinator_command", "Reuse the original coordinator command and owner; no replacement identity");
  if (intent.state === "confirmed") return m;
  const originKind = "plugin:private.paperclip-council:n1-coordination";
  if (intent.state === "preparing") {
    intent = { ...intent, state: "claimed", preparedVersion: m.version + 1 }; m = await persist(m, intent);
    // Claim persisted before exactly one create. A crash after this boundary only correlates readback.
    try {
      await ctx.issues.create({ companyId: m.companyId, projectId: m.projectId, title: `Council hierarchy ${m.missionId}`,
        description: instructions(m), status: "backlog", assigneeAgentId: m.aggregate.responsibilities.integrationLeadAgentId,
        inheritExecutionWorkspaceFromIssueId: m.rootIssueId, originKind, originId: intent.intentId });
    } catch { /* Correlate an uncertain response without a second create. */ }
  }
  const matches = await ctx.issues.list({ companyId: m.companyId, projectId: m.projectId, originKind, originId: intent.intentId, includePluginOperations: true, limit: 2 });
  const issue = matches.length === 1 ? await ctx.issues.get(matches[0]!.id, m.companyId) : null;
  if (matches.length !== 1 || !issue || issue.parentId || issue.companyId !== m.companyId || issue.projectId !== m.projectId
      || issue.assigneeAgentId !== m.aggregate.responsibilities.integrationLeadAgentId || issue.status !== "backlog"
      || issue.originId !== intent.intentId || issue.originKind !== originKind || issue.description !== instructions(m)) {
    throw new MissionError(409, "hierarchy_coordinator_unknown", "Original coordinator creation is not exactly observed; retain its intent without another create");
  }
  return persist(m, { ...intent, issueId: issue.id, state: "confirmed", preparedVersion: m.version + 1 });
}
