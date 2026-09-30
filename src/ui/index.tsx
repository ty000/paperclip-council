import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
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

export function CouncilRostersPage({ context }: PluginPageProps) {
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

  const authorized = Boolean(context.userId && data?.ownerUserId && context.userId === data.ownerUserId);
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
          <Status value="mission activation unavailable" />
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
