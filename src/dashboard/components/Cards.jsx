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

export const ParticipantCard = memo(({ participant, error, contributionsByRound, isReflecting, onSelect }) => {
  const personaTitle = participant.name;

  const statusIndicator = () => {
    if (error) {
      return <span className="loom-agent-status loom-agent-error" title={`${error.error_type}: ${error.error_message}`} />;
    }
    if (participant.status === "speaking" || isReflecting) {
      return <span className="loom-agent-status loom-agent-thinking" />;
    }
    if (participant.status === "passed") {
      return <span className="loom-agent-status loom-agent-passed" />;
    }
    return null;
  };

  return (
    <div
      className={cn("loom-card", "loom-participant-card", error && "loom-participant-card-error")}
      onClick={() => onSelect?.(participant)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(participant); } }}
    >
      <div className="loom-participant-card-header">
        {statusIndicator()}
        <span className="loom-participant-card-title">{personaTitle}</span>
        <TierBadge tier={participant.tier} />
      </div>
      {participant.model_id && (
        <span className="loom-participant-model">{participant.model_id}</span>
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

  const openDialog = () => onDialogOpen?.({ contribution, participantName });
  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog();
    }
  };

  const loomCalls = useMemo(() => {
    const tcs = contribution.tool_calls ?? [];
    return tcs.filter(tc => (tc.tool ?? tc.attempted_tool ?? "").startsWith("loom_"));
  }, [contribution.tool_calls]);

  const formatLoomInput = (tc) => {
    try {
      const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
      if (tc.tool === "loom_query" || tc.tool === "loom_evidence") {
        const t = Array.isArray(input.targets) ? input.targets.join(", ") : "";
        const q = input.question ?? "";
        return `${t}: ${q.slice(0,80)}`;
      }
      if (tc.tool === "loom_vote") return (input.question ?? "").slice(0,80);
      if (tc.tool === "loom_summon") return `${input.persona_name ?? input.personaName ?? ""}: ${(input.issue ?? "").slice(0,60)}`;
      if (tc.tool === "loom_request_next") return `P${input.priority} ${input.reason ?? ""}`.slice(0,80);
      if (input && typeof input === "object") return JSON.stringify(input).slice(0,80);
      return String(input).slice(0,80);
    } catch { return tc.input ? String(tc.input).slice(0,80) : ""; }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={false}
      className={cn("loom-card", "loom-contribution-card", `loom-contrib-type-${contribution.type}`, "loom-contrib-clickable")}
      onClick={openDialog}
      onKeyDown={onKeyDown}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-contrib-participant">
            {participantName}
          </span>
          <TypeBadge type={contribution.type} />
          <span className="loom-text-xs loom-text-muted">Round {contribution.round}</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(contribution.created_at)}</span>
          <button
            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`**[${participantName}]** (${contribution.type}): ${content}`); }}
            className="loom-copy-btn"
            style={{ marginLeft: "auto", fontSize: "0.75rem", padding: "2px 6px", border: "1px solid #ccc", borderRadius: "4px", background: "transparent", cursor: "pointer" }}
            aria-label="Copy markdown"
          >
            Copy
          </button>
        </div>
        {loomCalls.length > 0 && (
          <div className="loom-flex loom-flex-wrap loom-gap-xs loom-mt-xs">
            {loomCalls.map((tc, i) => {
              const isError = !!tc.error || tc.status === "error";
              return (
                <span key={tc.callID ?? i} className={cn("loom-badge loom-badge-orchestrator", isError && "loom-badge-aborted")} title={`${tc.tool}: ${formatLoomInput(tc)}${tc.error ? ` — ${tc.error}` : ""}`}>
                  {tc.tool.replace("loom_", "")}: {formatLoomInput(tc)}
                </span>
              );
            })}
          </div>
        )}
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{content.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const TurnRequestItem = memo(({ turnRequest, participantName }) => {
  return (
    <div className="loom-card loom-card-dashed">
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-title-sm">{participantName}</span>
        <span className="loom-badge loom-badge-turn-request">turn request</span>
        <span className="loom-text-xs loom-text-muted">priority {turnRequest.priority}</span>
        {turnRequest.target && (
          <span className="loom-text-xs loom-text-muted">→ {turnRequest.target}</span>
        )}
      </div>
      <p className="loom-text loom-text-muted">{turnRequest.reason}</p>
    </div>
  );
});

export const ReflectionInline = memo(({ reflection, contributions, participantName }) => {
  const trigger = useMemo(() => {
    if (!reflection.targets_which) return null;
    return contributions.find((c) => c.id === reflection.targets_which);
  }, [reflection.targets_which, contributions]);

  const triggerType = trigger?.type?.toUpperCase() ?? "CONTRIBUTION";
  const triggerAgentName = trigger ? participantName(trigger.participant_id) : "another agent";

  const content = reflection.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Reflection on #\d+ \[[\w]+\] by .+?\]\s*/m, "");
  }, [content]);
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  return (
    <div className="loom-reflection-inline">
      <span className="loom-reflection-source">
        ↳ Reflection on {triggerAgentName}'s {triggerType}
      </span>
      <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

export const ReflectionRow = memo(({ reflection, contributions, participantName, onDialogOpen }) => {
  const trigger = useMemo(() => {
    if (!reflection.targets_which) return null;
    return contributions.find((c) => c.id === reflection.targets_which);
  }, [reflection.targets_which, contributions]);

  const triggerType = trigger?.type?.toUpperCase() ?? "CONTRIBUTION";
  const triggerAgentName = trigger ? participantName(trigger.participant_id) : "another agent";
  const reflectionAgentName = participantName(reflection.participant_id);

  const content = reflection.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Reflection on #\d+ \[[\w]+\] by .+?\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  // Audit-first: always make rows with recorded tool calls clickable so their
  // Tool use tab is reachable even when the text is short.
  const hasTools = (reflection.tool_calls ?? []).length > 0;
  const clickable = isLong || hasTools;
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  const openDialog = () => onDialogOpen?.({ contribution: reflection, participantName: reflectionAgentName, isReflection: true, triggerAgentName, triggerType });

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-reflection", "loom-reflection-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-reflection">reflection</span>
          <span className="loom-text-xs loom-text-muted">Reflection by {reflectionAgentName} on #{reflection.targets_which} [{triggerType}] by {triggerAgentName} (Round {reflection.round})</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(reflection.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const QueryResponseRow = memo(({ queryResponse, contributions, participantName, onDialogOpen }) => {
  const source = useMemo(() => {
    if (!queryResponse.targets_which) return null;
    return contributions.find((c) => c.id === queryResponse.targets_which);
  }, [queryResponse.targets_which, contributions]);

  const sourceAgentName = source ? participantName(source.participant_id) : "another agent";
  const responderName = participantName(queryResponse.participant_id);

  const content = queryResponse.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Response to query from .+?\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  const hasTools = (queryResponse.tool_calls ?? []).length > 0;
  const clickable = isLong || hasTools;
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  const openDialog = () => onDialogOpen?.({ contribution: queryResponse, participantName: responderName, isQueryResponse: true, sourceAgentName });

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-query_response", "loom-query-response-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-query_response">query response</span>
          <span className="loom-text-xs loom-text-muted">{responderName} responding to query from {sourceAgentName} (Round {queryResponse.round})</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(queryResponse.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const EvidenceResponseRow = memo(({ evidenceResponse, contributions, participantName, onDialogOpen }) => {
  const source = useMemo(() => {
    if (!evidenceResponse.targets_which) return null;
    return contributions.find((c) => c.id === evidenceResponse.targets_which);
  }, [evidenceResponse.targets_which, contributions]);

  const sourceAgentName = source ? participantName(source.participant_id) : "another agent";
  const sourceType = source?.type?.toUpperCase() ?? "CONTRIBUTION";
  const responderName = participantName(evidenceResponse.participant_id);

  const content = evidenceResponse.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Evidence from .+? on .+?\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  const hasTools = (evidenceResponse.tool_calls ?? []).length > 0;
  const clickable = isLong || hasTools;
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  const openDialog = () => onDialogOpen?.({ contribution: evidenceResponse, participantName: responderName, isEvidenceResponse: true, sourceAgentName, sourceType });

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-evidence_response", "loom-evidence-response-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-evidence_response">evidence</span>
          <span className="loom-text-xs loom-text-muted">{responderName} providing evidence on {sourceAgentName}'s {sourceType} (Round {evidenceResponse.round})</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(evidenceResponse.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const SummonedResponseRow = memo(({ summonedResponse, participantName, onDialogOpen }) => {
  const requesterName = useMemo(() => {
    const content = summonedResponse.content ?? "";
    const match = content.match(/^\[Summoned: .+?\]\s*/m);
    return match ? "a participant" : "a participant";
  }, [summonedResponse]);

  const content = summonedResponse.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Summoned: .+?\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  const hasTools = (summonedResponse.tool_calls ?? []).length > 0;

  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  // Extract persona name and tier from the content prefix
  const personaInfo = useMemo(() => {
    const match = content.match(/^\[Summoned: (.+?) \((.+?)\)\]/m);
    return match ? { name: match[1], tier: match[2] } : { name: "Guest Expert", tier: "unknown" };
  }, [content]);

  const openDialog = () => onDialogOpen?.({ contribution: summonedResponse, participantName: personaInfo.name, isSummonedResponse: true, personaName: personaInfo.name, personaTier: personaInfo.tier });

  const clickable = isLong || hasTools;
  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-summoned_response", "loom-summoned-response-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-summoned_response">summoned</span>
          <span className="loom-text-xs loom-text-muted">Guest expert {personaInfo.name} ({personaInfo.tier}) — Round {summonedResponse.round}</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(summonedResponse.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const VoteResponseRow = memo(({ voteResponse, contributions, participantName, onDialogOpen }) => {
  const source = useMemo(() => {
    if (!voteResponse.targets_which) return null;
    return contributions.find((c) => c.id === voteResponse.targets_which);
  }, [voteResponse.targets_which, contributions]);

  const sourceAgentName = source ? participantName(source.participant_id) : "another agent";
  const voterName = participantName(voteResponse.participant_id);

  const content = voteResponse.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Vote from .+?\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  const hasTools = (voteResponse.tool_calls ?? []).length > 0;
  const clickable = isLong || hasTools;
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  const openDialog = () => onDialogOpen?.({ contribution: voteResponse, participantName: voterName, isVoteResponse: true, sourceAgentName });

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-vote_response", "loom-vote-response-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-vote_response">vote</span>
          <span className="loom-text-xs loom-text-muted">{voterName} voted on poll from {sourceAgentName} (Round {voteResponse.round})</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(voteResponse.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const VoteTallyRow = memo(({ tally, participantName, onDialogOpen }) => {
  const orchestratorName = participantName(tally.participant_id);

  const content = tally.content ?? "";
  const stripped = useMemo(() => {
    return content.replace(/^\[Vote Tally\]\s*/m, "");
  }, [content]);
  const isLong = stripped.length > 300;
  const hasTools = (tally.tool_calls ?? []).length > 0;
  const clickable = isLong || hasTools;
  const html = useMemo(() => renderMarkdown(stripped), [stripped]);

  const openDialog = () => onDialogOpen?.({ contribution: tally, participantName: orchestratorName, isVoteTally: true });

  return (
    <div
      className={cn("loom-card", "loom-contribution-card", "loom-contrib-type-vote_tally", "loom-vote-tally-row", clickable && "loom-contrib-clickable")}
      onClick={openDialog}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDialog(); } } : undefined}
    >
      <div>
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-badge loom-badge-vote_tally">tally</span>
          <span className="loom-text-xs loom-text-muted">Vote tally by {orchestratorName} (Round {tally.round})</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(tally.created_at)}</span>
        </div>
      </div>
      {isLong ? (
        <p className="loom-text loom-text-muted">{stripped.slice(0, 300)}...</p>
      ) : (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
});

export const AgentPerspective = memo(({ participant, stateOfPlay, recentContributions, reflection }) => {
  return (
    <div className="loom-card loom-agent-perspective">
      <div className="loom-agent-perspective-header">
        <span className="loom-agent-perspective-name">{participant.name}</span>
        <TierBadge tier={participant.tier} />
      </div>
      <div className="loom-agent-perspective-body">
        {participant.persona && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Persona</span>
            <div className="loom-agent-perspective-text">
              {participant.persona.length > 300 ? participant.persona.slice(0, 300) + "..." : participant.persona}
            </div>
          </div>
        )}
        {participant.agenda && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Agenda</span>
            <div className="loom-agent-perspective-text">
              {participant.agenda.length > 300 ? participant.agenda.slice(0, 300) + "..." : participant.agenda}
            </div>
          </div>
        )}
        {stateOfPlay && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">State of Play</span>
            <div className="loom-agent-perspective-text loom-agent-perspective-scroll">
              {stateOfPlay}
            </div>
          </div>
        )}
        {recentContributions && recentContributions.length > 0 && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Recent Contributions</span>
            <div className="loom-agent-perspective-text loom-agent-perspective-scroll">
              {recentContributions.map((c) => (
                <div key={c.id} className="loom-agent-perspective-contrib">
                  <span className="loom-agent-perspective-contrib-id">#{c.id}</span>
                  <span className="loom-agent-perspective-contrib-type">{c.type}</span>
                  <span className="loom-agent-perspective-contrib-content">
                    {c.content.length > 200 ? c.content.slice(0, 200) + "..." : c.content}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {reflection && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Reflection</span>
            <div className="loom-agent-perspective-text loom-agent-perspective-scroll">
              {reflection}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

export const ORCHESTRATOR_TYPE_META = {
  turn_order: { emoji: "🔄", label: "Turn Planning" },
  summary: { emoji: "📝", label: "Round Summary" },
  moderation: { emoji: "🛡️", label: "Moderation" },
  convergence: { emoji: "🎯", label: "Convergence Check" },
  compaction: { emoji: "📦", label: "Context Compaction" },
  domain: { emoji: "🔍", label: "Domain Detection" },
  orchestrator: { emoji: "🎛️", label: "Orchestrator" },
};

export const OrchestratorItem = memo(({ group, onDialogOpen }) => {
  const msg = group.query ?? group.response;
  const meta = ORCHESTRATOR_TYPE_META[msg.type] || { emoji: "❓", label: msg.type };
  const content = msg.content ?? "";
  const timestamp = msg.created_at;

  const openDialog = () => onDialogOpen?.({ orchestratorGroup: group, type: msg.type });
  const onKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDialog();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className="loom-card loom-card-dashed loom-orchestrator-item loom-orchestrator-item-row"
      onClick={openDialog}
      onKeyDown={onKeyDown}
    >
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-orchestrator-item-name">Orchestrator</span>
        <span className="loom-badge loom-badge-orchestrator">{meta.label}</span>
        <span className="loom-text-xs loom-text-muted">{relativeTime(timestamp)}</span>
      </div>
      <p className="loom-text loom-text-muted">{content.slice(0, 150)}{content.length > 150 ? "..." : ""}</p>
    </div>
  );
});

export const OrchestratorDetailDialog = memo(({ open, onClose, orchestratorMessages, highestTierModel }) => {
  const messages = orchestratorMessages ?? [];

  const stats = useMemo(() => {
    const counts = {};
    for (const m of messages) {
      const t = m.type ?? "orchestrator";
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [messages]);

  return (
    <ContentDialog
      open={open}
      onClose={onClose}
      title="Orchestrator"
      className="loom-dialog-type-orchestrator"
    >
      <div className="loom-orchestrator-detail">
        <div className="loom-participant-detail-section">
          <span className="loom-participant-detail-label">Role</span>
          <p className="loom-text loom-text-muted">
            Coordinates the deliberation flow — plans turn order, summarizes rounds, checks for convergence, and moderates conflicts.
          </p>
        </div>

        {highestTierModel && (
          <div className="loom-participant-detail-section">
            <span className="loom-participant-detail-label">Model</span>
            <p className="loom-text loom-text-muted">{highestTierModel}</p>
          </div>
        )}

        {Object.keys(stats).length > 0 && (
          <div className="loom-participant-detail-section">
            <span className="loom-participant-detail-label">Activity</span>
            <div className="loom-flex loom-flex-wrap loom-gap-sm">
              {Object.entries(stats).map(([type, count]) => {
                const meta = ORCHESTRATOR_TYPE_META[type] || { emoji: "❓", label: type };
                return (
                  <span key={type} className="loom-badge loom-badge-orchestrator">
                    {meta.emoji} {meta.label}: {count}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {messages.length === 0 && (
          <p className="loom-text loom-text-muted">No orchestrator messages recorded yet.</p>
        )}
      </div>
    </ContentDialog>
  );
});
