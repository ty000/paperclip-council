import type { SecretRef } from "./contracts.js";
import { canonicalPayloadHash, MissionError } from "./missions.js";

export type GithubFeedbackRefreshAuthority = {
  protocol: "controller-github-feedback-v1";
  secretRef: SecretRef;
};

function secretRef(value: unknown): SecretRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type !== "secret_ref" || typeof v.secretId !== "string" || !v.secretId.trim()
      || Object.keys(v).some(key => !["type", "secretId", "version"].includes(key))
      || v.version !== undefined && v.version !== "latest" && (!Number.isSafeInteger(v.version) || Number(v.version) < 1)) return undefined;
  return structuredClone(v) as SecretRef;
}

export function parseGithubFeedbackRefreshShape(value: unknown): GithubFeedbackRefreshAuthority | undefined {
  if (value === undefined) return undefined;
  const v = value as Record<string, unknown>, pinned = secretRef(v?.secretRef);
  if (!v || Array.isArray(v) || v.protocol !== "controller-github-feedback-v1" || !pinned
      || Object.keys(v).some(key => !["protocol", "secretRef"].includes(key))) {
    throw new MissionError(422, "github_feedback_authority", "Explicit project authority must pin a native GitHub secret reference");
  }
  return { protocol: "controller-github-feedback-v1", secretRef: pinned };
}

export function assertConfiguredGithubFeedbackRefresh(authority: GithubFeedbackRefreshAuthority | undefined, configured: unknown) {
  if (!authority) return;
  const available = secretRef(configured);
  if (!available || canonicalPayloadHash(authority.secretRef) !== canonicalPayloadHash(available)) {
    throw new MissionError(422, "github_feedback_authority", "Explicit project authority must pin the configured native GitHub secret reference");
  }
}

export function matchesGithubFeedbackSecret(authority: GithubFeedbackRefreshAuthority, configured: unknown) {
  const available = secretRef(configured);
  return Boolean(available && canonicalPayloadHash(authority.secretRef) === canonicalPayloadHash(available));
}
