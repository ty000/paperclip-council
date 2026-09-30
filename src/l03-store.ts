import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getMission } from "./missions.js";
import { initialL03Governance, L03Error, transitionL03 } from "./l03.js";
import type {
  L03Actor,
  L03ActualEffect,
  L03AuthoritySnapshot,
  L03Command,
  L03CreateInput,
  L03Governance,
} from "./l03-types.js";

type GovernanceRow = {
  aggregate: unknown;
};

function table(ctx: Pick<PluginContext, "db">): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ctx.db.namespace)) throw new Error("Unsafe plugin database namespace");
  return `${ctx.db.namespace}.mission_governance`;
}

function parseStored(value: unknown): L03Governance {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid stored L03 governance aggregate");
  const state = value as L03Governance;
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.version) || state.version < 1
      || !Array.isArray(state.approaches) || !Array.isArray(state.consultationSlots)
      || !Array.isArray(state.results) || !Array.isArray(state.receiptRefs)) {
    throw new Error("Unsupported stored L03 governance aggregate");
  }
  return state;
}

export class L03GovernanceStore {
  constructor(private readonly ctx: Pick<PluginContext, "db">) {}

  async get(companyId: string, missionId: string): Promise<L03Governance | null> {
    const rows = await this.ctx.db.query<GovernanceRow>(
      `SELECT aggregate FROM ${table(this.ctx)} WHERE company_id = $1 AND mission_id = $2`,
      [companyId, missionId],
    );
    return rows[0] ? parseStored(rows[0].aggregate) : null;
  }

  async list(companyId: string): Promise<L03Governance[]> {
    const rows = await this.ctx.db.query<GovernanceRow>(
      `SELECT aggregate FROM ${table(this.ctx)} WHERE company_id = $1 ORDER BY updated_at DESC, mission_id LIMIT 100`,
      [companyId],
    );
    return rows.map((row) => parseStored(row.aggregate));
  }

  async create(state: L03Governance): Promise<L03Governance> {
    const inserted = await this.ctx.db.execute(
      `INSERT INTO ${table(this.ctx)}
        (company_id, mission_id, mission_version, mandate_revision, version,
         approach_admitted, result_admitted, consultation_admitted,
         active_consultation_reservations, unknown_cost_exposure_refs, aggregate)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb
       FROM ${this.ctx.db.namespace}.missions
       WHERE company_id = $1 AND mission_id = $2 AND version = $3
       ON CONFLICT (company_id, mission_id) DO NOTHING`,
      [
        state.companyId,
        state.missionId,
        state.missionVersion,
        state.mandateRevision,
        state.version,
        state.counters.approach.admitted,
        state.counters.result.admitted,
        state.counters.consultation.admitted,
        state.counters.consultation.activeReservations,
        JSON.stringify(state.counters.unknownCostExposureRefs),
        JSON.stringify(state),
      ],
    );
    if (inserted.rowCount === 1) return state;
    const existing = await this.get(state.companyId, state.missionId);
    if (existing) throw new L03Error(409, "governance_exists", "L03 governance already exists for this mission", { currentVersion: existing.version });
    throw new L03Error(409, "mission_version_changed", "Mission version changed before L03 governance could be admitted");
  }

  async compareAndSwap(previous: L03Governance, next: L03Governance): Promise<L03Governance> {
    if (next.version !== previous.version + 1) throw new Error("L03 CAS requires exactly one aggregate version increment");
    const updated = await this.ctx.db.execute(
      `UPDATE ${table(this.ctx)} AS governance
       SET version = $1,
           approach_admitted = $2,
           result_admitted = $3,
           consultation_admitted = $4,
           active_consultation_reservations = $5,
           unknown_cost_exposure_refs = $6::jsonb,
           aggregate = $7::jsonb,
           updated_at = now()
       WHERE governance.company_id = $8
         AND governance.mission_id = $9
         AND governance.version = $10
         AND governance.mission_version = $11
         AND governance.mandate_revision = $12
         AND EXISTS (
           SELECT 1 FROM ${this.ctx.db.namespace}.missions AS mission
           WHERE mission.company_id = governance.company_id
             AND mission.mission_id = governance.mission_id
             AND mission.version = governance.mission_version
         )`,
      [
        next.version,
        next.counters.approach.admitted,
        next.counters.result.admitted,
        next.counters.consultation.admitted,
        next.counters.consultation.activeReservations,
        JSON.stringify(next.counters.unknownCostExposureRefs),
        JSON.stringify(next),
        previous.companyId,
        previous.missionId,
        previous.version,
        previous.missionVersion,
        previous.mandateRevision,
      ],
    );
    if (updated.rowCount === 1) return next;
    const current = await this.get(previous.companyId, previous.missionId);
    if (!current) throw new L03Error(404, "governance_not_found", "L03 governance disappeared during compare-and-swap");
    throw new L03Error(409, "version_or_mandate_conflict", "L03 governance or its mission mandate changed concurrently", { currentVersion: current.version });
  }
}

export type L03TrustedMutationFacts = {
  actualEffectObservation?: L03ActualEffect;
};

export class L03GovernanceService {
  private readonly store: L03GovernanceStore;

  constructor(private readonly ctx: PluginContext) {
    this.store = new L03GovernanceStore(ctx);
  }

  async get(companyId: string, missionId: string): Promise<L03Governance | null> {
    return await this.store.get(companyId, missionId);
  }

  async list(companyId: string): Promise<L03Governance[]> {
    return await this.store.list(companyId);
  }

  private async currentAuthority(state: Pick<L03Governance, "companyId" | "missionId" | "authority">): Promise<L03AuthoritySnapshot> {
    const company = await this.ctx.companies.get(state.companyId);
    if (!company || company.id !== state.companyId) throw new L03Error(404, "company_not_found", "Company not found");
    if (!company.defaultResponsibleUserId) throw new L03Error(422, "owner_not_configured", "Company owner is not configured");
    const mission = await getMission(this.ctx, state.companyId, state.missionId);
    if (!mission) throw new L03Error(404, "mission_not_found", "Mission not found");
    const [executor, reviewer, council] = await Promise.all([
      this.ctx.agents.get(state.authority.executorAgentId, state.companyId),
      this.ctx.agents.get(state.authority.finalReviewerAgentId, state.companyId),
      this.ctx.agents.get(state.authority.councilAgentId, state.companyId),
    ]);
    if (!executor || !reviewer || !council) throw new L03Error(409, "pinned_actor_unavailable", "A pinned L03 actor no longer resolves in the current company");
    return {
      ...state.authority,
      companyId: state.companyId,
      missionId: state.missionId,
      missionVersion: mission.version,
      mandateRevision: mission.version,
      ownerUserId: company.defaultResponsibleUserId,
      finalReviewerAgentId: mission.aggregate.responsibilities.finalReviewerAgentId,
    };
  }

  async create(input: L03CreateInput, actor: L03Actor): Promise<L03Governance> {
    const authoritySeed: L03AuthoritySnapshot = {
      companyId: input.companyId,
      missionId: input.missionId,
      missionVersion: input.expectedMissionVersion,
      mandateRevision: input.mandateRevision,
      ownerUserId: "",
      executorAgentId: input.executorAgentId,
      finalReviewerAgentId: input.finalReviewerAgentId,
      councilAgentId: input.councilAgentId,
      executivePluginActorId: input.executivePluginActorId,
      expiresAt: input.expiresAt,
    };
    const current = await this.currentAuthority({ companyId: input.companyId, missionId: input.missionId, authority: authoritySeed });
    if (current.executorAgentId !== input.executorAgentId || current.finalReviewerAgentId !== input.finalReviewerAgentId) {
      throw new L03Error(409, "pinned_roles_changed", "Requested executor or reviewer does not match current mission authority");
    }
    const state = initialL03Governance(input, { now: new Date().toISOString(), actor, current });
    return await this.store.create(state);
  }

  async apply(
    companyId: string,
    missionId: string,
    actor: L03Actor,
    command: L03Command,
    trusted: L03TrustedMutationFacts = {},
  ): Promise<L03Governance> {
    const before = await this.store.get(companyId, missionId);
    if (!before) throw new L03Error(404, "governance_not_found", "L03 governance not found");
    const current = await this.currentAuthority(before);
    const after = transitionL03(before, command, {
      now: new Date().toISOString(),
      actor,
      current,
      actualEffectObservation: trusted.actualEffectObservation,
    });
    return await this.store.compareAndSwap(before, after);
  }
}

