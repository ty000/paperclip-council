import { useState, type CSSProperties } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { DecisionReceipt } from "../decision-receipts.js";

const panel: CSSProperties = { border: "1px solid var(--border)", borderRadius: "0.75rem", padding: "1rem", overflowWrap: "anywhere" };
const control: CSSProperties = { color: "inherit", background: "var(--background)", border: "1px solid var(--border)", borderRadius: "0.4rem", padding: "0.5rem" };
type Data = { receipts: DecisionReceipt[]; ownerUserId: string | null };

function Receipt({ receipt, authorized, refresh }: { receipt: DecisionReceipt; authorized: boolean; refresh(): void }) {
  const humanAction = usePluginAction("council-decision-human");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function record(action: "acknowledge" | "abandon") {
    setBusy(true); setError(null); setNotice(null);
    try {
      await humanAction({ operationId: receipt.operationId, action, note });
      setNotice("Human decision recorded. Native observation and any uncertainty hold are unchanged.");
      setNote(""); refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }
  const unknown = receipt.state === "indeterminate";
  return <article style={panel} aria-label={`Decision ${receipt.operationId}`}>
    <h3 style={{ marginTop: 0 }}>{receipt.verdict === "approved" ? "Approval requested" : "Changes requested"}</h3>
    <dl>
      <dt>Issue</dt><dd>{receipt.issueId}</dd>
      <dt>Operation</dt><dd>{receipt.operationId}</dd>
      <dt>Application observation</dt><dd>{unknown ? "Indeterminate — dependent Council actions blocked" : "Native response observed"}</dd>
      <dt>Claimed attempt</dt><dd>{receipt.claimedAt} · agent {receipt.actorAgentId} · run {receipt.runId}</dd>
      <dt>Later execution</dt><dd>Not established by this receipt.</dd>
    </dl>
    {receipt.blockReason && <p><strong>Block reason:</strong> {receipt.blockReason}</p>}
    {receipt.nativeObservation ? <details><summary>Native response: HTTP {receipt.nativeObservation.status} · {receipt.nativeObservation.observedAt}</summary>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(receipt.nativeObservation.body, null, 2)}</pre>
    </details> : <p>No usable native response has been recorded. The request may have reached Paperclip.</p>}
    {unknown && <p>The configured company owner should inspect the available evidence and record acknowledgement or abandonment. Neither action proves native success, releases this hold, or permits another equivalent attempt. Safe resumption requires a separately qualified contract.</p>}
    {receipt.humanDecisions.length > 0 && <div><h4>Human decisions</h4><ol>{receipt.humanDecisions.map((decision, index) => <li key={`${decision.at}-${index}`}>
      {decision.action} · {decision.userId} · {decision.at}{decision.note ? ` — ${decision.note}` : ""}
    </li>)}</ol></div>}
    {unknown && <div style={{ display: "grid", gap: "0.6rem", marginTop: "1rem" }}>
      <label>Owner note<input aria-label={`Owner note for ${receipt.operationId}`} style={{ ...control, display: "block", width: "100%", boxSizing: "border-box" }} value={note} maxLength={1000} disabled={!authorized || busy} onChange={(event) => setNote(event.currentTarget.value)} /></label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
        <button style={control} disabled={!authorized || busy} onClick={() => void record("acknowledge")}>Acknowledge uncertainty</button>
        <button style={control} disabled={!authorized || busy} onClick={() => void record("abandon")}>Record abandonment</button>
      </div>
      {!authorized && <p>Only the configured company owner can record these actions.</p>}
    </div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </article>;
}

export function CouncilDecisionReceipts() {
  const host = useHostContext();
  const { data, loading, error, refresh } = usePluginData<Data>("council-decisions", {});
  return <section aria-labelledby="decision-receipts-title" style={{ display: "grid", gap: "1rem", maxWidth: "74rem", margin: "0 auto", padding: "1rem" }}>
    <div><h2 id="decision-receipts-title">Council decision receipts</h2><p>Inspect Council attempts and native observations. Human decisions are recorded separately.</p><button style={control} onClick={() => refresh()}>Refresh receipts</button></div>
    {loading && <p role="status">Loading decision receipts…</p>}
    {error && <p role="alert">Decision receipts could not load: {error.message}</p>}
    {!loading && !error && !data && <p role="alert">No receipt data returned.</p>}
    {!loading && !error && data?.receipts.length === 0 && <p>No Council decision attempts recorded.</p>}
    {data?.receipts.map((receipt) => <Receipt key={`${receipt.companyId}-${receipt.operationId}`} receipt={receipt} authorized={Boolean(host.userId && host.userId === data.ownerUserId)} refresh={refresh} />)}
  </section>;
}
