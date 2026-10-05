import type { ProfileId, TaskFamily } from "./model-catalogue.js";
import type { ModelLaunch } from "./model-state.js";

export type ModelEstimate = {
  roleKey: string; family: TaskFamily; profileId: ProfileId;
  mappingRevision: string; variantRevision: string; sampleCount: number;
  inputTokens: number | null; outputTokens: number | null; durationMs: number | null;
};
type Metrics = Pick<ModelEstimate, "inputTokens" | "outputTokens" | "durationMs">;
function metric(value: number | null) { return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Caller supplies the documented company-history window. Estimates never change admission or authorize work. */
export function modelEstimates(launches: readonly ModelLaunch[]): ModelEstimate[] {
  const groups = new Map<string, ModelEstimate>();
  const samples = new Map<string, { key: string; metrics: Metrics; fingerprint: string } | null>();
  for (const launch of launches) {
    const { roleKey, family, profileId, mappingRevision, variantRevision } = launch;
    const key = JSON.stringify([roleKey, family, profileId, mappingRevision, variantRevision]);
    if (!groups.has(key)) groups.set(key, { roleKey, family, profileId, mappingRevision, variantRevision,
      sampleCount: 0, inputTokens: null, outputTokens: null, durationMs: null });
    const measured = launch.measurement;
    if (!launch.runId || !measured || measured.runId !== launch.runId) continue;
    if (launch.state !== "bound" || measured.status !== "succeeded") { samples.set(launch.runId, null); continue; }
    const metrics = { inputTokens: metric(measured.inputTokens), outputTokens: metric(measured.outputTokens), durationMs: metric(measured.durationMs) };
    const fingerprint = JSON.stringify([key, metrics]);
    const prior = samples.get(launch.runId);
    // Conflicting attribution/readback is not a comparable sample; never choose an arbitrary duplicate.
    if (samples.has(launch.runId) && prior?.fingerprint !== fingerprint) samples.set(launch.runId, null);
    else if (!samples.has(launch.runId)) samples.set(launch.runId, { key, metrics, fingerprint });
  }
  for (const [key, estimate] of groups) {
    const comparable = [...samples.values()].filter((sample): sample is NonNullable<typeof sample> => sample !== null && sample.key === key);
    estimate.sampleCount = comparable.length;
    for (const field of ["inputTokens", "outputTokens", "durationMs"] as const) {
      // A missing metric remains unknown instead of being treated as zero or silently changing the denominator.
      estimate[field] = comparable.length && comparable.every(sample => sample.metrics[field] !== null)
        ? comparable.reduce((sum, sample) => sum + sample.metrics[field]! / comparable.length, 0) : null;
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, estimate]) => estimate);
}
