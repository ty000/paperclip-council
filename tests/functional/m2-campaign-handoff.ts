/** Executable operator payloads; placeholders require current public readback, never fabricated future subjects. */
export function m2CampaignHandoff(c: any, source: any, target: any) {
  const { configureDelivery: _noPublicationA, reconcileDelivery: _noPublisherA, requestCorrection: _noPostPublicationA, upgradeAcceptedBuild: _noUpgradeA, sequence: _noGenericSequenceA, ...a } = source;
  const { activate: _noManualBAdmission, startLead: _noManualBWake, sequence: _noGenericSequenceB, ...b } = target;
  const owner = (command: string, fields: any = {}) => ({ method: "POST", path: `${c.secondMission.missionPath}/commands`, body: {
    companyId: c.companyId, command, commandId: "GENERATE_UUID_ONCE", expectedVersion: "READ_CURRENT_B_VERSION", ...fields } });
  const expectedResult = { submissionId: "READ_A_CURRENT_SUBMISSION_ID", candidateCommit: "READ_A_EXACT_CANDIDATE", bundleSha256: "READ_A_BUNDLE_SHA256",
    evidenceRevision: "READ_A_EVIDENCE_REVISION", mandateHash: "READ_A_MANDATE_HASH" };
  return { campaign: "m2-coordination-v1", companyId: c.companyId, projectId: c.projectId, repository: c.repository,
    missions: { A: a, B: b }, publication: "Only B publishes one cumulative accepted A+B PR; A has no publisher or delivery-readiness claim",
    configureDependency: owner("configure-result-dependency", { sourceMissionId: c.missionId, expectedResult, periodKey: c.operatingProfile.periodKey,
      requestedUnits: c.operatingProfile.runReservationUnits, coordination: { coordinatorAgentId: c.agents.pm.id, facilitatorAgentId: c.agents.facilitator.id,
        allowedPriorities: ["medium", "high"], participantAgentIds: [c.agents.lead.id, c.agents.quality.id], requestedUnits: c.operatingProfile.runReservationUnits,
        mandate: "Coordinate A before B within medium/high priorities. Resolve only a concrete handoff question: what should the card let a user do when an accepted prerequisite exists but downstream delivery or an owner decision is pending? Distinguish acceptance, scheduling permission and publication; do not invent readiness, change mandate or reserve extra capacity." } }),
    transferCoordinator: owner("transfer-result-coordinator", { coordinatorAgentId: c.agents.pmSuccessor.id, reason: "ACTUAL_OWNER_TRANSFER_REASON; no active PM work" }),
    rebindAcceptedCorrection: owner("rebind-result-dependency", { expectedResult, preserveCoordinationRelease: true,
      reason: "ACTUAL_OWNER_REASON carrying ordering/release to same-mandate accepted correction; no claim PM reviewed new candidate" }),
    resolveCoordination: owner("resolve-result-coordination", { action: "release", reason: "ACTUAL_RESERVED_OWNER_DECISION" }),
    reconcileDependency: { method: "POST", path: `${c.secondMission.missionPath}/commands`, body: { companyId: c.companyId, command: "reconcile-result-dependency" } },
    sequence: [
      "Preparation only: both missions inactive, all ten agents timer/demand wakes disabled, zero provider/publication authority. Obtain concrete authorization before activation.",
      "Read effective profiles/charters and exact runtime/GitHub target; native inherited authentication is not proven inside the model subprocess until its authorized run. No test-environment/hello or credential copying.",
      "Enable only authorized roles, activate/start A once; immediately hold lead demand wakes. Use the source handoff for owner-assisted terminal N1 child closure and settlement. Never configure-delivery on A.",
      "After A start-review exposes an actual exact submission, configure B dependency using that current tuple plus coordination mandate in one CAS, before acceptance when possible. Do not invent a future subject. Enable PM/facilitator demand wakes only under campaign authority.",
      "B waits durably. PM may resolve directly, hold/escalate, or invoke one bounded facilitation on the real handoff question. Owner transfer to successor occurs only after PM terminal/settlement; preserve work/effect identities. No extra PM run solely for replacement evidence.",
      "If A V1 needs its one real correction, wait for exact V2 acceptance/settlement and idle coordination. Owner rebinds the same A/root/mandate with current tuple and explicit disposition of earlier PM release; same guard/unused intent IDs.",
      "Do not manually activate/start B or PATCH its guard done. Controller verifies acceptance, attached immutable bundle and all accounting, then uses existing N1 admission/wake. Operator holds lead demand wakes immediately after B starts, exactly as N1 A.",
      "Lead B obtains n6Handoff through authenticated inspect, downloads its native attachment and verifies SHA256/git bundle/candidate. Clean shared HEAD must equal accepted A; set B base to exact A, preserve ancestry, remote and cumulative target branch. Stop on mismatch; never reset or substitute floating main.",
      "B contributes/integrates within its own plan, then owner settles N1 and configures delivery from CURRENT B plan revision before ordinary review. Only its admitted publisher claims/creates the cumulative PR; corrections update that same PR with explicit lease.",
      "Track total <=25 runs and <=50M envelope, one correction per mission, no provider retry, stop unknown effect/usage. Every coordination run is separately admitted and terminal-settled. Admission is not a provider hard cap.",
      "After all orchestration is terminal/settled, build exact accepted cumulative B at this installed packagePath, upgrade same plugin and observe actual UI. Preserve native/Git evidence, then stop only this owned session. No merge/deploy.",
    ] };
}
