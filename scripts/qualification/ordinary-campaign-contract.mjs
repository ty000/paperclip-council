import { N45_HOST_SHA } from "./n45-contract.mjs";
export function ordinaryCampaignProfile(input, mode, candidateSha) {
  if (!["prepare", "session"].includes(mode)) throw new Error("Use prepare or session; neither wakes agents");
  if (input.candidateSha !== candidateSha || !/^[a-f0-9]{40}$/.test(candidateSha)) throw new Error("Exact clean candidateSha required");
  if (input.repository !== "ty000/paperclip-council" || input.baseRef !== "main" || !/^codex\/council-delivery-[a-z0-9-]+$/.test(input.headRef)) throw new Error("Explicit Council repository/main/isolated head required");
  if (!input.model || !["low", "medium", "high", "xhigh"].includes(input.effort)) throw new Error("Explicit model/effort; availability remains unobserved");
  if (input.campaign !== undefined && input.campaign !== "m2-coordination-v1") throw new Error("Unknown ordinary campaign");
  const m2 = input.campaign === "m2-coordination-v1";
  const bounds = m2 ? { nominal: 16, maximum: 25, units: 50_000_000 } : { nominal: 7, maximum: 12, units: 24_000_000 };
  if (input.nominalRuns !== bounds.nominal || input.maxRuns !== bounds.maximum || input.runUnits !== 2_000_000 || input.periodUnits !== bounds.units) throw new Error("Proposed ordinary envelope does not match the explicit campaign bounds; not a provider hard cap");
  if (input.providerAuthorized !== false || input.githubPublicationAuthorized !== false) throw new Error("Preparation/session starts with provider and publication authorization false");
  return { ...input, mode, runtimeProfile: "ordinary-cli-v1", hostSha: N45_HOST_SHA, maxConcurrent: 2, maxRetries: 0, maxCorrections: 1 };
}
export function assertOrdinaryCampaignResult(exitCode, evidence, profile) {
  if (exitCode !== 0 || evidence.candidate?.commit !== profile.candidateSha || evidence.ordinaryCampaign?.profile.mode !== profile.mode
      || evidence.outcome !== "ORDINARY CAMPAIGN PREPARATION OBSERVED" || !evidence.launcherCleanup?.ownedRuntimeRemoved) {
    throw new Error("Preparation requires exit0, exact candidate/result and owned cleanup; no campaign execution is implied");
  }
}
