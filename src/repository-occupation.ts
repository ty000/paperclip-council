import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { MissionRecord } from "./missions.js";
import { MissionError } from "./mission-primitives.js";
import { FIXED_CAMPAIGN_MODE } from "./linear-continuity-contract.js";

type Subject = Pick<MissionRecord, "companyId" | "missionId" | "projectId" | "aggregate"> & { version?: number };
type Holder = { companyId: string; missionId: string; projectId: string; repository: string | null; exclusive: boolean };
type Document = { initialized: boolean; holders: Record<string, Holder> };
type Snapshot = { version: number; document: Document };
const bound = 2048;

function table(ctx: PluginContext) {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.repository_occupation`;
}
const key = (m: Pick<Subject, "companyId" | "missionId">) => `${m.companyId}:${m.missionId}`;

/** Publication owner/repo and the native workspace's GitHub URL name the same repository. */
export function canonicalRepository(value: string): string {
  let path = value.trim();
  if (/^git@github\.com:/i.test(path)) path = path.slice("git@github.com:".length);
  else if (/^https?:\/\//i.test(path) || /^ssh:\/\//i.test(path)) {
    const url = new URL(path);
    if (url.hostname.toLowerCase() !== "github.com" || url.password || url.search || url.hash
        || url.port || (url.username && !(url.protocol === "ssh:" && url.username === "git"))) {
      throw new MissionError(422, "repository_identity_invalid", "Use an exact supported GitHub repository identity without credentials");
    }
    path = url.pathname.slice(1);
  }
  path = path.replace(/\/$/, "").replace(/\.git$/i, "");
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(path) || [".", ".."].includes(path.split("/")[1]!)) {
    throw new MissionError(422, "repository_identity_invalid", "Use an exact GitHub owner/repository or canonical clone URL");
  }
  return `github.com/${path.toLowerCase()}`;
}

async function target(ctx: PluginContext, m: Subject): Promise<string | null> {
  const pinned = m.aggregate.projectMandate?.publication?.repository ?? m.aggregate.n5?.authority.repository;
  const workspace = await ctx.projects.getPrimaryWorkspace(m.projectId, m.companyId);
  const publication = pinned ? canonicalRepository(pinned) : null;
  const native = workspace?.repoUrl ? canonicalRepository(workspace.repoUrl) : null;
  if (publication && native && publication !== native) throw new MissionError(409, "repository_target_changed", "Pinned publication and native primary workspace must identify the same repository");
  return publication ?? native;
}

async function read(ctx: PluginContext): Promise<Snapshot> {
  const rows = await ctx.db.query<Snapshot>(`SELECT version, document FROM ${table(ctx)} WHERE singleton = true`);
  const row = rows[0];
  if (!row || !Number.isSafeInteger(Number(row.version)) || !row.document?.holders
      || typeof row.document.initialized !== "boolean") throw new MissionError(409, "repository_registry_missing", "The migrated durable repository registry must be readable");
  return { version: Number(row.version), document: row.document };
}
async function save(ctx: PluginContext, before: Snapshot, document: Document) {
  const result = await ctx.db.execute(`UPDATE ${table(ctx)} SET document = $1::jsonb, version = version + 1
    WHERE singleton = true AND version = $2`, [JSON.stringify(document), before.version]);
  return result.rowCount === 1;
}

/** The singleton CAS is the first-campaign fence, not a lease or scheduler.
 * New mission registration occurs before INSERT. A bootstrap that races it loses
 * the CAS and rereads both the registry and legacy inventory; no active task disappears.
 */
async function initialized(ctx: PluginContext): Promise<Snapshot> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await read(ctx);
    if (snapshot.document.initialized) return snapshot;
    const rows = await ctx.db.query<{ company_id: string; mission_id: string; project_id: string; aggregate: MissionRecord["aggregate"] }>(
      `SELECT company_id, mission_id, project_id, aggregate FROM ${ctx.db.namespace}.missions ORDER BY company_id, mission_id LIMIT ${bound + 1}`);
    if (rows.length > bound) throw new MissionError(409, "repository_inventory_bound", "Legacy mission inventory exceeds the bounded bootstrap; retain the registry without admitting a campaign");
    const holders = { ...snapshot.document.holders };
    for (const row of rows) {
      const m: Subject = { companyId: row.company_id, missionId: row.mission_id, projectId: row.project_id, aggregate: row.aggregate };
      if (!holders[key(m)]) holders[key(m)] = { companyId: m.companyId, missionId: m.missionId, projectId: m.projectId,
        repository: await target(ctx, m), exclusive: m.aggregate.linearContinuity?.mode === FIXED_CAMPAIGN_MODE };
    }
    // An existing fixed-mode campaign predating this migration must not silently
    // override any ordinary work. Both remain held until explicitly reconciled.
    if (await save(ctx, snapshot, { initialized: true, holders })) return read(ctx);
  }
  throw new MissionError(409, "repository_registry_contention", "Repository inventory changed concurrently; retry the original mission identity");
}

function conflict(holders: Record<string, Holder>, ownKey: string, wanted: Holder) {
  return Object.entries(holders).some(([id, other]) => id !== ownKey
    && (wanted.exclusive || other.exclusive)
    && (!wanted.repository || !other.repository || wanted.repository === other.repository));
}

async function assertCurrentMission(ctx: PluginContext, m: Subject) {
  table(ctx);
  if (m.version !== undefined) {
    const rows = await ctx.db.query<{ version: number; aggregate: MissionRecord["aggregate"] }>(
      `SELECT version, aggregate FROM ${ctx.db.namespace}.missions WHERE company_id = $1 AND mission_id = $2`, [m.companyId, m.missionId]);
    const current = rows[0];
    if (current && (Number(current.version) !== m.version || current.aggregate.completion?.state === "closed"
        || current.aggregate.linearContinuity?.control === "cancelled")) {
      throw new MissionError(409, "repository_mission_changed", "Reread the original mission before repository admission; stale or terminal authority cannot be reused");
    }
  }
  if (m.aggregate.completion?.state === "closed" || m.aggregate.linearContinuity?.control === "cancelled") {
    throw new MissionError(409, "repository_mission_terminal", "A terminal mission cannot acquire or reuse repository execution authority");
  }
}

async function reconcileTerminalHolders(ctx: PluginContext, m: Subject, repository: string) {
  const snapshot = await initialized(ctx);
  const { getMission } = await import("./missions.js");
  const { reconcileRepositoryRelease } = await import("./repository-release.js");
  for (const holder of Object.values(snapshot.document.holders)) {
    if (key(holder) === key(m) || (holder.repository && holder.repository !== repository)) continue;
    const original = await getMission(ctx, holder.companyId, holder.missionId);
    if (original) await reconcileRepositoryRelease(ctx, original);
  }
}

/** The identity is owned by Council, never by an intake-supplied replacement key. */
export async function ensureMissionRepository(ctx: PluginContext, m: Subject, exclusive = m.aggregate.linearContinuity?.mode === FIXED_CAMPAIGN_MODE) {
  await assertCurrentMission(ctx, m);
  const repository = await target(ctx, m);
  if (exclusive && !repository) throw new MissionError(409, "repository_target_missing", "A campaign requires a verified canonical repository target");
  if (exclusive) await reconcileTerminalHolders(ctx, m, repository!);
  await acquire(ctx, m, repository, exclusive);
}

async function acquire(ctx: PluginContext, m: Subject, repository: string | null, exclusive: boolean) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = exclusive ? await initialized(ctx) : await read(ctx);
    const ownKey = key(m), previous = before.document.holders[ownKey];
    const wanted = retainedHolder(m, repository, exclusive, previous);
    if (conflict(before.document.holders, ownKey, wanted)) {
      throw new MissionError(409, "repository_occupied", "The repository is retained by another campaign or unfinished mission; reconcile original work before admission");
    }
    if (previous && previous.repository === repository && previous.exclusive === wanted.exclusive) return;
    if (!previous && Object.keys(before.document.holders).length >= bound) throw new MissionError(409, "repository_inventory_bound", "Reconcile existing occupation before adding more mission identities");
    if (await save(ctx, before, { ...before.document, holders: { ...before.document.holders, [ownKey]: wanted } })) return;
  }
  throw new MissionError(409, "repository_registry_contention", "Concurrent repository acquisition requires retry under the original identity");
}

function retainedHolder(m: Subject, repository: string | null, exclusive: boolean, previous?: Holder): Holder {
  if (previous && (previous.projectId !== m.projectId || (previous.repository && previous.repository !== repository))) {
    throw new MissionError(409, "repository_target_changed", "Retain the original mission repository and project; no replacement occupation");
  }
  return { companyId: m.companyId, missionId: m.missionId, projectId: m.projectId,
    repository, exclusive: Boolean(exclusive || previous?.exclusive) };
}

/** Private release seam: callers must prove safe terminal state, then the SQL
 * version predicate ensures the exact reconciled mission has not changed.
 */
export async function releaseReconciledRepository(ctx: PluginContext, m: MissionRecord) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await read(ctx), holders = { ...before.document.holders };
    if (!holders[key(m)]) return;
    delete holders[key(m)];
    const result = await ctx.db.execute(`UPDATE ${table(ctx)} SET document = $1::jsonb, version = version + 1
      WHERE singleton = true AND version = $2 AND EXISTS (
        SELECT 1 FROM ${ctx.db.namespace}.missions WHERE company_id = $3 AND mission_id = $4 AND version = $5
          AND (aggregate->'completion'->>'state' = 'closed' OR aggregate->'linearContinuity'->>'control' = 'cancelled'))`,
      [JSON.stringify({ ...before.document, holders }), before.version, m.companyId, m.missionId, m.version]);
    if (result.rowCount === 1) return;
  }
  throw new MissionError(409, "repository_release_pending", "The original terminal mission changed during release; retain occupation and reconcile");
}
