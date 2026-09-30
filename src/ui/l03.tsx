import { usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { L03Governance } from "../l03-types.js";

export type L03Inspection = {
  governance: L03Governance;
  nextAction: string;
  application: { status: string; observationRef: string | null; note: string };
};
const card = { border: "1px solid var(--border)", borderRadius: "0.75rem", padding: "1rem", overflowWrap: "anywhere" as const };

export function L03MissionPanel({ inspection }: { inspection: L03Inspection }) {
  const { governance: g } = inspection;
  const approach = g.approaches.find(a => a.approachId === g.activeApproachId);
  const result = g.results.at(-1);
  const direction = g.approachDirections.at(-1);
  const decision = g.resultDecisions.at(-1);
  return <article style={card} aria-label={`Mission ${g.missionId}`}>
    <h2>Mission {g.missionId}</h2>
    <p><strong>{g.phase.replaceAll("_", " ")}</strong> · revision {g.version}</p>
    <p>Source: {g.ticket.sourceRef} · mandate {g.mandateRevision}, expires {g.authority.expiresAt}</p>
    <h3>Current subject</h3>
    <p>Approach: {approach ? `${approach.approachId} (A${approach.sequence})` : "Awaiting submission"}</p>
    <p>Result: {result ? `${result.resultId} (V${result.sequence}) — ${result.candidateCommit}` : "Awaiting execution and exact result"}</p>
    {result && <p>Author: {result.authorAgentId} · bundle digest: {result.sha256}</p>}
    <details><summary>Preserved acceptance criteria</summary><ul>{g.ticket.criteria.map(c => <li key={c.id}><strong>{c.id}</strong>: {c.text}</li>)}</ul></details>
    <h3>Selected opinions</h3>
    {g.consultationSlots.length === 0 ? <p>No contribution has been reserved.</p> : <ul>{g.consultationSlots.map(s => <li key={s.slot.reservationId}>
      <strong>{s.slot.profile.id}</strong> {s.slot.profile.version} · {s.required ? "required" : "optional"} · {s.contribution ? s.contribution.opinion.recommendation : "opinion missing"}
      <p>Contributor: {s.slot.reservedExecutiveAgentId} · approach: {s.subjectApproachId}</p>
      {s.contribution && <><p>{s.contribution.opinion.summary}</p>
        {s.contribution.opinion.dissent.length > 0 && <p>Dissent: {s.contribution.opinion.dissent.join("; ")}</p>}
        {s.contribution.opinion.limitations.length > 0 && <p>Limitations: {s.contribution.opinion.limitations.join("; ")}</p>}
        <ul>{s.contribution.opinion.findings.map(f => <li key={f.id}>{f.class}: {f.criterionRef} — {f.smallestUsefulAction}</li>)}</ul>
      </>}
    </li>)}</ul>}
    <h3>Direction and result decision</h3>
    <p>Approach direction: {direction ? `${direction.verdict} — ${direction.decisionId}: ${direction.rationale}` : "Not recorded"}</p>
    <p>Result decision: {decision ? `${decision.verdict} — ${decision.decisionId}: ${decision.rationale}` : "Not recorded"}</p>
    <p>Final reviewer: {g.authority.finalReviewerAgentId} · executor: {g.authority.executorAgentId}</p>
    <h3>Application and observations</h3>
    <p role="status">{inspection.application.status}: {inspection.application.note}</p>
    <p>Native observation: {inspection.application.observationRef ?? "No confirmed observation"}</p>
    <h3>Consumed limits</h3>
    <ul>{(["envelope", "approach", "result", "consultation", "correction"] as const).map(k => <li key={k}>{k}: {g.counters[k].admitted} / {g.counters[k].limit}</li>)}</ul>
    <p>Outstanding consultations: {g.counters.consultation.activeReservations}. Unmeasured cost exposures: {g.counters.unknownCostExposureRefs.length}. Monetary usage is not assumed to be zero.</p>
    <p><strong>Next action:</strong> {inspection.nextAction}</p>
  </article>;
}

export function CouncilL03Page(_props: PluginPageProps) {
  const { data, loading, error, refresh } = usePluginData<{ missions: L03Inspection[] }>("council-l03", {});
  return <main style={{ display: "grid", gap: "1rem", padding: "1.5rem", maxWidth: "76rem", margin: "0 auto" }}>
    <h1>Council missions</h1>
    <p>Approach direction, exact result review and bounded corrections under the current mandate.</p>
    <button onClick={() => refresh()}>Refresh observations</button>
    {loading && <p role="status">Loading missions…</p>}
    {error && <p role="alert">Unable to read Council observations: {String(error)}</p>}
    {data?.missions.length === 0 && <p>No L03 mission is bound in this company. Prepare a mission with its owner, criteria, selected advisors and limits before requesting a direction.</p>}
    {data?.missions.map(m => <L03MissionPanel key={m.governance.missionId} inspection={m} />)}
  </main>;
}
