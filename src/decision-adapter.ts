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
    },
    targetUrl: `${config.apiBaseUrl}/api/issues/${input.issueId}`,
  } as const;
}

async function readBoundedResponse(response: Response): Promise<{
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
    if (length > MAX_NATIVE_RESPONSE_BYTES) {
      await reader.cancel();
      return {
        body: { truncated: true, maximumBytes: MAX_NATIVE_RESPONSE_BYTES },
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

export async function emitCouncilReviewTransition(
  ctx: PluginContext,
  input: { companyId: string; issueId: string },
): Promise<{
  nativeStatus: number;
  nativeResponse: unknown;
  nativeBodyValid: boolean;
  nativeBodyTruncated: boolean;
}> {
  const config = parseCouncilConfig(await ctx.config.get(input.companyId));
  const apiKey = await ctx.secrets.resolve(config.councilApiKey, {
    companyId: input.companyId,
    configPath: "councilApiKey",
  });
  const response = await fetch(`${config.apiBaseUrl}/api/issues/${input.issueId}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ status: "in_review" }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const native = await readBoundedResponse(response);
  return {
    nativeStatus: response.status,
    nativeResponse: native.body,
    nativeBodyValid: native.validJson,
    nativeBodyTruncated: native.truncated,
  };
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
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-paperclip-run-id": input.runId,
    },
    body: JSON.stringify(patch.body),
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
