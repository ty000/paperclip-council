import { createHash } from "node:crypto";

export class MissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MissionError";
  }
}

/** Abandonment is permanent execution revocation, not an accepted result. */
export function assertMissionNotAbandoned(m: { aggregate: { draftAbandonment?: unknown } }) {
  if (m.aggregate.draftAbandonment !== undefined) {
    throw new MissionError(409, "mission_abandoned", "This unused draft was explicitly abandoned; its original identity and history remain read-only");
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

export function canonicalPayloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
