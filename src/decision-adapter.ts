import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  CouncilConfig,
  CouncilDecisionInput,
  CouncilDecisionResult,
  SecretRef,
} from "./contracts.js";

const MAX_NATIVE_RESPONSE_BYTES = 64 * 1024;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing ${label}`);
  }
  return value.trim();
}

function requireSecretRef(value: unknown): SecretRef {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as { type?: unknown }).type !== "secret_ref"
    || typeof (value as { secretId?: unknown }).secretId !== "string"
    || (value as { secretId: string }).secretId.trim() === ""
  ) {
    throw new Error("Missing councilApiKey secret_ref");
  }
  return value as SecretRef;
}

export function parseCouncilConfig(value: Record<string, unknown>): CouncilConfig {
  const rawUrl = requiredString(value.apiBaseUrl, "apiBaseUrl");
  const url = new URL(rawUrl);
  const isLoopback = url.hostname === "localhost"
    || url.hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (!isLoopback) {
    throw new Error("apiBaseUrl must use a loopback host");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("apiBaseUrl must use http or https");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("apiBaseUrl must be an origin without credentials, path, query, or fragment");
  }
  return {
    apiBaseUrl: url.toString().replace(/\/$/, ""),
    councilAgentId: requiredString(value.councilAgentId, "councilAgentId"),
    councilApiKey: requireSecretRef(value.councilApiKey),
  };
}

export function buildCouncilDecisionRequest(config: CouncilConfig, input: CouncilDecisionInput) {
  const requestedIssueStatus = input.verdict === "changes_requested" ? "in_progress" : "done";
  const label = input.verdict === "changes_requested" ? "changes requested" : "approved";
  return {
    requestedIssueStatus,
    body: {
      status: requestedIssueStatus,
      comment: [
        `Council decision: ${label}.`,
        `Justification: ${input.justification}`,
        `Result reference: ${input.resultReference}`,
        `Operation ID: ${input.operationId}`,
        ...(input.verdict === "approved" ? [`Approved commit: ${input.approvedCommit}`] : []),
      ].join("\n"),
      ...(input.nativeReview ? { nativeReview: input.nativeReview } : {}),
    },
    targetUrl: `${config.apiBaseUrl}/api/issues/${input.issueId}${input.nativeReview
      ? `/interactions/${input.nativeReview.interactionId}/${input.verdict === "approved" ? "accept" : "reject"}` : ""}`,
  } as const;
}

async function readBoundedResponse(response: Response, maximumBytes = MAX_NATIVE_RESPONSE_BYTES): Promise<{
  body: unknown;
  validJson: boolean;
  truncated: boolean;
}> {
  if (!response.body) return { body: null, validJson: false, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      return {
        body: { truncated: true, maximumBytes },
        validJson: false,
        truncated: true,
      };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { body: JSON.parse(text) as unknown, validJson: true, truncated: false };
  } catch {
    return { body: text, validJson: false, truncated: false };
  }
}

// Native accounting performs several authenticated reads per run. The host limits
// secret resolution to 30/minute. Cache only the read credential briefly, never
// run state or authorization responses; verdict emission still resolves freshly.
const nativeReadCredentials = new WeakMap<PluginContext, { key: string; expires: number; value: Promise<string> }>();
async function nativeReadCredential(ctx: PluginContext, companyId: string, config: CouncilConfig) {
  const key = JSON.stringify([companyId, config.apiBaseUrl, config.councilAgentId, config.councilApiKey]);
  const prior = nativeReadCredentials.get(ctx);
  if (prior?.key === key && prior.expires > Date.now()) return prior.value;
  const entry = { key, expires: Date.now() + 5_000,
    value: ctx.secrets.resolve(config.councilApiKey, { companyId, configPath: "councilApiKey" }) };
  nativeReadCredentials.set(ctx, entry);
  try { return await entry.value; }
  catch (error) { if (nativeReadCredentials.get(ctx) === entry) nativeReadCredentials.delete(ctx); throw error; }
}

/** Public telemetry and native interactions use the configured Council identity. */
export async function councilNativeRequest(
  ctx: PluginContext,
  companyId: string,
  path: string,
  options: { method?: "GET" | "POST"; runId?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const config = parseCouncilConfig(await ctx.config.get(companyId));
  if (!/^\/api\/(heartbeat-runs|issues)\/[a-zA-Z0-9/-]+$/.test(path)) throw new Error("Invalid Council native resource path");
  const apiKey = !options.method || options.method === "GET" ? await nativeReadCredential(ctx, companyId, config)
    : await ctx.secrets.resolve(config.councilApiKey, { companyId, configPath: "councilApiKey" });
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json",
      ...(options.runId ? { "x-paperclip-run-id": options.runId } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(15_000), redirect: "error",
  });
  if (response.status === 401 || response.status === 403) nativeReadCredentials.delete(ctx);
  // Public heartbeat telemetry includes contextSnapshot and runnerProfileJson:
  // the native correction response measured 101,848 bytes on the pinned host.
  // Keep a finite read-only allowance; decision effects retain the 64 KiB bound.
  const maximumBytes = (!options.method || options.method === "GET") && path.startsWith("/api/heartbeat-runs/") ? 512 * 1024 : MAX_NATIVE_RESPONSE_BYTES;
  const parsed = await readBoundedResponse(response, maximumBytes);
  if (!parsed.validJson || parsed.truncated) throw new Error(`Native response is not bounded valid JSON (status=${response.status}, type=${response.headers.get("content-type")}, truncated=${parsed.truncated}, maximumBytes=${maximumBytes})`);
  return { status: response.status, body: parsed.body };
}

/**
 * The only adapter that emits council decisions. It deliberately uses the
 * qualified public issue API instead of ctx.issues.update or direct storage.
 */
export async function emitCouncilDecision(
  ctx: PluginContext,
  config: CouncilConfig,
  input: CouncilDecisionInput,
): Promise<CouncilDecisionResult> {
  const apiKey = await ctx.secrets.resolve(config.councilApiKey, {
    companyId: input.companyId,
    configPath: "councilApiKey",
  });
  const patch = buildCouncilDecisionRequest(config, input);
  const response = await fetch(patch.targetUrl, {
    method: input.nativeReview ? "POST" : "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-paperclip-run-id": input.runId,
    },
    body: JSON.stringify(input.nativeReview ? { reason: patch.body.comment } : patch.body),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const native = await readBoundedResponse(response);
  return {
    verdict: input.verdict,
    requestedIssueStatus: patch.requestedIssueStatus,
    nativeStatus: response.status,
    nativeResponse: native.body,
    nativeBodyValid: native.validJson,
    nativeBodyTruncated: native.truncated,
  };
}
