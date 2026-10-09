import type { MissionRecord } from "./missions.js";
import { MissionError } from "./mission-primitives.js";

const ASSISTANCE_CATEGORIES = ["normal_preparation", "owner_choice_or_secret", "technical_repair", "code_assistance", "human_validation"] as const;

function bounded(value: unknown, label: string, maximum = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new MissionError(422, "assistance_input", `${label} must be explicit and bounded`);
  }
  return value.trim();
}

export function missionAssistanceEvent(mission: MissionRecord, actorUserId: string, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !["command", "commandId", "expectedVersion", "category", "cause", "role", "relatedRunId"].includes(key))
      || body.command !== "record-assistance" || !ASSISTANCE_CATEGORIES.includes(body.category as typeof ASSISTANCE_CATEGORIES[number])) {
    throw new MissionError(422, "assistance_input", "Use one supported assistance category and no extra fields");
  }
  if (body.relatedRunId !== undefined && (typeof body.relatedRunId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.relatedRunId))) {
    throw new MissionError(422, "assistance_input", "relatedRunId must identify one native run");
  }
  const relatedRunId = body.relatedRunId as string | undefined;
  const sequence = mission.aggregate.journal.filter(item => item.action === "operator_assistance_recorded").length + 1;
  return { action: "operator_assistance_recorded", sequence, category: body.category,
    cause: bounded(body.cause, "cause", 2000), role: bounded(body.role, "role", 120),
    ...(relatedRunId ? { relatedRunId } : {}), actorUserId, at: new Date().toISOString() };
}

function safeTotal(values: Array<number | null>) {
  if (!values.length || values.some(value => value === null)) return null;
  const total = values.reduce<number>((sum, value) => sum + value!, 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function inspectMissionOperations(mission: MissionRecord) {
  const launches = mission.aggregate.modelSelection?.tasks.flatMap(task => task.launches) ?? [];
  const roles = [...new Set(launches.map(launch => launch.roleKey))].sort().map(roleKey => {
    const roleLaunches = launches.filter(launch => launch.roleKey === roleKey && launch.runId);
    const unknownUsageRunIds = roleLaunches.filter(launch => !launch.measurement
      || launch.measurement.inputTokens === null || launch.measurement.outputTokens === null).map(launch => launch.runId!);
    return { roleKey, runCount: roleLaunches.length,
      repeatedLaunchCount: roleLaunches.filter(launch => launch.previousLaunchKey).length,
      inputTokens: safeTotal(roleLaunches.map(launch => launch.measurement?.inputTokens ?? null)),
      cachedInputTokens: null,
      outputTokens: safeTotal(roleLaunches.map(launch => launch.measurement?.outputTokens ?? null)),
      unknownUsageRunIds,
      provenance: "council:modelSelection.launches.measurement",
      cacheProvenance: "unavailable_in_persisted_model_measurement" };
  });
  const assistance = mission.aggregate.journal.filter(item => item.action === "operator_assistance_recorded")
    .map(({ action: _action, ...item }) => item);
  return { protocol: "council-mission-operations-v1", roles, assistance,
    outputAssessment: { state: "unknown", reason: "No attributable tool-output size or mission threshold is persisted in Council" },
    notes: ["cachedInputTokens is a subset of inputTokens when observed and is never added to totals",
      "Unknown measurement remains null; this report does not change reservations, costs or the admission ledger"] };
}
