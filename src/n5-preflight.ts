import { createHash } from "node:crypto";
import { MissionError, type MissionRecord } from "./missions.js";
import { inspectN2State } from "./n2-missions.js";

export function acceptedN5Submission(m: MissionRecord) {
  const n2 = inspectN2State(m);
  if (n2?.status !== "accepted" || n2.application.state !== "observed" || !n2.usage.complete
      || !n2.submission || n2.application.submissionId !== n2.submission.submissionId) throw new MissionError(409, "n5_accepted_candidate_required", "Native acceptance and exact terminal accounting must precede publication");
  if (n2.submission.mandateHash !== createHash("sha256").update(JSON.stringify(m.aggregate.mandate)).digest("hex")) throw new MissionError(409, "n5_mandate_changed", "Accepted submission belongs to a different mandate");
  const native = m.aggregate.n2?.native;
  if (native && !native.transmission.settledAt) throw new MissionError(409, "n5_source_usage_pending", "Native transmission accounting is required before publication");
  if (m.aggregate.n3?.rounds.some(round => !round.transmission.settledAt || round.specialists.some(item => !item.settledAt))) {
    throw new MissionError(409, "n5_source_usage_pending", "Every N3 specialist and transmission must be settled before publication");
  }
  return n2.submission;
}
