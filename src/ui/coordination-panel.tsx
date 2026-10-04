import { useId, type CSSProperties } from "react";
import type {
  CoordinationCandidateIdentity,
  CoordinationPresentation,
} from "../coordination-presentation.js";

export type CoordinationPanelProps = {
  presentation: CoordinationPresentation;
  missionLink(missionId: string): string;
  issueLink(issueId: string): string;
};

const panel: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "0.75rem",
  padding: "1rem",
  background: "var(--card, transparent)",
};

const row: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.6rem",
  alignItems: "center",
};

const toneStyles: Record<CoordinationPresentation["status"]["tone"], CSSProperties> = {
  neutral: { borderColor: "var(--border)", color: "inherit" },
  attention: { borderColor: "#a16207", color: "#a16207" },
  danger: {
    borderColor: "var(--destructive, #dc2626)",
    color: "var(--destructive, #dc2626)",
  },
  success: { borderColor: "#15803d", color: "#15803d" },
};

function hasCandidateIdentity(candidate: CoordinationCandidateIdentity): boolean {
  return Object.values(candidate).some(value => value !== null);
}

function CandidateIdentity({
  candidate,
  label,
}: {
  candidate: CoordinationCandidateIdentity;
  label: string;
}) {
  if (!hasCandidateIdentity(candidate)) return <p>{label}: not recorded</p>;

  return (
    <div>
      <h4 style={{ marginBottom: "0.35rem" }}>{label}</h4>
      <dl style={{ marginTop: 0, overflowWrap: "anywhere" }}>
        <dt>Submission</dt>
        <dd><code>{candidate.submissionId ?? "Not recorded"}</code></dd>
        <dt>Candidate commit</dt>
        <dd><code>{candidate.candidateCommit ?? "Not recorded"}</code></dd>
        <dt>Bundle SHA-256</dt>
        <dd><code>{candidate.bundleSha256 ?? "Not recorded"}</code></dd>
        <dt>Evidence revision</dt>
        <dd>{candidate.evidenceRevision ?? "Not recorded"}</dd>
        <dt>Mandate hash</dt>
        <dd><code>{candidate.mandateHash ?? "Not recorded"}</code></dd>
      </dl>
    </div>
  );
}

export function CoordinationPanel({
  presentation,
  missionLink,
  issueLink,
}: CoordinationPanelProps) {
  const titleId = useId();
  const announcementRole = presentation.status.tone === "danger" ? "alert" : "status";
  const publication = presentation.boundaries.publicationRequired;
  const isWaiting = presentation.status.tone === "attention" || presentation.status.tone === "danger";

  return (
    <section style={panel} aria-labelledby={titleId}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <div>
          <h2 id={titleId} style={{ marginTop: 0, marginBottom: "0.25rem" }}>
            Coordination
          </h2>
          <p style={{ marginTop: 0 }}>
            Authoritative predecessor handoff and downstream coordination state.
          </p>
        </div>
        <span
          role={announcementRole}
          style={{
            border: "1px solid",
            borderRadius: "999px",
            padding: "0.2rem 0.65rem",
            fontSize: "0.85rem",
            fontWeight: 600,
            ...toneStyles[presentation.status.tone],
          }}
        >
          Coordination status: {presentation.status.label}
        </span>
      </div>

      {presentation.waitingReason && (
        <p>
          <strong>{isWaiting ? "Waiting" : "Coordination reason"}:</strong> {presentation.waitingReason}
        </p>
      )}

      <p>
        <strong>Next action:</strong> {presentation.nextAction.label}
        {presentation.nextAction.actorId && (
          <> <span>— actor {presentation.nextAction.actorId}</span></>
        )}
      </p>

      <div style={row} aria-label="Coordination source references">
        {presentation.source.sourceMissionId ? (
          <a href={missionLink(presentation.source.sourceMissionId)}>Open source mission</a>
        ) : (
          <span>Source mission not recorded</span>
        )}
        {presentation.source.sourceRootIssueId ? (
          <a href={issueLink(presentation.source.sourceRootIssueId)}>Open source root issue</a>
        ) : (
          <span>Source root issue not recorded</span>
        )}
      </div>

      <dl style={{ overflowWrap: "anywhere" }}>
        <dt>Coordination state</dt>
        <dd>{presentation.delegation.state ?? "Not recorded"}</dd>
        <dt>Coordinator</dt>
        <dd>{presentation.delegation.coordinatorAgentId ?? "Not recorded"}</dd>
        <dt>Priority</dt>
        <dd>{presentation.delegation.priority ?? "Not recorded"}</dd>
        <dt>Coordination reason</dt>
        <dd>{presentation.delegation.reason ?? "Not recorded"}</dd>
      </dl>

      <div aria-label="Coordination safety boundaries">
        <h3>Required gates</h3>
        <ul>
          <li>{presentation.boundaries.acceptedResult}</li>
          <li>{presentation.boundaries.settledUsage}</li>
          <li>
            Publication required: {publication === null ? "Not recorded" : publication ? "Yes" : "No"}
          </li>
        </ul>
      </div>

      <details>
        <summary>Source candidate identities</summary>
        <CandidateIdentity label="Expected accepted candidate" candidate={presentation.source.expectedCandidate} />
        <CandidateIdentity label="Verified accepted candidate" candidate={presentation.source.verifiedCandidate} />
      </details>
    </section>
  );
}
