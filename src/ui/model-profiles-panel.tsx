import { useEffect, useState, type CSSProperties } from "react";
import type { ModelCatalogue, ProfileId } from "../model-catalogue.js";
import type { ModelSelectionState } from "../model-state.js";
import type { VariantInspection } from "../model-variants.js";
import type { ModelEstimate } from "../model-estimates.js";

type Catalogue = {
  mapping: ModelCatalogue;
  profiles: Record<ProfileId, { id: string; model: string; effort: string }>;
  enabledForNewMissions: boolean; availability: string; estimate: string;
  estimates?: ModelEstimate[];
  roles?: Array<{ key: string; title: string; revision: string }>;
  variants?: VariantInspection[];
};
type Inspection = {
  state: ModelSelectionState | null;
  statuses: Array<VariantInspection & { launchKey: string }>;
  measurements: Array<{ taskKey: string; runCount: number; inputTokens: number | null; outputTokens: number | null; durationMs: number | null }>;
  estimates?: ModelEstimate[];
};
const families = [
  ["synthesis", "Synthesis / extraction"], ["implementation", "Implementation"], ["diagnosis", "Diagnosis / correction"],
  ["review", "Review"], ["validation", "Test / validation"], ["design", "Design / arbitration"], ["orchestration", "Orchestration / supervision"],
] as const;
const card: CSSProperties = { border: "1px solid var(--border, #cbd5e1)", borderRadius: "0.75rem", padding: "1rem", minWidth: 0, overflowWrap: "anywhere" };
const cell: CSSProperties = { padding: "0.6rem", textAlign: "left", verticalAlign: "top", borderBottom: "1px solid var(--border, #cbd5e1)" };
const grid: CSSProperties = { display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 22rem), 1fr))" };

function useRead<T>(path: string | null, revision: number) {
  const identity = `${path ?? ""}:${revision}`;
  const [result, setResult] = useState<{ identity: string; data: T | null; loading: boolean; error: string | null }>({ identity: "", data: null, loading: false, error: null });
  useEffect(() => {
    const controller = new AbortController();
    setResult({ identity, data: null, loading: Boolean(path), error: null });
    if (path) void fetch(path, { credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Profile inspection failed (${response.status}).`);
        return await response.json() as T;
      })
      .then(data => { if (!controller.signal.aborted) setResult({ identity, data, loading: false, error: null }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ identity, data: null, loading: false, error: "Profile inspection is unavailable. Refresh to try again." }); });
    return () => controller.abort();
  }, [identity, path]);
  // Hide a previous company's/mission's response before the next effect runs.
  return result.identity === identity ? result : { data: null, loading: Boolean(path), error: null };
}
function tokens(value: number | null | undefined) { return value == null ? "Unavailable" : value.toLocaleString("en-US"); }
function duration(value: number | null | undefined) { return value == null ? "Unavailable" : `${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })} s`; }
function estimate(value: ModelEstimate | undefined) {
  return !value?.sampleCount ? "Not calibrated" : `${value.sampleCount} comparable successful runs · input ${tokens(value.inputTokens)} tokens · output ${tokens(value.outputTokens)} tokens · duration ${duration(value.durationMs)}`;
}
function VariantInventory({ variants, roles, profile }: { variants: Catalogue["variants"]; roles: Catalogue["roles"]; profile: (id: string) => string }) {
  const roleKeys = [...new Set(variants?.map(variant => variant.roleKey ?? "unresolved") ?? [])].sort();
  return <details style={{ marginTop: "1rem" }}>
    <summary>Preconfigured variants{variants ? ` (${variants.length})` : ""}</summary>
    <p>Configuration readback by role, profile and revision, independently of mission launches.</p>
    {variants === undefined ? <p>Variant inventory is unavailable.</p> : variants.length === 0 ? <p>No declared variants were returned.</p> : roleKeys.map(roleKey => (
      <section key={roleKey} aria-label={`Variants for ${roleKey}`} style={{ marginTop: "1rem" }}>
        <h3>{roles?.find(role => role.key === roleKey)?.title ?? roleKey}</h3>
        <div style={grid}>{variants.filter(variant => (variant.roleKey ?? "unresolved") === roleKey)
          .sort((a, b) => a.profileId.localeCompare(b.profileId) || a.revision.localeCompare(b.revision))
          .map(variant => <article key={`${variant.profileId}-${variant.revision}`} style={card} aria-label={`Variant ${roleKey} ${variant.profileId} revision ${variant.revision}`}>
            <h4 style={{ marginTop: 0 }}>{profile(variant.profileId)} · revision {variant.revision}</h4>
            <p>Configuration: {variant.ready ? "matches expected settings" : "blocked or unavailable"}.</p>
            <p>Logical agent: <code>{variant.logicalAgentId ?? "Unknown"}</code><br />Physical variant: <code>{variant.agentId ?? "Not prepared or unreadable"}</code></p>
            {!!variant.gaps.length && <ul aria-label="Variant configuration gaps">{variant.gaps.map((gap, i) => <li key={`${i}-${gap}`}>{gap}</li>)}</ul>}
            <details><summary>Expected and observed variant settings</summary>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "0.85em" }}>{JSON.stringify({ expected: variant.expected, observed: variant.observed }, null, 2)}</pre>
            </details>
          </article>)}</div>
      </section>
    ))}
  </details>;
}

export function ModelProfilesPanel({ companyId, missionId, refreshKey = 0, issueHref = id => `/issues/${encodeURIComponent(id)}` }: {
  companyId?: string | null; missionId?: string | null; refreshKey?: number; issueHref?: (id: string) => string;
}) {
  const base = companyId ? `/api/plugins/private.paperclip-council/api/companies/${encodeURIComponent(companyId)}` : null;
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const catalogue = useRead<Catalogue>(base ? `${base}/model-profiles${query}` : null, refreshKey);
  const inspection = useRead<Inspection>(base && missionId ? `${base}/missions/${encodeURIComponent(missionId)}/model-profiles${query}` : null, refreshKey);
  const mapping = catalogue.data?.mapping;
  const profile = (id: string) => {
    const value = catalogue.data?.profiles?.[id as ProfileId];
    return value ? `${value.model} · ${value.effort}` : id;
  };
  const unavailable = catalogue.loading ? "Loading…" : "Unavailable";
  return <section style={card} aria-labelledby="model-profiles-title">
    <h2 id="model-profiles-title" style={{ marginTop: 0 }}>Model profiles</h2>
    {!companyId && <p role="status">Select a company to inspect model profiles.</p>}
    {catalogue.loading && <p role="status">Loading model catalogue…</p>}
    {catalogue.error && <p role="alert">{catalogue.error}</p>}
    {catalogue.data && <p>New standard missions: {catalogue.data.enabledForNewMissions ? "variants enabled" : "variants disabled"}.
      {" "}Catalogue revision {mapping?.revision}.</p>}
    {catalogue.data && <p>Indicative averages cover successful comparable runs in the latest 50 company missions, grouped by role, family, profile and revisions. Missing measurements remain unavailable.</p>}
    <div style={{ overflowX: "auto" }} tabIndex={0} role="region" aria-label="Task family profile table">
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "36rem", overflowWrap: "normal" }}>
        <caption style={{ textAlign: "left", paddingBottom: "0.5rem" }}>Seven task families · indicative token and duration budgets</caption>
        <thead><tr>{["Task family", "Default model / effort", "Allowed model / effort", "Estimate"].map(label => <th key={label} scope="col" style={cell}>{label}</th>)}</tr></thead>
        <tbody>{families.map(([id, label]) => {
          const family = mapping?.families?.find(row => row.id === id);
          return <tr key={id}><th scope="row" style={cell}>{label}</th>
            <td style={cell}>{family ? profile(family.defaultProfile) : unavailable}</td>
            <td style={cell}>{family ? family.allowedProfiles.map(p => <div key={p}>{profile(p)}</div>) : unavailable}</td>
            <td style={cell}>{family ? family.allowedProfiles.map(profileId => {
              const estimates = catalogue.data?.estimates?.filter(row => row.family === id && row.profileId === profileId && row.mappingRevision === mapping?.revision
                && row.variantRevision === (mapping?.variantRevision ?? catalogue.data?.roles?.find(role => role.key === row.roleKey)?.revision)) ?? [];
              return <div key={profileId} style={{ marginBottom: "0.6rem" }}><strong>{profileId}</strong>
                {estimates.length ? <ul style={{ margin: "0.25rem 0", paddingLeft: "1.2rem" }}>{estimates.map(row => <li key={row.roleKey}>
                  {catalogue.data?.roles?.find(role => role.key === row.roleKey)?.title ?? row.roleKey}: {estimate(row)}
                </li>)}</ul> : <div>Not calibrated</div>}
              </div>;
            }) : unavailable}</td></tr>;
        })}</tbody>
      </table>
    </div>
    {catalogue.data?.availability === "not_validated_live" && <p>Model availability on the instance has not been verified.</p>}
    {catalogue.data && <VariantInventory variants={catalogue.data.variants} roles={catalogue.data.roles} profile={profile} />}
    {!missionId ? <p>Select a mission to inspect its selected variants.</p>
      : inspection.loading ? <p role="status">Loading mission profiles…</p>
        : inspection.error ? <p role="alert">{inspection.error}</p>
          : inspection.data?.state == null ? <p>This mission has no variant bindings. Historical missions retain their original agents.</p>
            : <>
              {inspection.data.state.tasks.length === 0 && <p>No intervention has selected a physical variant yet.</p>}
              {inspection.data.state.tasks.map(task => {
                const measured = inspection.data?.measurements.find(row => row.taskKey === task.taskKey);
                return <section key={task.taskKey} style={{ ...card, marginTop: "1rem" }} aria-label={`Profiles for task ${task.taskKey}`}>
                  <h3 style={{ marginTop: 0 }}>Task {task.taskKey}</h3>
                  <p>Pinned mapping {task.mapping.revision} · variant revision {task.variantRevision} · ascent {task.ascentLaunchKey ? "used" : "available (one per task)"}</p>
                  <p>Observed usage ({measured?.runCount ?? 0} runs): input {tokens(measured?.inputTokens)} tokens · output {tokens(measured?.outputTokens)} tokens · duration {duration(measured?.durationMs)}.</p>
                  <div style={grid}>{task.launches.map(launch => {
                    const status = inspection.data?.statuses.find(row => row.launchKey === launch.launchKey);
                    const predicted = (inspection.data?.estimates ?? catalogue.data?.estimates)?.find(row => row.roleKey === launch.roleKey
                      && row.family === launch.family && row.profileId === launch.profileId && row.mappingRevision === launch.mappingRevision
                      && row.variantRevision === launch.variantRevision);
                    return <article key={launch.launchKey} style={card} aria-label={`Intervention ${launch.interventionKey}`}>
                      <h4 style={{ marginTop: 0 }}>{launch.interventionKey} · {profile(launch.profileId)}</h4>
                      <p>Role: {launch.roleKey}. State: {launch.state}.</p>
                      <p><strong>Indicative estimate:</strong> {estimate(predicted)}</p>
                      <p><strong>Choice:</strong> {launch.rationale} ({launch.authority})</p>
                      <p>Logical agent: <code>{launch.logicalAgentId}</code><br />Physical variant: <code>{launch.agentId}</code></p>
                      <p>Launch: <code>{launch.launchKey}</code><br />Run: <code>{launch.runId ?? "Not bound"}</code></p>
                      <p>Mapping {launch.mappingRevision} · variant revision {launch.variantRevision} · {launch.ascent ? "ascent attempt" : "initial profile"}</p>
                      {launch.fallback && <p><strong>Availability fallback:</strong> {profile(launch.fallback.from)} → {profile(launch.profileId)}. {launch.fallback.reason}</p>}
                      {launch.history && <p>History: {launch.history.gapCount} gaps · cutoff {launch.history.cutoff}<br />Index: <code>{launch.history.indexKey}</code>
                        {launch.issueId && <> · <a href={issueHref(launch.issueId)}>Open history issue</a></>}</p>}
                      <p>Configuration: {status ? status.ready ? "matches expected settings" : "blocked or unavailable" : "not inspected"}.</p>
                      {!!status?.gaps.length && <ul aria-label="Configuration gaps">{status.gaps.map((gap, i) => <li key={`${i}-${gap}`}>{gap}</li>)}</ul>}
                      {status && <details><summary>Expected and observed configuration</summary>
                        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: "0.85em" }}>{JSON.stringify({ expected: status.expected, observed: status.observed }, null, 2)}</pre>
                      </details>}
                    </article>;
                  })}</div>
                </section>;
              })}
              {!!inspection.data.state.choices.length && <details style={{ marginTop: "1rem" }}><summary>Requested profile choices</summary>
                <ul>{inspection.data.state.choices.map(choice => <li key={`${choice.taskKey}-${choice.interventionKey}`}>
                  {choice.taskKey} / {choice.interventionKey}: {profile(choice.profileId)} — {choice.rationale} ({choice.authority})
                </li>)}</ul>
              </details>}
            </>}
  </section>;
}
