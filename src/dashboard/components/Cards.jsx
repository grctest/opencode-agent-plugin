import { useState, useRef, useEffect, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { cn, tierClass, typeClass } from "../utils.js";
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
          <span className="loom-contrib-participant" style={{ fontWeight: 700 }}>
            {participantName}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <TypeBadge type={contribution.type} />
          </span>
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
  // Server now normalizes rows to {participant_id, target_participant_id, reason}
  // via one mapper in api.js (audit 11 UF3) — read the normalized fields.
  const target = turnRequest.target_participant_id ?? turnRequest.target;
  return (
    <div className="loom-card loom-card-dashed">
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-title-sm">{participantName}</span>
        <span className="loom-badge loom-badge-turn-request">turn request</span>
        <span className="loom-text-xs loom-text-muted">priority {turnRequest.priority}</span>
        {target && (
          <span className="loom-text-xs loom-text-muted">→ {target}</span>
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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>{reflectionAgentName}</span> <span className="loom-text-muted">reflected on</span> <span style={{ fontWeight: 700 }}>{triggerAgentName}</span><span className="loom-text-muted">'s {triggerType} #{reflection.targets_which}</span></span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-reflection">reflection</span></span>
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

export const QueryResponseRow = memo(({ queryResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => {
    if (!queryResponse.targets_which) return null;
    return contributions.find((c) => c.id === queryResponse.targets_which);
  }, [queryResponse.targets_which, contributions]);

  const isValidInvoker = (id) => id && id !== "caller" && id !== "Caller" && id !== "unknown" && id !== "Unknown";
  const sourceAgentName = useMemo(() => {
    if (isValidInvoker(invokerId)) return participantName(invokerId);
    if (source) return participantName(source.participant_id);
    // prompt_context fallback (for pre-fix data)
    const pcId = queryResponse.prompt_context?.source_participant_id ?? queryResponse.prompt_context?.sourceParticipantId;
    if (isValidInvoker(pcId)) return participantName(pcId);
    if (queryResponse.batch_id && contributions) {
      const batchContribs = contributions.filter(c => c.batch_id === queryResponse.batch_id);
      const invoker = batchContribs.find(c => c.id !== queryResponse.id && !["query_response","perspective_response","critique_response","evidence_response","vote_response","summoned_response","vote_tally","reflection"].includes(c.type));
      if (invoker) return participantName(invoker.participant_id);
      const anyOther = batchContribs.find(c => c.id !== queryResponse.id && c.participant_id !== queryResponse.participant_id);
      if (anyOther) return participantName(anyOther.participant_id);
    }
    return "another agent";
  }, [invokerId, source, queryResponse.batch_id, queryResponse.id, queryResponse.participant_id, queryResponse.prompt_context, contributions, participantName]);

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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>{responderName}</span> <span className="loom-text-muted">responded to query from</span> <span style={{ fontWeight: 700 }}>{sourceAgentName}</span></span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-query_response">query response</span></span>
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

export const EvidenceResponseRow = memo(({ evidenceResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => {
    if (!evidenceResponse.targets_which) return null;
    return contributions.find((c) => c.id === evidenceResponse.targets_which);
  }, [evidenceResponse.targets_which, contributions]);

  const isValidInvoker = (id) => id && id !== "caller" && id !== "Caller" && id !== "unknown" && id !== "Unknown";
  const sourceAgentName = useMemo(() => {
    if (isValidInvoker(invokerId)) return participantName(invokerId);
    if (source) return participantName(source.participant_id);
    const pcId = evidenceResponse.prompt_context?.source_participant_id ?? evidenceResponse.prompt_context?.sourceParticipantId;
    if (isValidInvoker(pcId)) return participantName(pcId);
    if (evidenceResponse.batch_id && contributions) {
      const batchContribs = contributions.filter(c => c.batch_id === evidenceResponse.batch_id);
      const invoker = batchContribs.find(c => c.id !== evidenceResponse.id && !["query_response","perspective_response","critique_response","evidence_response","vote_response","summoned_response","vote_tally","reflection"].includes(c.type));
      if (invoker) return participantName(invoker.participant_id);
      const anyOther = batchContribs.find(c => c.id !== evidenceResponse.id && c.participant_id !== evidenceResponse.participant_id);
      if (anyOther) return participantName(anyOther.participant_id);
    }
    return "another agent";
  }, [invokerId, source, evidenceResponse.batch_id, evidenceResponse.id, evidenceResponse.participant_id, evidenceResponse.prompt_context, contributions, participantName]);
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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>{responderName}</span> <span className="loom-text-muted">providing evidence on</span> <span style={{ fontWeight: 700 }}>{sourceAgentName}</span><span className="loom-text-muted">'s {sourceType}</span></span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-evidence_response">evidence</span></span>
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

export const SummonedResponseRow = memo(({ summonedResponse, contributions, participantName, onDialogOpen, invokerId }) => {
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

  const isValidInvoker = (id) => id && id !== "caller" && id !== "Caller" && id !== "unknown" && id !== "Unknown";
  const invokerName = useMemo(() => {
    if (isValidInvoker(invokerId)) return participantName(invokerId);
    const pcId = summonedResponse.prompt_context?.source_participant_id ?? summonedResponse.prompt_context?.sourceParticipantId;
    if (isValidInvoker(pcId)) return participantName(pcId);
    if (summonedResponse.batch_id && contributions) {
      const batchContribs = contributions.filter(c => c.batch_id === summonedResponse.batch_id);
      const invoker = batchContribs.find(c => c.id !== summonedResponse.id && !["query_response","perspective_response","critique_response","evidence_response","vote_response","summoned_response","vote_tally","reflection"].includes(c.type));
      if (invoker) return participantName(invoker.participant_id);
      const anyOther = batchContribs.find(c => c.id !== summonedResponse.id && c.participant_id !== summonedResponse.participant_id);
      if (anyOther) return participantName(anyOther.participant_id);
    }
    return null;
  }, [invokerId, summonedResponse.batch_id, summonedResponse.id, summonedResponse.participant_id, summonedResponse.prompt_context, contributions, participantName]);

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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>Guest expert {personaInfo.name}</span> <span className="loom-text-muted">({personaInfo.tier}){invokerName ? " summoned by " : ""}</span>{invokerName && <span style={{ fontWeight: 700 }}>{invokerName}</span>}</span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-summoned_response">summoned</span></span>
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

export const VoteResponseRow = memo(({ voteResponse, contributions, participantName, onDialogOpen, invokerId }) => {
  const source = useMemo(() => {
    if (!voteResponse.targets_which) return null;
    return contributions.find((c) => c.id === voteResponse.targets_which);
  }, [voteResponse.targets_which, contributions]);

  const isValidInvoker = (id) => id && id !== "caller" && id !== "Caller" && id !== "unknown" && id !== "Unknown";
  const sourceAgentName = useMemo(() => {
    if (isValidInvoker(invokerId)) return participantName(invokerId);
    if (source) return participantName(source.participant_id);
    const pcId = voteResponse.prompt_context?.source_participant_id ?? voteResponse.prompt_context?.sourceParticipantId ?? voteResponse.prompt_context?.source_participant_name;
    if (isValidInvoker(pcId)) {
      // pcId may be name for old data; try to map name to participant id via contributions
      const byName = contributions?.find(c => {
        const n = participantName(c.participant_id);
        return n === pcId;
      });
      if (byName) return participantName(byName.participant_id);
      return participantName(pcId);
    }
    if (voteResponse.batch_id && contributions) {
      const batchContribs = contributions.filter(c => c.batch_id === voteResponse.batch_id);
      const invoker = batchContribs.find(c => c.id !== voteResponse.id && !["query_response","perspective_response","critique_response","evidence_response","vote_response","summoned_response","vote_tally","reflection"].includes(c.type));
      if (invoker) return participantName(invoker.participant_id);
      const anyOther = batchContribs.find(c => c.id !== voteResponse.id && c.participant_id !== voteResponse.participant_id);
      if (anyOther) return participantName(anyOther.participant_id);
    }
    return "another agent";
  }, [invokerId, source, voteResponse.batch_id, voteResponse.id, voteResponse.participant_id, voteResponse.prompt_context, contributions, participantName]);

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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>{voterName}</span> <span className="loom-text-muted">voted on poll from</span> <span style={{ fontWeight: 700 }}>{sourceAgentName}</span></span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-vote_response">vote</span></span>
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
          <span className="loom-text-xs"><span style={{ fontWeight: 700 }}>{orchestratorName}</span> <span className="loom-text-muted">tally</span></span>
          <span style={{ marginLeft: "auto" }}><span className="loom-badge loom-badge-vote_tally">tally</span></span>
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
        <span className="loom-orchestrator-item-name" style={{ fontWeight: 700 }}>Orchestrator</span>
        <span className="loom-badge loom-badge-orchestrator" style={{ marginLeft: "auto" }}>{meta.label}</span>
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
