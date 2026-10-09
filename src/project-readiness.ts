import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isAbsolute } from "node:path";
import { readAdmission } from "./admission.js";
import { readNativeG4Profile } from "./g4-native.js";
import { operatingProfileHash, type ProjectMandate } from "./project-mandate-state.js";
import { validateRosterPair } from "./rosters.js";

type Check = { key: string; state: "configured" | "blocked" | "run-check-required"; detail: string };

/** Read-only setup diagnosis. Configuration never substitutes for admission or actual run evidence. */
export async function inspectProjectReadiness(ctx: PluginContext, companyId: string, projectId: string, policy: ProjectMandate | null) {
  const checks: Check[] = [];
  const record = (key: string, ok: boolean, detail: string) => checks.push({ key, state: ok ? "configured" : "blocked", detail });
  const config = await ctx.config.get(companyId);
  record("runtime", config.n2RuntimeProfile === "ordinary-cli-v1" && config.nativeWakeGuardEnabled !== false,
    "Use the existing ordinary CLI review and native wake guard, not a competing review dispatcher.");
  const workspace = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
  record("workspace", Boolean(workspace?.projectId === projectId && workspace.isPrimary && workspace.path && isAbsolute(workspace.path)),
    "An explicit native primary workspace is required by the current shared-checkout Council path.");
  record("mandate", Boolean(policy?.content.enabled), "Only an explicitly enabled current project mandate delegates new tasks.");
  const profile = await readNativeG4Profile(ctx, companyId);
  const accounting = profile ? await readAdmission(ctx, { companyId, periodKey: profile.periodKey }) : null;
  record("accounting", Boolean(accounting && !accounting.blockers.length && accounting.availablePeriodUnits !== null),
    "Existing mission token accounting must be conclusive; no period or budget is created by inspection.");
  if (policy) await inspectPolicy(ctx, companyId, policy, config, record);
  checks.push({ key: "effective-agent-environment", state: "run-check-required",
    detail: "Tool permissions, injected skills, dependency preparation and Git writes must be observed in the admitted run; SDK configuration reads cannot prove them." });
  if (policy?.content.publication) checks.push({ key: "github-publication", state: "run-check-required",
    detail: "Server repository access differs from agent push/PR access. Require the existing attributed publisher preflight before any publication claim." });
  return { protocol: "council-project-readiness-v1", companyId, projectId, policyRevisionId: policy?.revisionId ?? null,
    observedAt: new Date().toISOString(), configurationReady: checks.every(check => check.state !== "blocked"),
    launchAuthorized: false, checks };
}

type RecordCheck = (key: string, ok: boolean, detail: string) => unknown;
type Actor = Awaited<ReturnType<PluginContext["agents"]["get"]>>;
function configuredActor(agent: Actor, companyId: string) {
  const heartbeat = agent?.runtimeConfig?.heartbeat as { enabled?: boolean; wakeOnDemand?: boolean } | undefined;
  return Boolean(agent?.companyId === companyId && agent.adapterType === "codex_local"
    && agent.adapterConfig?.engine === "cli" && !["paused", "terminated", "pending_approval"].includes(agent.status)
    && heartbeat?.enabled === false && heartbeat.wakeOnDemand === true);
}

async function inspectPolicy(ctx: PluginContext, companyId: string, policy: ProjectMandate, config: Record<string, unknown>, record: RecordCheck) {
  const p = policy.content;
  const company = await ctx.companies.get(companyId);
  record("authority", policy.authorizedBy === company?.defaultResponsibleUserId && p.ownerUserId === policy.authorizedBy
    && p.operatingProfileHash === operatingProfileHash(config), "Owner and operating configuration must still match the pinned project revision.");
  const pair = await validateRosterPair(ctx, companyId, p.teamRosterId, p.councilRosterId);
  record("rosters", pair.eligible && pair.team.head.lifecycle === "active" && pair.council.head.lifecycle === "active"
    && pair.team.head.publishedRevision === p.teamRevision && pair.council.head.publishedRevision === p.councilRevision,
    "The original independent team/Council pair must remain active at its exact published revisions.");
  const ids = [...new Set([...pair.team.revision.content.members.map(member => member.agentId),
    pair.council.revision.content.finalReviewerAgentId!, ...p.n3Slots.map(slot => slot.specialistAgentId),
    ...p.publication ? [p.publication.publisherAgentId, p.publication.qaAgentId] : []])];
  for (const id of ids) {
    const agent = await ctx.agents.get(id, companyId);
    record(`actor:${id}`, configuredActor(agent, companyId),
      "An available native CLI actor needs demand wakes and disabled periodic model polling. This does not authorize an extra departure.");
  }
}
