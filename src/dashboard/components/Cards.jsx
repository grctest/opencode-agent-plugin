import { useState } from "react";
import { createPortal } from "react-dom";
import { cn, tierClass, typeClass, relativeTime } from "../utils.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TierBadge, TypeBadge } from "./Badges.jsx";

marked.setOptions({ breaks: true, gfm: true });

export function renderMarkdown(content) {
  const raw = marked.parse(content, { async: false });
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

export function ContentDialog({ open, onClose, title, className, children }) {
  if (!open) return null;
  return createPortal(
    <div className="loom-dialog-backdrop" onClick={onClose}>
      <div className={cn("loom-dialog", className)} onClick={(e) => e.stopPropagation()}>
        <div className="loom-dialog-header">
          <span className="loom-title-sm">{title}</span>
          <button className="loom-dialog-close" onClick={onClose}>×</button>
        </div>
        <div className="loom-dialog-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}

export function ParticipantCard({ participant, error, contributionsByRound }) {
  const [expanded, setExpanded] = useState(false);
  const preview = participant.persona.slice(0, 200);
  const isLong = participant.persona.length > 200;
  const totalContribs = Object.values(contributionsByRound).reduce((a, b) => a + b, 0);

  const statusIndicator = () => {
    if (error) {
      return <span className="loom-agent-status loom-agent-error" title={`${error.error_type}: ${error.error_message}`} />;
    }
    if (participant.status === "speaking") {
      return <span className="loom-agent-status loom-agent-thinking" />;
    }
    if (participant.status === "passed") {
      return <span className="loom-agent-status loom-agent-passed" />;
    }
    return null;
  };

  return (
    <div className={cn("loom-card", "loom-participant-card", error && "loom-participant-card-error")}>
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <span className="loom-title-sm loom-flex loom-gap-xs loom-items-center">
          {statusIndicator()}
          {participant.name}
        </span>
        <TierBadge tier={participant.tier} />
      </div>
      <p className="loom-text loom-text-muted">
        {expanded || !isLong ? participant.persona : `${preview}...`}
      </p>
      {isLong && (
        <button className="loom-link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {totalContribs > 0 && (
        <div className="loom-participant-contribs">
          <span className="loom-contrib-count">{totalContribs} contribution{totalContribs !== 1 ? "s" : ""}</span>
        </div>
      )}
      {error && (
        <div className="loom-error-detail">
          <span className="loom-error-type">{error.error_type}</span>
          <span className="loom-error-message">{error.error_message}</span>
          <span className="loom-error-attempts">{error.attempts} attempts</span>
        </div>
      )}
      {participant.model_id && (
        <p className="loom-text-xs loom-text-muted loom-mt-xs">
          {participant.provider_id}/{participant.model_id}
        </p>
      )}
    </div>
  );
}

export function ThinkingCard({ participant }) {
  return (
    <div className="loom-card loom-thinking-card">
      <div className="loom-thinking-content">
        <span className="loom-thinking-dots">
          <span /><span /><span />
        </span>
        <span className="loom-text loom-text-muted">
          {participant.name} ({participant.tier}) is thinking...
        </span>
      </div>
    </div>
  );
}

export function ContributionItem({ contribution, participantName, onDialogOpen }) {
  const content = contribution.content ?? "";
  const html = renderMarkdown(content);
  const isLong = content.length > 300;

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", `loom-contrib-type-${contribution.type}`, isLong && "loom-contrib-clickable")}
      onClick={() => isLong && onDialogOpen?.({ contribution, participantName })}
    >
      <div className="loom-mb-sm">
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className={cn("loom-contrib-participant", isLong && "loom-contrib-underline")}>
            {participantName}
          </span>
          <TypeBadge type={contribution.type} />
          <span className="loom-text-xs loom-text-muted">Round {contribution.round}</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(contribution.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{content.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {isLong && (
        <span className="loom-link-btn">Show full output</span>
      )}
    </div>
  );
}

export function InterjectionItem({ interjection, participantName }) {
  return (
    <div className="loom-card loom-card-dashed">
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-title-sm">{participantName}</span>
        <span className="loom-badge loom-badge-interjection">interjection</span>
        <span className="loom-text-xs loom-text-muted">priority {interjection.priority}</span>
        <span className={cn("loom-text-xs", interjection.granted ? "loom-text-granted" : "loom-text-denied")}>
          {interjection.granted ? "granted" : "denied"}
        </span>
        <span className="loom-text-xs loom-text-muted">{relativeTime(interjection.created_at)}</span>
      </div>
      <p className="loom-text loom-text-muted">{interjection.content}</p>
      {interjection.pushback && (
        <p className="loom-text-xs loom-text-muted loom-mt-xs loom-italic">
          pushback: {interjection.pushback}
        </p>
      )}
    </div>
  );
}

export function WarpViewer({ warp }) {
  if (!warp) {
    return (
      <div className="loom-card">
        <h3 className="loom-title-sm loom-mb-sm">Warp (Shared Context)</h3>
        <span className="loom-italic loom-text-muted">No warp context yet</span>
      </div>
    );
  }

  const sections = warp.split(/(?=## )/g).filter(Boolean);

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Warp (Shared Context)</h3>
      <div className="loom-warp-content">
        {sections.map((section, i) => {
          const lines = section.trim().split("\n");
          const heading = lines[0].replace(/^#+\s*/, "");
          const body = lines.slice(1).join("\n").trim();

          return (
            <div key={i} className="loom-warp-section">
              <h4 className="loom-warp-heading">{heading}</h4>
              {body && body !== "(none yet)" && (
                <div className="loom-warp-body">
                  {body.split("\n").map((line, j) => (
                    <p key={j} className={cn("loom-text", line.startsWith("-") ? "loom-warp-bullet" : "loom-text-muted")}>
                      {line.replace(/^-\s*/, "")}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgentPerspective({ participant, meeting }) {
  const warpPreview = meeting?.warp ? meeting.warp.slice(0, 500) : "";

  return (
    <div className="loom-card loom-agent-perspective">
      <div className="loom-agent-perspective-header">
        <span className="loom-agent-perspective-name">{participant.name}</span>
        <TierBadge tier={participant.tier} />
      </div>
      <div className="loom-agent-perspective-body">
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Persona</span>
          <p className="loom-text-xs loom-text-muted">{participant.persona}</p>
        </div>
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Agenda</span>
          <p className="loom-text-xs loom-text-muted">{participant.agenda}</p>
        </div>
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Model</span>
          <p className="loom-text-xs loom-text-muted">{participant.provider_id}/{participant.model_id}</p>
        </div>
        {warpPreview && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Shared Context (Warp)</span>
            <div className="loom-agent-perspective-warp">
              {warpPreview}{meeting.warp.length > 500 ? "..." : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
