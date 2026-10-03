export const N45_HOST_SHA = "61b3fd57a695614dc4a37e2303f426a34a9795cf";
export function n45Profile(input, mode, candidateSha) {
  if (!["prepare", "launch"].includes(mode)) throw new Error("Use prepare or launch");
  if (input.candidateSha !== candidateSha || !/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("Exact clean Council candidateSha required");
  if (input.repository !== "ty000/paperclip-council" || input.baseRef !== "main"
      || !/^codex\/council-delivery-[a-z0-9-]+$/.test(input.headRef)) throw new Error("Explicit Council main and isolated delivery branch required");
  if (!input.model || !["low", "medium", "high", "xhigh"].includes(input.effort)) throw new Error("Explicit model and effort required; no fallback");
  if (input.maxRuns !== 15 || input.runUnits !== 2_000_000
      || input.periodUnits !== input.maxRuns * input.runUnits) throw new Error("Explicit 15-run allowance with 2M reservation per run required");
  if (mode === "launch" && (input.providerAuthorized !== true || input.githubPublicationAuthorized !== true
      || typeof input.authorizationId !== "string" || !input.authorizationId.trim())) throw new Error("Fresh provider and GitHub publication authorization required");
  return { ...input, mode, hostSha: N45_HOST_SHA, maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 };
}
export function assertN45Result(exitCode, evidence, mode, candidateSha) {
  if (exitCode !== 0 || evidence.candidate?.commit !== candidateSha || evidence.n45?.mode !== mode
      || evidence.outcome !== (mode === "prepare" ? "N45 PREPARATION OBSERVED" : "N45 CAMPAIGN OBSERVED")
      || !evidence.launcherCleanup?.ownedRuntimeRemoved) throw new Error("N45 requires exit0 AND matching observed result AND cleanup; inspect full log and JSON");
}
