/** Remove recovery-only history from every public worker response without mutating durable state. */
export function publicResponseBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResponseBody);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) =>
    key === "historyArchive" ? [] : [[key, publicResponseBody(entry)]]));
}

export function publicResponse<T extends { body: unknown }>(response: T): T {
  return { ...response, body: publicResponseBody(response.body) };
}
