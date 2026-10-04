import type { PluginContext } from "@paperclipai/plugin-sdk";
import { readAdmission } from "./admission.js";
import { readNativeG4Profile } from "./g4-native.js";
import { MissionError, type MissionRecord } from "./missions.js";

/** Only the source's N1 period and existing current/continuation native periods are read. */
export async function assertN6SourceAccounting(ctx: PluginContext, source: MissionRecord) {
  const n1 = source.aggregate.n1;
  const ordinary = source.aggregate.n2?.ordinary;
  const profile = await readNativeG4Profile(ctx, source.companyId);
  if (!ordinary || !profile || typeof n1?.periodKey !== "string") {
    throw new MissionError(409, "n6_source_profile_unsupported", "N6 currently consumes ordinary sources with identifiable native accounting periods");
  }
  const periods = new Set([n1.periodKey, profile.periodKey]);
  if (source.aggregate.n5?.continuation) periods.add(source.aggregate.n5.continuation.periodKey);
  if (source.aggregate.n6?.coordination) periods.add(source.aggregate.n6.coordination.periodKey);
  const envelopes = await Promise.all([...periods].map(periodKey => readAdmission(ctx, { companyId: source.companyId, periodKey })));
  const reservations = envelopes.flatMap(e => e?.reservations.filter(r => r.missionId === source.missionId) ?? []);
  const contributions = n1.contributions as Array<{ dispatchReservationId?: string }> | undefined;
  const n5 = source.aggregate.n5;
  const required = [n1.activationReservationId, ...contributions?.map(c => c.dispatchReservationId) ?? [],
    ...ordinary.tasks.map(task => task.reservationId), n5?.publication?.reservationId,
    n5?.continuation?.previousPublication.reservationId, ...source.aggregate.n6?.coordination?.tasks.map(t => t.reservationId) ?? []].filter((id): id is string => typeof id === "string");
  if (!reservations.length || required.some(id => !reservations.some(r => r.reservationId === id))
      || reservations.some(r => r.status !== "settled" || r.usage?.status !== "known"
        || r.remainingExposure.status !== "known" || r.remainingExposure.units !== 0)) {
    throw new MissionError(409, "n6_source_usage_pending", "All referenced source reservations must be observed, settled and exposure-free");
  }
}
