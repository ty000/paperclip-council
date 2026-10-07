import type { MissionRecord } from "./missions.js";
import { MissionError } from "./missions.js";

const checks = ["gitTool", "ghTool", "workspaceIdentity", "localCandidate", "originIdentity", "trackedFilesClean", "repositoryRead", "pushPermissionReported", "remoteBase", "remoteHeadLease"] as const;
export type PublisherPreflight = { protocol: "publisher-run-report-v1"; provenance: "publisher_run_report";
  runId: string; agentId: string; recordedAt: string; observedAt: string; reportSha256: string;
  repository: string; candidateCommit: string; baseCommit: string; baseRef: string; headRef: string; remoteHead: string | null };

function freshObservation(value: unknown) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= Date.now() + 5_000 && Date.now() - time <= 300_000;
}

/** Validate an attributed report; never promote a reported permission to a push. */
export function validatePublisherPreflight(m: MissionRecord, value: unknown, runId: string) {
  const n5 = m.aggregate.n5!; const p = n5.publication!;
  const report = value as Record<string, unknown> | undefined;
  const recordedChecks = report?.checks as Record<string, unknown> | undefined;
  const old = n5.continuation?.previousPublication;
  const expectedRemoteHead = p.operation === "update" ? old?.submission.candidateCommit : null;
  if (p.operation === "update" && (!expectedRemoteHead || old?.observation?.headSha !== expectedRemoteHead)) {
    throw new MissionError(409, "n5_preflight_previous_head_unknown", "Update preflight needs the persisted, observed previous head");
  }
  const bindings = { protocol: "publisher-run-report-v1", provenance: "publisher_run_report", status: "pass",
    missionId: m.missionId, intentId: p.intentId, issueId: p.issueId, runId, repository: n5.authority.repository,
    candidateCommit: p.submission.candidateCommit, baseCommit: p.submission.baseCommit, baseRef: n5.authority.baseRef,
    headRef: n5.authority.headRef, remoteHead: expectedRemoteHead, publicationWriteObserved: false, providerTurnsStartedByProbe: 0 };
  if (!report || p.runId !== runId || Object.entries(bindings).some(([key, expected]) => report[key] !== expected)
    || !freshObservation(report.observedAt) || !recordedChecks || checks.some(key => recordedChecks[key] !== true)) {
    throw new MissionError(409, "n5_publisher_preflight_required", "Fresh successful preflight from this exact admitted publisher run and target is required before any publication write");
  }
  // Store selected bindings + hash, not raw output, credentials or arbitrary fields.
  return { observedAt: report.observedAt as string, repository: n5.authority.repository,
    candidateCommit: p.submission.candidateCommit, baseCommit: p.submission.baseCommit,
    baseRef: n5.authority.baseRef, headRef: n5.authority.headRef, remoteHead: expectedRemoteHead! };
}
