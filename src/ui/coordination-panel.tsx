import { Fragment, useId, type CSSProperties } from "react";
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

  const fields = [
    { label: "Submission", value: candidate.submissionId, code: true },
    { label: "Candidate commit", value: candidate.candidateCommit, code: true },
    { label: "Bundle SHA-256", value: candidate.bundleSha256, code: true },
    { label: "Evidence revision", value: candidate.evidenceRevision, code: false },
    { label: "Mandate hash", value: candidate.mandateHash, code: true },
  ];

  return (
    <div>
      <h4 style={{ marginBottom: "0.35rem" }}>{label}</h4>
      <dl style={{ marginTop: 0, overflowWrap: "anywhere" }}>
        {fields.map(field => {
          const value = field.value ?? "Not recorded";
          return (
            <Fragment key={field.label}>
              <dt>{field.label}</dt>
              <dd>{field.code ? <code>{value}</code> : value}</dd>
            </Fragment>
          );
        })}
      </dl>
    </div>
  );
}

function CoordinationHeader({ titleId, status }: {
  titleId: string;
  status: CoordinationPresentation["status"];
}) {
  return (
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
        role={status.tone === "danger" ? "alert" : "status"}
        style={{
          border: "1px solid",
          borderRadius: "999px",
          padding: "0.2rem 0.65rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          ...toneStyles[status.tone],
        }}
      >
        Coordination status: {status.label}
      </span>
    </div>
  );
}

function SourceReferences({ source, missionLink, issueLink }: {
  source: CoordinationPresentation["source"];
  missionLink: CoordinationPanelProps["missionLink"];
  issueLink: CoordinationPanelProps["issueLink"];
}) {
  return (
    <div style={row} aria-label="Coordination source references">
      {source.sourceMissionId ? (
        <a href={missionLink(source.sourceMissionId)}>Open source mission</a>
      ) : (
        <span>Source mission not recorded</span>
      )}
      {source.sourceRootIssueId ? (
        <a href={issueLink(source.sourceRootIssueId)}>Open source root issue</a>
      ) : (
        <span>Source root issue not recorded</span>
      )}
    </div>
  );
}

function DelegationDetails({ delegation }: { delegation: CoordinationPresentation["delegation"] }) {
  return (
    <dl style={{ overflowWrap: "anywhere" }}>
      <dt>Coordination state</dt>
      <dd>{delegation.state ?? "Not recorded"}</dd>
      <dt>Coordinator</dt>
      <dd>{delegation.coordinatorAgentId ?? "Not recorded"}</dd>
      <dt>Priority</dt>
      <dd>{delegation.priority ?? "Not recorded"}</dd>
      <dt>Coordination reason</dt>
      <dd>{delegation.reason ?? "Not recorded"}</dd>
    </dl>
  );
}

function RequiredGates({ boundaries }: { boundaries: CoordinationPresentation["boundaries"] }) {
  const publication = boundaries.publicationRequired;
  return (
    <div aria-label="Coordination safety boundaries">
      <h3>Required gates</h3>
      <ul>
        <li>{boundaries.acceptedResult}</li>
        <li>{boundaries.settledUsage}</li>
        <li>
          Publication required: {publication === null ? "Not recorded" : publication ? "Yes" : "No"}
        </li>
      </ul>
    </div>
  );
}

export function CoordinationPanel({
  presentation,
  missionLink,
  issueLink,
}: CoordinationPanelProps) {
  const titleId = useId();
  const isWaiting = presentation.status.tone === "attention" || presentation.status.tone === "danger";

  return (
    <section style={panel} aria-labelledby={titleId}>
      <CoordinationHeader titleId={titleId} status={presentation.status} />

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

      <SourceReferences source={presentation.source} missionLink={missionLink} issueLink={issueLink} />
      <DelegationDetails delegation={presentation.delegation} />
      <RequiredGates boundaries={presentation.boundaries} />

      <details>
        <summary>Source candidate identities</summary>
        <CandidateIdentity label="Expected accepted candidate" candidate={presentation.source.expectedCandidate} />
        <CandidateIdentity label="Verified accepted candidate" candidate={presentation.source.verifiedCandidate} />
      </details>
    </section>
  );
}
