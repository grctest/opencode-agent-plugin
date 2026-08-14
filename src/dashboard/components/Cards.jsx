import { useState, useRef, useEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { cn, tierClass, typeClass, relativeTime } from "../utils.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { TierBadge, TypeBadge } from "./Badges.jsx";

marked.setOptions({ breaks: true, gfm: true });

const mdCache = new Map();

export function renderMarkdown(content) {
  if (!content) return "";
  const cached = mdCache.get(content);
  if (cached !== undefined) return cached;
  const raw = marked.parse(content, { async: false });
  const sanitized = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  mdCache.set(content, sanitized);
  if (mdCache.size > 200) {
    const firstKey = mdCache.keys().next().value;
    mdCache.delete(firstKey);
  }
  return sanitized;
}

export const ContentDialog = memo(({ open, onClose, title, className, children }) => {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement;
    dialogRef.current?.focus?.();
    const handleKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        const focusables = dialogRef.current?.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables || focusables.length === 0) return;
        const list = Array.from(focusables);
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="loom-dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Dialog"}
        className={cn("loom-dialog", className)}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="loom-dialog-header">
          <span className="loom-title-sm">{title}</span>
          <button className="loom-dialog-close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>
        <div className="loom-dialog-body">{children}</div>
      </div>
    </div>,
    document.body
  );
});

export const ParticipantCard = memo(({ participant, error, contributionsByRound }) => {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => participant.persona.slice(0, 200), [participant.persona]);
  const isLong = participant.persona.length > 200;
  const totalContribs = useMemo(
    () => Object.values(contributionsByRound ?? {}).reduce((a, b) => a + b, 0),
    [contributionsByRound]
  );

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
});

export const ThinkingCard = memo(({ participant }) => (
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
));

export const ContributionItem = memo(({ contribution, participantName, onDialogOpen }) => {
  const content = contribution.content ?? "";
  const html = useMemo(() => renderMarkdown(content), [content]);
  const isLong = content.length > 300;

  const openDialog = () => isLong && onDialogOpen?.({ contribution, participantName });
  const onKeyDown = (e) => {
    if (!isLong) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog();
    }
  };

  return (
    <div
      role={isLong ? "button" : undefined}
      tabIndex={isLong ? 0 : undefined}
      aria-expanded={isLong ? false : undefined}
      className={cn("loom-card", "loom-contribution-card", `loom-contrib-type-${contribution.type}`, isLong && "loom-contrib-clickable")}
      onClick={openDialog}
      onKeyDown={onKeyDown}
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
});

export const InterjectionItem = memo(({ interjection, participantName }) => {
  const resolvedClass = interjection.granted ? "loom-text-granted" : "loom-text-denied";
  const resolvedLabel = interjection.granted ? "granted" : interjection.resolved === "contested" ? "contested" : "denied";

  return (
    <div className="loom-card loom-card-dashed">
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-title-sm">{participantName}</span>
        <span className="loom-badge loom-badge-interjection">interjection</span>
        <span className="loom-text-xs loom-text-muted">priority {interjection.priority}</span>
        <span className={cn("loom-text-xs", resolvedClass)}>
          {resolvedLabel}
        </span>
        {interjection.target_participant_id && (
          <span className="loom-text-xs loom-text-muted">→ {interjection.target_participant_id}</span>
        )}
        <span className="loom-text-xs loom-text-muted">{relativeTime(interjection.created_at)}</span>
      </div>
      <p className="loom-text loom-text-muted">{interjection.content}</p>
      {interjection.pushback && (
        <div className="loom-mt-xs loom-card loom-card-sm loom-card-warning">
          <span className="loom-text-xs loom-text-bold">Pushback:</span>
          <p className="loom-text-xs loom-text-muted">{interjection.pushback}</p>
        </div>
      )}
    </div>
  );
});

export const FabricViewer = memo(({ fabric }) => {
  const sections = useMemo(() => (fabric ? fabric.split(/(?=## )/g).filter(Boolean) : []), [fabric]);

  if (!fabric) {
    return (
      <div className="loom-card">
        <h3 className="loom-title-sm loom-mb-sm">Fabric (Shared Context)</h3>
        <span className="loom-italic loom-text-muted">No fabric context yet</span>
      </div>
    );
  }

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Fabric (Shared Context)</h3>
      <div className="loom-fabric-content">
        {sections.map((section, i) => {
          const lines = section.trim().split("\n");
          const heading = lines[0].replace(/^#+\s*/, "");
          const body = lines.slice(1).join("\n").trim();

          return (
            <div key={i} className="loom-fabric-section">
              <h4 className="loom-fabric-heading">{heading}</h4>
              {body && body !== "(none yet)" && (
                <div className="loom-fabric-body">
                  {body.split("\n").map((line, j) => (
                    <p key={j} className={cn("loom-text", line.startsWith("-") ? "loom-fabric-bullet" : "loom-text-muted")}>
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
});

export const AgentPerspective = memo(({ participant, meeting }) => {
  const fabricPreview = useMemo(
    () => (meeting?.fabric ? meeting.fabric.slice(0, 500) : ""),
    [meeting?.fabric]
  );

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
        {fabricPreview && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Shared Context (Fabric)</span>
            <div className="loom-agent-perspective-fabric">
              {fabricPreview}{fabricPreview.length > 500 ? "..." : ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
