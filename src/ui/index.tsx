import type { inspectN3 } from "../n3-state.js";
import { CouncilDecisionReceipts } from "./decision-receipts.js";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

type AgentRecord = { id: string; name: string; status: string };
type ProjectRecord = { id: string; name: string; archivedAt?: string | null };
type Member = { agentId: string; responsibilities: string[] };
type Revision = {
  rosterId: string;
  revision: string;
  kind: "team" | "council";
  name: string;
  projectId: string | null;
  content: {
    members: Member[];
    integrationLeadAgentId: string | null;
    finalReviewerAgentId: string | null;
    requiredPerspectives: string[];
  };
  createdByUserId: string;
  createdAt: string;
};
type Snapshot = {
  head: {
    rosterId: string;
    publishedRevision: string;
    lifecycle: "draft" | "active" | "suspended" | "retired";
    version: number;
    updatedAt: string;
  };
  revision: Revision;
};
type RosterData = {
  rosters: Snapshot[];
  selected: Snapshot | null;
  history: Revision[];
  agents: AgentRecord[];
  projects: ProjectRecord[];
  ownerUserId: string | null;
  missionActivation: "unavailable";
};
type ValidationResult = {
  eligible: boolean;
  errors: Array<{ code: string; message: string; rosterId?: string; agentId?: string }>;
  prerequisites: Array<{ code: string; status: "ready" | "pending" | "unsupported"; message: string }>;
};

type MissionInspection = {
  mission: {
    missionId: string;
    rootIssueId: string;
    version: number;
    aggregate: {
      phase: string;
      control: { status: string; reason?: string };
      mandate: { objective: string };
      compositions: { team: { name: string; revision: string }; council: { name: string; revision: string } };
      responsibilities: { integrationLeadAgentId: string; finalReviewerAgentId: string };
    };
  };
  nextAction: string;
  n1: null | {
    participants: Array<{
      contributionId: string; title: string; assigneeAgentId: string; ownedPaths: string[];
      issueState: string; childIssueId?: string; commit?: string; issueUnknown?: string;
      dispatchState?: string; dispatchRunId?: string | null;
    }>;
    candidate: null | {
      candidate: { attachmentId: string; baseCommit: string; candidateCommit: string; sha256: string };
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    blocker: string | null;
  };
  n3?: ReturnType<typeof inspectN3>;
  n2: null | {
    submission: null | {
      submissionId: string; ordinal: 1 | 2; predecessorSubmissionId: string | null;
      attachmentId: string; byteSize: number; sha256: string; baseCommit: string;
      candidateCommit: string; evidenceRevision: number; mandateHash: string; verifiedAt: string;
    };
    reviewer: { agentId: string; eligible: boolean; independent: boolean; conflictReasons: string[] };
    review: null | {
      round: 1 | 2; submissionId: string; reviewerAgentId: string;
      handoff: {
        state: "awaiting_native" | "confirmed" | "unknown"; reviewerRunId: string | null;
        reason: string | null; observedAt: string | null;
      };
      verdict: null | {
        verdict: "changes_requested" | "approved"; operationId: string; actorAgentId: string;
        runId: string; criteria: string[]; reasons: string[];
        receiptState: "indeterminate" | "native_observed"; nativeStatus: number | null; decidedAt: string;
      };
    };
    status: string;
    correction: null | {
      requestedByOperationId: string; criteria: string[]; reasons: string[];
      executorAgentId: string; runId: string | null;
    };
    application: {
      state: "none" | "observed" | "unknown"; submissionId: string | null;
      operationId: string | null; receiptState: "indeterminate" | "native_observed" | null;
      nativeStatus: number | null;
    };
    blockage: null | { code: string; message: string; nextActorId: string | null };
    nextAction: { actorKind: "agent" | "operator"; actorId: string | null; label: string };
  };
  admission: null | {
    periodKey: string;
    status: string;
    blockers: Array<{ code: string; message: string }>;
    availablePeriodUnits: number | null;
    measurement: { status: string; source?: string; unit?: string; reason?: string };
    reservations: Array<{
      reservationId: string; status: string; requestedUnits: number;
      usage: { status: string; source?: string; units?: number; reason?: string } | null;
      remainingExposure: { status: string; source?: string; units?: number; reason?: string };
    }>;
  };
};

type MissionLookupContext = {
  companyId: string;
  refreshKey: number;
};

const stack: CSSProperties = { display: "grid", gap: "1rem" };
const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  padding: "1rem",
  background: "var(--card, transparent)",
};
const field: CSSProperties = { display: "grid", gap: "0.35rem" };
const input: CSSProperties = {
  width: "100%",
  color: "inherit",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  padding: "0.55rem 0.7rem",
};
const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.6rem", alignItems: "center" };
const button: CSSProperties = {
  color: "inherit",
  background: "var(--background)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  padding: "0.55rem 0.8rem",
  cursor: "pointer",
};
const primaryButton: CSSProperties = {
  ...button,
  color: "var(--primary-foreground, white)",
  background: "var(--primary, #2563eb)",
  borderColor: "var(--primary, #2563eb)",
};
const grid: CSSProperties = {
  display: "grid",
  gap: "1rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))",
};

function message(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

function isCurrentMissionLookup(
  controller: AbortController,
  companyChanged: boolean,
  refreshChanged: boolean,
): boolean {
  return !controller.signal.aborted
    && !companyChanged
    && !refreshChanged;
}

function mergeMissionInspection(
  current: MissionInspection[],
  inspected: MissionInspection,
): MissionInspection[] {
  const inspectedId = inspected.mission.missionId;
  if (!current.some((item) => item.mission.missionId === inspectedId)) return [...current, inspected];
  return current.map((item) => item.mission.missionId === inspectedId ? inspected : item);
}

async function requestMissionInspection(
  lookupContext: MissionLookupContext,
  missionId: string,
  signal: AbortSignal,
): Promise<MissionInspection> {
  const path = "/api/plugins/private.paperclip-council/api/companies/" +
    encodeURIComponent(lookupContext.companyId) + "/missions/" + encodeURIComponent(missionId) +
    "?companyId=" + encodeURIComponent(lookupContext.companyId);
  const response = await fetch(path, { credentials: "same-origin", signal });
  const body = await response.json() as MissionInspection & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Mission lookup failed");
  return body;
}

function Status({ value }: { value: string }) {
  return (
    <span style={{ border: "1px solid var(--border)", borderRadius: "999px", padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}>
      Status: {value}
    </span>
  );
}

function AgentChecklist({
  agents,
  primaryId,
  supporting,
  onPrimary,
  onSupporting,
  primaryLabel,
  supportingLabel,
}: {
  agents: AgentRecord[];
  primaryId: string;
  supporting: Set<string>;
  onPrimary(id: string): void;
  onSupporting(ids: Set<string>): void;
  primaryLabel: string;
  supportingLabel: string;
}) {
  return (
    <div style={stack}>
      <label style={field}>
        <span>{primaryLabel}</span>
        <select style={input} value={primaryId} onChange={(event) => onPrimary(event.currentTarget.value)} required>
          <option value="">Select an eligible agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name} — {agent.status}</option>
          ))}
        </select>
      </label>
      <fieldset style={{ ...card, padding: "0.75rem" }}>
        <legend>{supportingLabel}</legend>
        <div style={{ display: "grid", gap: "0.4rem", marginTop: "0.4rem" }}>
          {agents.map((agent) => (
            <label key={agent.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={supporting.has(agent.id)}
                disabled={agent.id === primaryId}
                onChange={(event) => {
                  const next = new Set(supporting);
                  if (event.currentTarget.checked) next.add(agent.id); else next.delete(agent.id);
                  onSupporting(next);
                }}
              />
              <span>{agent.name} — {agent.status}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function RosterConfiguration({ context }: PluginPageProps) {
  const hostContext = useHostContext();
  const [selectedId, setSelectedId] = useState("");
  const params = useMemo(() => ({ ...(selectedId ? { rosterId: selectedId } : {}) }), [selectedId]);
  const { data, loading, error, refresh } = usePluginData<RosterData>("council-rosters", params);
  const runCommand = usePluginAction("council-roster-command");
  const [kind, setKind] = useState<"team" | "council">("team");
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [primaryId, setPrimaryId] = useState("");
  const [supporting, setSupporting] = useState<Set<string>>(new Set());
  const [teamId, setTeamId] = useState("");
  const [councilId, setCouncilId] = useState("");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const authorized = Boolean(hostContext.userId && data?.ownerUserId && hostContext.userId === data.ownerUserId);
  const selected = data?.selected ?? null;
  const teams = data?.rosters.filter((roster) => roster.revision.kind === "team") ?? [];
  const councils = data?.rosters.filter((roster) => roster.revision.kind === "council") ?? [];

  useEffect(() => {
    if (actionError) alertRef.current?.focus();
  }, [actionError]);

  useEffect(() => {
    if (!selected) return;
    setKind(selected.revision.kind);
    setName(selected.revision.name);
    setProjectId(selected.revision.projectId ?? "");
    const primary = selected.revision.kind === "team"
      ? selected.revision.content.integrationLeadAgentId
      : selected.revision.content.finalReviewerAgentId;
    setPrimaryId(primary ?? "");
    setSupporting(new Set(selected.revision.content.members.map((member) => member.agentId).filter((id) => id !== primary)));
  }, [selected?.head.rosterId, selected?.head.publishedRevision]);

  async function command(payload: Record<string, unknown>, success: string) {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await runCommand(payload);
      setNotice(success);
      refresh();
      return result;
    } catch (nextError) {
      setActionError(message(nextError));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function rosterDraft() {
    const members: Member[] = [
      { agentId: primaryId, responsibilities: [kind === "team" ? "integration_lead" : "final_reviewer"] },
      ...[...supporting].filter((id) => id !== primaryId).map((agentId) => ({
        agentId,
        responsibilities: [kind === "team" ? "contributor" : "specialist_reviewer"],
      })),
    ];
    return {
      kind,
      name,
      projectId: projectId || null,
      members,
      integrationLeadAgentId: kind === "team" ? primaryId : null,
      finalReviewerAgentId: kind === "council" ? primaryId : null,
      requiredPerspectives: [],
    };
  }

  async function saveRoster(event: FormEvent) {
    event.preventDefault();
    if (!primaryId) {
      setActionError("Select the accountable agent before saving.");
      return;
    }
    if (selected) {
      await command({ command: "revise", rosterId: selected.head.rosterId, expectedVersion: selected.head.version, roster: rosterDraft() }, "New immutable revision published as a draft.");
    } else {
      const created = await command({ command: "create", roster: rosterDraft() }, "Draft roster created.") as Snapshot | null;
      if (created?.head.rosterId) setSelectedId(created.head.rosterId);
    }
  }

  async function validatePair() {
    const result = await command({ command: "validate-pair", teamRosterId: teamId, councilRosterId: councilId }, "Roster pair validation completed.") as ValidationResult | null;
    if (result) setValidation(result);
  }

  async function activatePair() {
    const team = teams.find((entry) => entry.head.rosterId === teamId);
    const council = councils.find((entry) => entry.head.rosterId === councilId);
    if (!team || !council) return setActionError("Select both a team and a council.");
    await command({
      command: "activate-pair",
      teamRosterId: teamId,
      teamExpectedVersion: team.head.version,
      councilRosterId: councilId,
      councilExpectedVersion: council.head.version,
    }, "Roster pair activated for future selection. Mission activation remains unavailable.");
  }

  if (!context.companyId) {
    return <div role="alert" style={card}>Select a company to configure Council rosters.</div>;
  }
  if (loading) return <div role="status" aria-live="polite" style={card}>Loading Council roster configuration…</div>;
  if (error) return <div role="alert" style={card}>Council configuration could not load: {error.message}</div>;
  if (!data) return <div role="alert" style={card}>Council configuration returned no data.</div>;

  return (
    <main style={{ ...stack, maxWidth: "76rem", margin: "0 auto", padding: "1rem" }}>
      <header style={stack}>
        <div>
          <h1 style={{ margin: 0 }}>Council rosters</h1>
          <p style={{ marginBottom: 0, color: "var(--muted-foreground)" }}>
            Configure existing Paperclip agents for future governed missions. Roster activation does not start or enable a mission.
          </p>
        </div>
        <div style={row} aria-label="Configuration status">
          <Status value={authorized ? "owner authorized" : "read only"} />
          <Status value="real mission activation unqualified" />
          <Status value="L0 G3/G4 partial" />
        </div>
      </header>

      {!data.ownerUserId && (
        <div role="alert" style={card}>No company default responsible user is configured. Roster mutation is unavailable.</div>
      )}
      {data.ownerUserId && !authorized && (
        <div role="status" style={card}>You can inspect roster history, but only the configured company owner can change it.</div>
      )}
      {actionError && <div ref={alertRef} tabIndex={-1} role="alert" style={{ ...card, borderColor: "var(--destructive, #dc2626)" }}>{actionError}</div>}
      {notice && <div role="status" aria-live="polite" style={card}>{notice}</div>}

      <section style={card} aria-labelledby="existing-rosters-title">
        <div style={{ ...row, justifyContent: "space-between" }}>
          <div>
            <h2 id="existing-rosters-title" style={{ marginTop: 0 }}>Saved configuration</h2>
            <p style={{ marginBottom: 0 }}>{data.rosters.length === 0 ? "No rosters yet. Create the first team or council below." : `${data.rosters.length} roster${data.rosters.length === 1 ? "" : "s"} saved.`}</p>
          </div>
          <button style={button} onClick={() => { setSelectedId(""); setName(""); setPrimaryId(""); setSupporting(new Set()); }}>New roster</button>
        </div>
        {data.rosters.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: "1rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th align="left">Name</th><th align="left">Kind</th><th align="left">Revision</th><th align="left">Lifecycle</th><th>Inspect</th></tr></thead>
              <tbody>
                {data.rosters.map((roster) => (
                  <tr key={roster.head.rosterId}>
                    <td>{roster.revision.name}</td><td>{roster.revision.kind}</td><td>{roster.head.publishedRevision}</td><td><Status value={roster.head.lifecycle} /></td>
                    <td align="center"><button style={button} onClick={() => setSelectedId(roster.head.rosterId)}>Inspect</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div style={grid}>
        <form style={card} onSubmit={saveRoster} aria-labelledby="roster-editor-title">
          <div style={stack}>
            <div>
              <h2 id="roster-editor-title" style={{ marginTop: 0 }}>{selected ? "Revise roster" : "Create roster"}</h2>
              {selected && <p>Editing publishes a new immutable revision and returns the lifecycle to draft.</p>}
            </div>
            <label style={field}><span>Roster kind</span><select style={input} value={kind} disabled={Boolean(selected)} onChange={(event) => setKind(event.currentTarget.value as "team" | "council")}><option value="team">Execution team</option><option value="council">Review council</option></select></label>
            <label style={field}><span>Name</span><input style={input} value={name} maxLength={120} required onChange={(event) => setName(event.currentTarget.value)} /></label>
            <label style={field}><span>Project restriction</span><select style={input} value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}><option value="">Company-wide</option>{data.projects.filter((project) => !project.archivedAt).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
            <AgentChecklist
              agents={data.agents}
              primaryId={primaryId}
              supporting={supporting}
              onPrimary={(id) => { setPrimaryId(id); setSupporting((current) => { const next = new Set(current); next.delete(id); return next; }); }}
              onSupporting={setSupporting}
              primaryLabel={kind === "team" ? "Integration lead" : "Accountable final reviewer"}
              supportingLabel={kind === "team" ? "Contributors" : "Specialist reviewers"}
            />
            <button style={primaryButton} type="submit" disabled={!authorized || busy || !primaryId}>{busy ? "Saving…" : selected ? "Publish revision" : "Create draft"}</button>
          </div>
        </form>

        <section style={card} aria-labelledby="activation-title">
          <div style={stack}>
            <div><h2 id="activation-title" style={{ marginTop: 0 }}>Pair validation and lifecycle</h2><p>Validation checks company/project scope, agent eligibility, responsibilities and execution/review conflicts.</p></div>
            <label style={field}><span>Execution team</span><select style={input} value={teamId} onChange={(event) => setTeamId(event.currentTarget.value)}><option value="">Select team</option>{teams.map((roster) => <option key={roster.head.rosterId} value={roster.head.rosterId}>{roster.revision.name} — v{roster.head.version} — {roster.head.lifecycle}</option>)}</select></label>
            <label style={field}><span>Review council</span><select style={input} value={councilId} onChange={(event) => setCouncilId(event.currentTarget.value)}><option value="">Select council</option>{councils.map((roster) => <option key={roster.head.rosterId} value={roster.head.rosterId}>{roster.revision.name} — v{roster.head.version} — {roster.head.lifecycle}</option>)}</select></label>
            <div style={row}><button style={button} disabled={!authorized || busy || !teamId || !councilId} onClick={() => void validatePair()}>Validate pair</button><button style={primaryButton} disabled={!authorized || busy || !teamId || !councilId || validation?.eligible !== true} onClick={() => void activatePair()}>Activate rosters</button></div>
            {validation && (
              <div role="status" style={stack}>
                <Status value={validation.eligible ? "eligible roster pair" : "not eligible"} />
                {validation.errors.length > 0 && <ul>{validation.errors.map((finding, index) => <li key={`${finding.code}-${index}`}><strong>{finding.code}:</strong> {finding.message}</li>)}</ul>}
                <h3>Mission prerequisites</h3>
                <ul>{validation.prerequisites.map((item) => <li key={item.code}><strong>{item.status} — {item.code}:</strong> {item.message}</li>)}</ul>
              </div>
            )}
          </div>
        </section>
      </div>

      {selected && (
        <section style={card} aria-labelledby="history-title">
          <div style={{ ...row, justifyContent: "space-between" }}>
            <div><h2 id="history-title" style={{ marginTop: 0 }}>Revision history</h2><p>Published revision {selected.head.publishedRevision}; head version {selected.head.version}.</p></div>
            <div style={row}>
              <button style={button} disabled={!authorized || busy || selected.head.lifecycle !== "active"} onClick={() => void command({ command: "suspend", rosterId: selected.head.rosterId, expectedVersion: selected.head.version }, "Roster suspended; historical revisions remain readable.")}>Suspend</button>
              <button style={button} disabled={!authorized || busy || selected.head.lifecycle === "retired"} onClick={() => void command({ command: "retire", rosterId: selected.head.rosterId, expectedVersion: selected.head.version }, "Roster retired; history remains readable and future selection is blocked.")}>Retire</button>
            </div>
          </div>
          <ol>
            {data.history.map((revision) => (
              <li key={revision.revision} style={{ marginBottom: "0.75rem" }}>
                <strong>Revision {revision.revision}: {revision.name}</strong> — {new Date(revision.createdAt).toLocaleString()}<br />
                Responsibilities: {revision.content.members.map((member) => `${data.agents.find((agent) => agent.id === member.agentId)?.name ?? member.agentId} (${member.responsibilities.join(", ")})`).join("; ")}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

export function CouncilRostersPage(props: PluginPageProps) {
  return <><RosterConfiguration {...props} />{props.context.companyId && <CouncilDecisionReceipts />}</>;
}

export function CouncilMissionsPage({ context }: PluginPageProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId;
  const [missions, setMissions] = useState<MissionInspection[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lookupId, setLookupId] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupNotice, setLookupNotice] = useState<string | null>(null);
  const lookupAlertRef = useRef<HTMLParagraphElement>(null);
  const lookupControllerRef = useRef<AbortController | null>(null);
  const lookupContextRef = useRef({ companyId, refreshKey });
  lookupContextRef.current = { companyId, refreshKey };

  useEffect(() => {
    lookupControllerRef.current?.abort();
    lookupControllerRef.current = null;
    setMissions([]);
    setSelectedId(null);
    setLoadedCompanyId(null);
    setLookupId("");
    setLookupLoading(false);
    setLookupError(null);
    setLookupNotice(null);
    if (!companyId) {
      setLoading(false);
      setError("Select a company to inspect Council missions.");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const path = "/api/plugins/private.paperclip-council/api/companies/" +
      encodeURIComponent(companyId) + "/missions?companyId=" + encodeURIComponent(companyId);
    void fetch(path, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { missions?: MissionInspection[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Mission inspection failed");
        return body.missions ?? [];
      })
      .then((items) => {
        setMissions(items);
        setLoadedCompanyId(companyId);
        setSelectedId((current) => current && items.some((item) => item.mission.missionId === current)
          ? current : items[0]?.mission.missionId ?? null);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      lookupControllerRef.current?.abort();
    };
  }, [companyId, refreshKey]);

  useEffect(() => {
    if (lookupError) lookupAlertRef.current?.focus();
  }, [lookupError]);

  async function lookupMission(event: FormEvent) {
    event.preventDefault();
    if (!companyId) return;
    const missionId = lookupId.trim();
    lookupControllerRef.current?.abort();
    const controller = new AbortController();
    lookupControllerRef.current = controller;
    const lookupContext = { companyId, refreshKey };
    function lookupIsCurrent() {
      return isCurrentMissionLookup(
        controller,
        lookupContextRef.current.companyId !== lookupContext.companyId,
        lookupContextRef.current.refreshKey !== lookupContext.refreshKey,
      );
    }
    function reportLookupFailure(cause: unknown) {
      if (lookupIsCurrent()) setLookupError(message(cause));
    }
    function finishLookup() {
      if (lookupControllerRef.current !== controller) return;
      lookupControllerRef.current = null;
      setLookupLoading(false);
    }
    setLookupLoading(true);
    setLookupError(null);
    setLookupNotice(null);
    try {
      const inspected = await requestMissionInspection(lookupContext, missionId, controller.signal);
      if (!lookupIsCurrent()) return;
      setMissions((current) => mergeMissionInspection(current, inspected));
      setSelectedId(inspected.mission.missionId);
      setLookupId(inspected.mission.missionId);
      setLookupNotice("Mission found and selected.");
    } catch (cause: unknown) {
      reportLookupFailure(cause);
    } finally {
      finishLookup();
    }
  }

  function refreshMissions() {
    lookupControllerRef.current?.abort();
    lookupControllerRef.current = null;
    setLookupLoading(false);
    setLookupError(null);
    setLookupNotice(null);
    setRefreshKey((value) => value + 1);
  }

  const selected = !loading && !error && loadedCompanyId === companyId
    ? missions.find((item) => item.mission.missionId === selectedId) ?? null
    : null;
  const issueLink = (issueId: string) => "/" + (context.companyPrefix ? context.companyPrefix + "/" : "") + "issues/" + encodeURIComponent(issueId);
  return (
    <main style={{ ...stack, padding: "1.5rem", maxWidth: "75rem", margin: "0 auto" }}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <div><h1 style={{ marginBottom: "0.25rem" }}>Council missions</h1><p style={{ marginTop: 0 }}>Owner inspection of pinned teams, contributions, admission, review and the integrated candidate.</p></div>
        <button style={button} onClick={refreshMissions} disabled={loading}>Refresh</button>
      </div>
      {loading && <p role="status">Loading missions…</p>}
      {error && <p role="alert" style={card}>{error}</p>}
      {!loading && !error && loadedCompanyId === companyId && (
        <div style={grid}>
          <section style={card} aria-labelledby="mission-picker-title">
            <h2 id="mission-picker-title" style={{ marginTop: 0 }}>Missions</h2>
            <p id="mission-list-scope">The initial list shows up to the latest 50 missions. Find an older mission by its exact UUID; a successful result is added to this selector.</p>
            <form style={stack} onSubmit={(event) => void lookupMission(event)}>
              <label style={field}>
                <span>Mission UUID</span>
                <input
                  style={input}
                  value={lookupId}
                  onChange={(event) => setLookupId(event.currentTarget.value)}
                  aria-describedby="mission-list-scope"
                  autoComplete="off"
                  placeholder="00000000-0000-0000-0000-000000000000"
                  pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                  title="Enter an exact mission UUID"
                  required
                />
              </label>
              <button style={button} type="submit" disabled={lookupLoading || !lookupId.trim()}>
                {lookupLoading ? "Finding mission…" : "Find mission"}
              </button>
            </form>
            {lookupError && <p ref={lookupAlertRef} tabIndex={-1} role="alert" style={{ color: "var(--destructive, #dc2626)" }}>Mission lookup failed: {lookupError}</p>}
            {lookupNotice && <p role="status" aria-live="polite">{lookupNotice}</p>}
            {missions.length === 0 ? <p>No Council missions are recorded in the latest 50 for this company.</p> : (
              <label style={{ ...field, marginTop: "1rem" }}>
                <span>Select mission</span>
                <select style={input} value={selectedId ?? ""} onChange={(event) => setSelectedId(event.currentTarget.value)}>
                  {missions.map((item) => (
                    <option key={item.mission.missionId} value={item.mission.missionId}>
                      {item.mission.aggregate.mandate.objective} — {item.mission.aggregate.phase}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
          {selected && <section style={card} aria-labelledby="mission-state-title">
            <h2 id="mission-state-title" style={{ marginTop: 0 }}>{selected.mission.aggregate.mandate.objective}</h2>
            <p><Status value={selected.mission.aggregate.phase} /> Control: {selected.mission.aggregate.control.status}; version {selected.mission.version}</p>
            <p>Team: {selected.mission.aggregate.compositions.team.name} ({selected.mission.aggregate.compositions.team.revision})</p>
            <p>Council: {selected.mission.aggregate.compositions.council.name} ({selected.mission.aggregate.compositions.council.revision})</p>
            <p>Integration Lead: {selected.mission.aggregate.responsibilities.integrationLeadAgentId}</p>
            <p>Final reviewer: {selected.mission.aggregate.responsibilities.finalReviewerAgentId}</p>
            <p><a href={issueLink(selected.mission.rootIssueId)}>Open root issue</a></p>
            <p><strong>Next actor/action:</strong> {selected.nextAction}</p>
            {selected.n1?.blocker && <p role="status"><strong>Blocker:</strong> {selected.n1.blocker}</p>}
            {selected.n2?.blockage && <p role="alert"><strong>{selected.n2.blockage.code}:</strong> {selected.n2.blockage.message}</p>}
          </section>}
        </div>
      )}
      {selected?.n1 && <section style={card} aria-labelledby="contributions-title">
        <h2 id="contributions-title" style={{ marginTop: 0 }}>Contributions</h2>
        {selected.n1.participants.length === 0 ? <p>Plan pending.</p> : <ol>{selected.n1.participants.map((slot) => (
          <li key={slot.contributionId}>
            <strong>{slot.title}</strong> — {slot.issueState}; assignee {slot.assigneeAgentId}; owns {slot.ownedPaths.join(", ")}
            {slot.childIssueId && <>; <a href={issueLink(slot.childIssueId)}>child issue</a></>}
            {slot.dispatchState && <>; dispatch {slot.dispatchState}{slot.dispatchRunId ? ` (${slot.dispatchRunId})` : ""}</>}
            {slot.commit && <>; commit {slot.commit}</>}
            {slot.issueUnknown && <>; unknown: {slot.issueUnknown}</>}
          </li>
        ))}</ol>}
      </section>}
      {selected?.n1?.candidate && <section style={card} aria-labelledby="candidate-title">
        <h2 id="candidate-title" style={{ marginTop: 0 }}>Integrated candidate</h2>
        <p>Commit: {selected.n1.candidate.candidate.candidateCommit}</p>
        <p>Base: {selected.n1.candidate.candidate.baseCommit}</p>
        <p>Bundle SHA-256: {selected.n1.candidate.candidate.sha256}</p>
        <p><a href={issueLink(selected.mission.rootIssueId) + "#attachment-" + encodeURIComponent(selected.n1.candidate.candidate.attachmentId)}>Open candidate attachment</a></p>
        <ul>{selected.n1.candidate.checks.map((check) => <li key={check.name}>{check.name}: {check.status} — {check.detail}</li>)}</ul>
      </section>}
      {selected?.n3 && <section style={card} aria-label="Specialist opinions">
        <h2>Specialist opinions</h2>
        <p>Submission {selected.n3.review.subject.submissionId} · commit {selected.n3.review.subject.candidateCommit}</p>
        <p>Evidence revision {selected.n3.review.subject.evidenceRevision} · bundle {selected.n3.review.subject.bundleSha256} · mandate {selected.n3.review.subject.mandateHash}</p>
        <p>Missing opinions: {selected.n3.missing.join(", ") || "none"}. Unknown usage: {selected.n3.usageUnknown.join(", ") || "none"}.</p>
        {selected.n3.review.opinions.map(opinion => <article key={opinion.opinionId}>
          <h3>{opinion.perspective}: {opinion.outcome}</h3>
          <p>Agent {opinion.specialistAgentId} · run {opinion.specialistRunId}</p>
          <p>{opinion.rationale}</p>
          {opinion.findings.map(finding => <p key={finding.findingId}>{finding.classification}: {finding.criterionOrRisk} — {finding.consequence}</p>)}
        </article>)}
        {selected.n3.review.synthesis && <article><h3>Final synthesis: {selected.n3.review.synthesis.verdict}</h3>
          <p>{selected.n3.review.synthesis.rationale}</p>
          {selected.n3.review.synthesis.dispositions.map(item => <p key={item.findingId}>{item.findingId}: {item.disposition} — {item.reason}</p>)}
        </article>}
        <p><strong>Next actor:</strong> {selected.n3.nextActor}</p>
      </section>}
      {selected?.n2 && <section style={card} aria-labelledby="n2-review-title">
        <h2 id="n2-review-title" style={{ marginTop: 0 }}>Independent review and correction</h2>
        <div style={grid}>
          <section aria-labelledby="n2-submission-title">
            <h3 id="n2-submission-title">Current submission</h3>
            {!selected.n2.submission ? <p>No active submission is recorded.</p> : <dl style={{ overflowWrap: "anywhere" }}>
              <dt>Version</dt><dd>V{selected.n2.submission.ordinal} / evidence revision {selected.n2.submission.evidenceRevision}</dd>
              <dt>Submission</dt><dd>{selected.n2.submission.submissionId}</dd>
              <dt>Commit</dt><dd>{selected.n2.submission.candidateCommit}</dd>
              <dt>Bundle SHA-256</dt><dd>{selected.n2.submission.sha256}</dd>
              <dt>Mandate SHA-256</dt><dd>{selected.n2.submission.mandateHash}</dd>
              <dt>Predecessor</dt><dd>{selected.n2.submission.predecessorSubmissionId ?? "Initial submission"}</dd>
            </dl>}
          </section>
          <section aria-labelledby="n2-reviewer-title">
            <h3 id="n2-reviewer-title">Review</h3>
            <dl style={{ overflowWrap: "anywhere" }}>
              <dt>State</dt><dd><Status value={selected.n2.status} /></dd>
              <dt>Reviewer</dt><dd>{selected.n2.reviewer.agentId}</dd>
              <dt>Eligibility</dt><dd>{selected.n2.reviewer.eligible && selected.n2.reviewer.independent
                ? "eligible and independent" : `blocked: ${selected.n2.reviewer.conflictReasons.join(", ")}`}</dd>
              <dt>Round</dt><dd>{selected.n2.review?.round ?? "not started"}</dd>
              <dt>Native handoff</dt><dd>{selected.n2.review?.handoff.state ?? "not recorded"}</dd>
              <dt>Reviewer run</dt><dd>{selected.n2.review?.handoff.reviewerRunId ?? "not observed"}</dd>
              <dt>Verdict</dt><dd>{selected.n2.review?.verdict?.verdict ?? "pending"}</dd>
            </dl>
          </section>
          <section aria-labelledby="n2-correction-title">
            <h3 id="n2-correction-title">Correction</h3>
            {!selected.n2.correction ? <p>No correction is pending.</p> : <>
              <p>Executor: {selected.n2.correction.executorAgentId}; run: {selected.n2.correction.runId ?? "not bound"}.</p>
              <h4>Criteria</h4><ul>{selected.n2.correction.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
              <h4>Reasons</h4><ul>{selected.n2.correction.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </>}
          </section>
          <section aria-labelledby="n2-application-title">
            <h3 id="n2-application-title">Native application</h3>
            <dl style={{ overflowWrap: "anywhere" }}>
              <dt>State</dt><dd>{selected.n2.application.state}</dd>
              <dt>Submission</dt><dd>{selected.n2.application.submissionId ?? "none"}</dd>
              <dt>Operation</dt><dd>{selected.n2.application.operationId ?? "none"}</dd>
              <dt>Receipt</dt><dd>{selected.n2.application.receiptState ?? "none"}</dd>
              <dt>Native status</dt><dd>{selected.n2.application.nativeStatus ?? "not observed"}</dd>
            </dl>
            <p><strong>Next:</strong> {selected.n2.nextAction.label}</p>
          </section>
        </div>
      </section>}
      {selected && <section style={card} aria-labelledby="admission-title">
        <h2 id="admission-title" style={{ marginTop: 0 }}>Admission and usage</h2>
        {!selected.admission ? <p>No admission envelope is linked. Launch remains blocked.</p> : <>
          <p>Period {selected.admission.periodKey}; status {selected.admission.status}; available units {selected.admission.availablePeriodUnits ?? "unknown"}.</p>
          <p>Measurement: {selected.admission.measurement.status === "known"
            ? `${selected.admission.measurement.unit} from ${selected.admission.measurement.source}`
            : selected.admission.measurement.reason ?? "unknown"}.</p>
          {selected.admission.blockers.length > 0 && <ul>{selected.admission.blockers.map((blocker) => <li key={blocker.code}>{blocker.code}: {blocker.message}</li>)}</ul>}
          <ul>{selected.admission.reservations.map((reservation) => (
            <li key={reservation.reservationId}>
              {reservation.reservationId}: {reservation.status}; reserved {reservation.requestedUnits}; usage {reservation.usage?.status === "known"
                ? `${reservation.usage.units} (${reservation.usage.source})`
                : reservation.usage?.reason ?? "unsettled/unknown"}; remaining exposure {reservation.remainingExposure.status === "known"
                ? `${reservation.remainingExposure.units} (${reservation.remainingExposure.source})`
                : reservation.remainingExposure.reason ?? "unknown"}
            </li>
          ))}</ul>
        </>}
      </section>}
    </main>
  );
}
