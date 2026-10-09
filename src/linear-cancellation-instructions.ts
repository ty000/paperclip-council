import { fileURLToPath } from "node:url";
import type { MissionRecord } from "./missions.js";
export function cancellationInstructions(m: MissionRecord) {
  const path = fileURLToPath(new URL("../scripts/operations/cancel_delivery.py", import.meta.url));
  return `Council cancellation ${m.missionId}. This separately reserved publisher may close only the original unmerged obsolete PR. Run python3 ${JSON.stringify(path)} close --mission-id ${m.missionId} --company-id ${m.companyId} in the admitted repository. The executable journals the native command before claiming permission and sends at most one GitHub close. After any loss/interruption/prepared journal, use operation observe only. Never manually repeat the close, merge, create a PR, push, delete a branch or remove commits. Already integrated commits remain intact. Costs settle through the existing Council driver; do not mark product/campaign done. An unknown merge or changed head requires arbitration.
Plugins/skills à utiliser: Council continuity/cancellation contract, then existing repository GitHub instructions. Modèle et effort recommandés: the mission's pinned orchestration profile, with effective options observed at native launch; reevaluate only through an authorized new attempt. Repository/home model-selection mapping unavailable during authoring (2026-10-09); no supported option is inferred.`;
}
