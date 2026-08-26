import { useRef, useMemo, useCallback, useState, useEffect, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, QueryResponseRow, EvidenceResponseRow, SummonedResponseRow, VoteResponseRow, OrchestratorItem, ORCHESTRATOR_TYPE_META, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { buildFlatItems, pairOrchestratorMessages } from "../utils/timeline.js";

import { List } from "react-window";

const THINKING_TURN_HEIGHT = 56;
const THINKING_REFLECTION_HEIGHT = 56;
const THINKING_QUERY_HEIGHT = 56;
const THINKING_EVIDENCE_HEIGHT = 56;
const THINKING_SUMMON_HEIGHT = 56;

const HEADER_HEIGHT = 48;
const CONTRIBUTION_HEIGHT = 56;
const INTERJECTION_HEIGHT = 72;
const EXTENSION_MARKER_HEIGHT = 32;
const REFLECTION_HEIGHT = 80;
const QUERY_RESPONSE_HEIGHT = 80;
const EVIDENCE_RESPONSE_HEIGHT = 80;
const SUMMONED_RESPONSE_HEIGHT = 80;
const VOTE_RESPONSE_HEIGHT = 80;
const ORCHESTRATOR_ITEM_HEIGHT = 80;

const ROUND_SUMMARY_HEIGHT = 88;

const LOOM_INVOCATION_HEIGHT = 72;

const ModelFallbackItem = memo(({ error, participantName }) => {
  const [expanded, setExpanded] = useState(false);
  const name = participantName(error.participant_id);
  const msg = error.error_message || "";
  const parts = msg.split(" — ");
  const modelInfo = parts[0] || msg;
  const errorMsg = parts.slice(1).join(" — ") || "unknown error";

  return (
    <div className="loom-card loom-fallback-card">
      <div className="loom-fallback-header" onClick={() => setExpanded(!expanded)}>
        <span className="loom-fallback-icon" aria-hidden="true">🔄</span>
        <span className="loom-text loom-text-sm">
          <strong>{name}</strong> switched models — {modelInfo}
        </span>
        <span className="loom-fallback-toggle">{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && (
        <div className="loom-fallback-details">
          <span className="loom-text-xs loom-text-muted">{errorMsg}</span>
        </div>
      )}
    </div>
  );
});

const RoundSummaryItem = memo(({ summary, group, onDialogOpen }) => {
  const openDialog = () => onDialogOpen?.({ orchestratorGroup: group, type: "summary" });
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
      className="loom-card loom-card-dashed loom-round-summary"
      onClick={openDialog}
      onKeyDown={onKeyDown}
    >
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-orchestrator-item-name">Orchestrator</span>
        <span className="loom-badge loom-badge-orchestrator">{ORCHESTRATOR_TYPE_META.summary.label}</span>
      </div>
      <div className="loom-round-summary-content loom-text loom-text-muted">{summary}</div>
    </div>
  );
});

// pairOrchestratorMessages now imported from ../utils/timeline.js; local wrapper kept for compatibility
// function pairOrchestratorMessages removed — see utils/timeline.js

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "round_summary") return ROUND_SUMMARY_HEIGHT;
  if (item.type === "turn_request") return INTERJECTION_HEIGHT;
  if (item.type === "model_fallback") return INTERJECTION_HEIGHT;
  if (item.type === "reflection") return REFLECTION_HEIGHT;
  if (item.type === "query_response") return QUERY_RESPONSE_HEIGHT;
  if (item.type === "perspective_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "critique_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "evidence_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "summoned_response") return SUMMONED_RESPONSE_HEIGHT;
  if (item.type === "vote_response") return VOTE_RESPONSE_HEIGHT;
  if (item.type === "loom_invocation") return LOOM_INVOCATION_HEIGHT;
  if (item.type === "orchestrator") return ORCHESTRATOR_ITEM_HEIGHT;
  if (item.type === "thinking_turn") return THINKING_TURN_HEIGHT;
  if (item.type === "thinking_reflection") return THINKING_REFLECTION_HEIGHT;
  if (item.type === "thinking_query") return THINKING_QUERY_HEIGHT;
  if (item.type === "thinking_evidence") return THINKING_EVIDENCE_HEIGHT;
  if (item.type === "thinking_summon") return THINKING_SUMMON_HEIGHT;
  if (item.type === "agent_turn") {
    return 115;
  }
  return 115;
}

const TimelineRow = memo(({ index, style, items, onToggleCollapse, participantName, onDialogOpen, onOrchestratorDialogOpen, contributions }) => {
  const item = items[index];
  if (!item) return null;
  if (item.type === "header") {
    return (
      <div style={style} className="loom-vrow">
        {item.showExtensionMarker && (
          <div className="loom-extension-marker">
            <span className="loom-extension-marker-line" />
            <span className="loom-extension-marker-label">Extended</span>
            <span className="loom-extension-marker-line" />
          </div>
        )}
        <div className={cn("loom-round-group", item.isActive && "loom-round-active")}>
          <button className="loom-round-header" onClick={() => onToggleCollapse(item.round)} aria-expanded={!item.isCollapsed} aria-controls={`round-content-${item.round}`} aria-label={`Round ${item.round} ${item.isCollapsed ? "collapsed" : "expanded"}`}>
            <span className="loom-round-toggle" aria-hidden="true">{item.isCollapsed ? "▶" : "▼"}</span>
            <span className="loom-round-title">Round {item.round}</span>
            <span className="loom-round-count" aria-live="polite">{item.contribsCount} contribution{item.contribsCount !== 1 ? "s" : ""}</span>
            {item.errorsCount > 0 && (
              <span className="loom-round-errors"><span aria-hidden="true">⚠</span> {item.errorsCount}</span>
            )}
          </button>
          <div id={`round-content-${item.round}`} hidden={item.isCollapsed} aria-hidden={item.isCollapsed} />
        </div>
      </div>
    );
  }
  if (item.type === "agent_turn") {
    return (
      <div style={style} className="loom-vrow">
        <div className="loom-agent-turn-block">
          {item.contributions.map((c) => (
            <ContributionItem key={c.id} contribution={c} participantName={participantName(item.agentId)} onDialogOpen={onDialogOpen} />
          ))}
        </div>
      </div>
    );
  }
  if (item.type === "loom_invocation") {
    const { invocation } = item;
    const toolName = invocation.tool ?? invocation.attempted_tool ?? "loom";
    const isError = !!invocation.error || invocation.status === "error";
    let detail = "";
    try {
      const input = typeof invocation.input === "string" ? JSON.parse(invocation.input) : invocation.input;
      if (toolName === "loom_query" || toolName === "loom_evidence") {
        detail = `${Array.isArray(input.targets) ? input.targets.join(", ") : ""}: ${(input.question ?? "").slice(0,80)}`;
      } else if (toolName === "loom_vote") {
        detail = (input.question ?? "").slice(0,80);
      } else if (toolName === "loom_summon") {
        detail = `${input.persona_name ?? input.personaName ?? ""}: ${(input.issue ?? "").slice(0,60)}`;
      } else if (toolName === "loom_request_next") {
        detail = `P${input.priority} ${input.reason ?? ""}`.slice(0,80);
      } else if (input && typeof input === "object") detail = JSON.stringify(input).slice(0,80);
    } catch { detail = invocation.input ? String(invocation.input).slice(0,80) : ""; }
    // Clicking the invocation row opens the invoker's dialog (Tool use tab shows full evidence)
    const openInvokerDialog = (e) => {
      e.stopPropagation();
      const source = (contributions ?? []).find(c => c.id === item.sourceContributionId);
      if (source && onDialogOpen) {
        onDialogOpen({ contribution: source, participantName: participantName(item.sourceParticipantId), isLoomInvocation: true });
      }
    };
    return (
      <div style={style} className="loom-vrow loom-vrow-loom-invocation" title={`${detail} — click to open invoker's Tool use`}>
        <div
          className="loom-card loom-contribution-card loom-loom-invocation-row loom-contrib-clickable"
          style={{ borderLeft: "3px solid #6366f1", paddingLeft: "1rem", opacity: 0.95, cursor: "pointer" }}
          onClick={openInvokerDialog}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInvokerDialog(e); } }}
        >
          <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
            <span className="loom-badge loom-badge-orchestrator" style={{ background: isError ? "#dc2626" : "#6366f1" }}>{toolName.replace("loom_", "")}</span>
            <span className="loom-text-xs loom-text-muted">{detail}</span>
            <span className={cn("loom-tool-call-status", isError ? "loom-tool-call-error" : "loom-tool-call-success")} style={{ marginLeft: "auto", fontSize: "0.65rem", padding: "2px 6px", borderRadius: "4px", background: isError ? "#fee2e2" : "#dcfce7", color: isError ? "#dc2626" : "#16a34a" }}>{isError ? "error" : "invoked"}</span>
          </div>
          {invocation.output && <pre className="loom-tool-call-output" style={{ marginTop: "0.5rem", fontSize: "0.7rem", maxHeight: "60px", overflowY: "auto", whiteSpace: "pre-wrap" }}>{typeof invocation.output === "string" ? invocation.output.slice(0,300) : JSON.stringify(invocation.output).slice(0,300)}</pre>}
        </div>
      </div>
    );
  }
  if (item.type === "reflection") {
    return (
      <div style={style} className="loom-vrow loom-vrow-reflection">
        <ReflectionRow
          reflection={item.reflection}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
        />
      </div>
    );
  }
  if (item.type === "query_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-query-response">
        <QueryResponseRow
          queryResponse={item.queryResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "perspective_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-perspective-response">
        <QueryResponseRow
          queryResponse={item.perspectiveResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "critique_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-critique-response">
        <QueryResponseRow
          queryResponse={item.critiqueResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "thinking_turn") {
    return (
      <div style={style} className="loom-vrow">
        <div className="loom-card loom-thinking-card loom-thinking-placeholder-row">
          <div className="loom-thinking-content">
            <span className="loom-thinking-dots">
              <span /><span /><span />
            </span>
            <span className="loom-text loom-text-muted">
              {item.participant.name} ({item.participant.tier}) is thinking...
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thinking_reflection") {
    return (
      <div style={style} className="loom-vrow loom-vrow-reflection">
        <div className="loom-card loom-thinking-card loom-thinking-placeholder-row loom-contrib-type-reflection">
          <div className="loom-thinking-content">
            <span className="loom-thinking-dots">
              <span /><span /><span />
            </span>
            <span className="loom-text loom-text-muted">
              Reflection by {item.reflectorName} on {item.triggerAgentName}'s {item.triggerType}...
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thinking_query") {
    return (
      <div style={style} className="loom-vrow loom-vrow-query-response">
        <div className="loom-card loom-thinking-card loom-thinking-placeholder-row loom-contrib-type-query_response">
          <div className="loom-thinking-content">
            <span className="loom-thinking-dots">
              <span /><span /><span />
            </span>
            <span className="loom-text loom-text-muted">
              {item.queriedAgentName} is answering a query...
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thinking_evidence") {
    return (
      <div style={style} className="loom-vrow loom-vrow-evidence-response">
        <div className="loom-card loom-thinking-card loom-thinking-placeholder-row loom-contrib-type-evidence_response">
          <div className="loom-thinking-content">
            <span className="loom-thinking-dots">
              <span /><span /><span />
            </span>
            <span className="loom-text loom-text-muted">
              {item.evidenceAgentName} is finding evidence...
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "thinking_summon") {
    return (
      <div style={style} className="loom-vrow loom-vrow-summoned-response">
        <div className="loom-card loom-thinking-card loom-thinking-placeholder-row loom-contrib-type-summoned_response">
          <div className="loom-thinking-content">
            <span className="loom-thinking-dots">
              <span /><span /><span />
            </span>
            <span className="loom-text loom-text-muted">
              Guest expert is being summoned...
            </span>
          </div>
        </div>
      </div>
    );
  }
  if (item.type === "evidence_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-evidence-response">
        <EvidenceResponseRow
          evidenceResponse={item.evidenceResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "summoned_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-summoned-response">
        <SummonedResponseRow
          summonedResponse={item.summonedResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "vote_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-vote-response">
        <VoteResponseRow
          voteResponse={item.voteResponse}
          contributions={contributions}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
          invokerId={item.invokerId}
        />
      </div>
    );
  }
  if (item.type === "round_summary") {
    return (
      <div style={style} className="loom-vrow">
        <RoundSummaryItem summary={item.summary} group={item.group} onDialogOpen={onOrchestratorDialogOpen} />
      </div>
    );
  }
  if (item.type === "contribution") {
    return (
      <div style={style} className="loom-vrow">
        <ContributionItem contribution={item.contribution} participantName={participantName(item.contribution.participant_id)} onDialogOpen={onDialogOpen} />
      </div>
    );
  }
  if (item.type === "orchestrator") {
    return (
      <div style={style} className="loom-vrow">
        <OrchestratorItem group={item.group} onDialogOpen={onOrchestratorDialogOpen} />
      </div>
    );
  }
  if (item.type === "model_fallback") {
    return (
      <div style={style} className="loom-vrow">
        <ModelFallbackItem error={item.error} participantName={participantName} />
      </div>
    );
  }
  return (
    <div style={style} className="loom-vrow">
      <TurnRequestItem turnRequest={item.turnRequest} participantName={participantName(item.turnRequest.participant_id)} />
    </div>
  );
});

const TimelineTabBase = ({
  contributions,
  groupedContributions,
  isWeaving,
  thinkingParticipants,
  reflectingParticipants,
  queryingParticipants,
  evidenceParticipants,
  summoningParticipants,
  collapsedRounds,
  onToggleCollapse,
  agentErrors,
  participantName,
  turnRequests,
  extensions,
  activeRound,
  maxRounds,
  orchestratorMessages,
  roundSummaries = {},
  selectedMeeting,
}) => {
  const listRef = useRef(null);
  const [dialogContribution, setDialogContribution] = useState(null);
  const [dialogOrchestratorGroup, setDialogOrchestratorGroup] = useState(null);
  const [activeTab, setActiveTab] = useState("response");
  const [orchestratorActiveTab, setOrchestratorActiveTab] = useState("prompt");
  const [fetchedContext, setFetchedContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(null);

  const handleDialogOpen = useCallback((data) => {
    setDialogContribution(data);
    setActiveTab("response");
    setFetchedContext(null);
    setContextError(null);
    setContextLoading(false);
  }, []);

  const meetingIdForContext = selectedMeeting ?? (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const m = params.get("meeting");
      if (m) return m;
      const hash = window.location.hash.slice(1);
      if (hash) return hash;
    } catch {}
    return null;
  })();

  useEffect(() => {
    const pc = dialogContribution?.contribution?.prompt_context;
    const hasFullContext = pc && (pc.system_prompt || pc.user_prompt || pc.state_of_play || pc.round_contributions_used);
    if (activeTab !== "context" || !dialogContribution || hasFullContext || fetchedContext || contextLoading) return;
    const cid = dialogContribution.contribution.id;
    const mid = meetingIdForContext || dialogContribution.contribution.meeting_id;
    if (!cid || !mid) return;
    let cancelled = false;
    setContextLoading(true);
    setContextError(null);
    fetch(`/api/contribution_context?meeting=${mid}&contribution_id=${cid}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data.prompt_context ?? data;
      })
      .then((ctx) => {
        if (!cancelled) {
          if (ctx && typeof ctx === "object" && Object.keys(ctx).length > 0) {
            setFetchedContext(ctx);
          } else {
            setContextError("No prompt context captured for this contribution.");
          }
        }
      })
      .catch((err) => {
        if (!cancelled) setContextError(err.message || "Failed to load context");
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeTab, dialogContribution, fetchedContext, contextLoading, meetingIdForContext]);

  useEffect(() => {
    if (!dialogContribution) {
      setFetchedContext(null);
      setContextError(null);
      setContextLoading(false);
    }
  }, [dialogContribution]);

  const handleOrchestratorDialogOpen = useCallback((data) => {
    setDialogOrchestratorGroup(data.orchestratorGroup);
    setOrchestratorActiveTab("prompt");
  }, []);

  // Extracted pure function — see src/dashboard/utils/timeline.js
  const flatItems = useMemo(() => buildFlatItems(groupedContributions, {
    collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving,
    thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants,
    participantName, orchestratorMessages, roundSummaries
  }), [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving, thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants, participantName, orchestratorMessages, roundSummaries]);

  // Wire poll error handler to setPollError (exposed via aria-live)
  const [pollError, setPollError] = useState(null);
  useEffect(() => {
    const handler = (e) => setPollError(e.detail?.message ?? String(e.detail ?? "poll error"));
    window.addEventListener("loom-sse-error", handler);
    return () => window.removeEventListener("loom-sse-error", handler);
  }, []);

  const rowHeightFn = useCallback((index, cellProps) => {
    const item = cellProps.items[index];
    return item ? getRowHeight(item) : CONTRIBUTION_HEIGHT;
  }, []);

  const [viewportHeight, setViewportHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 800);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const sumHeights = useMemo(() => flatItems.reduce((sum, item) => sum + getRowHeight(item), 0), [flatItems]);
  const listHeight = useMemo(() => {
    return Math.max(400, Math.min(window.innerHeight - 300, sumHeights));
  }, [sumHeights, viewportHeight]);

  const rowProps = useMemo(() => ({
    items: flatItems,
    onToggleCollapse,
    participantName,
    onDialogOpen: handleDialogOpen,
    onOrchestratorDialogOpen: handleOrchestratorDialogOpen,
    contributions,
  }), [flatItems, onToggleCollapse, participantName, contributions, handleDialogOpen, handleOrchestratorDialogOpen]);

  return (
    <div className="loom-main-content">
      {/* Poll error aria-live region — wired to setPollError */}
      {pollError && (
        <div className="loom-card loom-card-error loom-mb-sm" role="alert" aria-live="polite" aria-atomic="true">
          <p className="loom-text-xs">{pollError}</p>
          <button className="loom-link-btn" onClick={() => setPollError(null)} aria-label="Dismiss poll error">Dismiss</button>
        </div>
      )}
      {/* Live indicator for assistive tech */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">{isWeaving ? `Live — round ${activeRound} weaving` : `Round ${activeRound} complete`}</div>
      {groupedContributions.length === 0 && contributions.length === 0 && !isWeaving && (
        <div className="loom-empty-state">
          <div className="loom-empty-icon" aria-hidden="true">🧵</div>
          <p className="loom-text loom-text-muted">Waiting for agents to respond...</p>
          <p className="loom-text-xs loom-text-muted">Contributions will appear here in real-time</p>
        </div>
      )}
      {flatItems.length > 0 && (
        <div className="loom-timeline-list" aria-live="polite">
          <List
            listRef={listRef}
            rowCount={flatItems.length}
            rowHeight={rowHeightFn}
            rowComponent={TimelineRow}
            rowProps={rowProps}
            overscanCount={8}
            style={{ height: listHeight, width: "100%" }}
          />
        </div>
      )}
      <ContentDialog
        open={dialogContribution !== null}
        onClose={() => setDialogContribution(null)}
      title={dialogContribution ? (dialogContribution.isReflection
        ? `Reflection by ${dialogContribution.participantName}`
        : dialogContribution.isQueryResponse
        ? `Query response by ${dialogContribution.participantName}`
        : dialogContribution.isEvidenceResponse
        ? `Evidence response by ${dialogContribution.participantName}`
        : dialogContribution.isSummonedResponse
        ? `Summoned expert: ${dialogContribution.personaName}`
        : dialogContribution.isVoteResponse
        ? `Vote by ${dialogContribution.participantName}`
        : `${dialogContribution.participantName} — ${dialogContribution.contribution.type}`) : ""}
      className={dialogContribution ? (dialogContribution.isReflection
        ? "loom-dialog-type-reflection"
        : dialogContribution.isQueryResponse
        ? "loom-dialog-type-query_response"
        : dialogContribution.isEvidenceResponse
        ? "loom-dialog-type-evidence_response"
        : dialogContribution.isSummonedResponse
        ? "loom-dialog-type-summoned_response"
        : dialogContribution.isVoteResponse
        ? "loom-dialog-type-vote_response"
        : `loom-dialog-type-${dialogContribution.contribution.type}`) : ""}
      >
        {dialogContribution && (
          <div className="loom-dialog-tabs-container">
            <div className="loom-dialog-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === "response"}
                className={cn("loom-dialog-tab", activeTab === "response" && "loom-dialog-tab-active")}
                onClick={() => setActiveTab("response")}
              >
                Response
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "tools"}
                className={cn("loom-dialog-tab", activeTab === "tools" && "loom-dialog-tab-active")}
                onClick={() => setActiveTab("tools")}
              >
                Tool use
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "details"}
                className={cn("loom-dialog-tab", activeTab === "details" && "loom-dialog-tab-active")}
                onClick={() => setActiveTab("details")}
              >
                Details
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "context"}
                className={cn("loom-dialog-tab", activeTab === "context" && "loom-dialog-tab-active")}
                onClick={() => setActiveTab("context")}
              >
                Context
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "errors"}
                className={cn("loom-dialog-tab", activeTab === "errors" && "loom-dialog-tab-active")}
                onClick={() => setActiveTab("errors")}
              >
                Errors
              </button>
            </div>
            <div className="loom-dialog-tab-panel" role="tabpanel">
              {activeTab === "response" && (
                <>
                  <div className="loom-prose" dangerouslySetInnerHTML={{
                    __html: renderMarkdown(dialogContribution.contribution.content ?? "")
                  }} />
                  <div className="loom-dialog-footer">
                    <button
                      className="pure-button pure-button-small loom-copy-btn"
                      onClick={() => navigator.clipboard.writeText(dialogContribution.contribution.content ?? "")}
                    >
                      Copy text
                    </button>
                  </div>
                </>
              )}
              {activeTab === "tools" && (
                <div className="loom-tool-calls-panel">
                  {dialogContribution.contribution.tool_calls && dialogContribution.contribution.tool_calls.length > 0 ? (
                    <div className="loom-tool-calls-list">
                      {dialogContribution.contribution.tool_calls.map((tc, i) => {
                        const attempted = !!tc.attempted_tool;
                        const failed = !!tc.error || tc.status === "error";
                        return (
                          <div key={tc.callID ?? i} className="loom-tool-call-item">
                            <div className="loom-tool-call-header">
                              {attempted && tc.attempted_tool !== tc.tool ? (
                                <span className="loom-tool-call-name">attempted {tc.attempted_tool}</span>
                              ) : (
                                <span className="loom-tool-call-name">{tc.tool}</span>
                              )}
                              {tc.title && <span className="loom-tool-call-title">{tc.title}</span>}
                              {failed ? (
                                <span className="loom-tool-call-status loom-tool-call-error">
                                  {attempted ? "attempted/failed" : "error"}
                                </span>
                              ) : (
                                <span className="loom-tool-call-status loom-tool-call-success">ok</span>
                              )}
                            </div>
                            {tc.input && (
                              <pre className="loom-tool-call-input">{typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}</pre>
                            )}
                            {tc.output && (
                              <pre className="loom-tool-call-output">{typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)}</pre>
                            )}
                            {tc.error && (
                              <pre className="loom-tool-call-error-output">{typeof tc.error === "string" ? tc.error : JSON.stringify(tc.error)}</pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : dialogContribution.contribution.tool_calls && Array.isArray(dialogContribution.contribution.tool_calls) && dialogContribution.contribution.tool_calls.length === 0 ? (
                    <p className="loom-text loom-text-muted loom-tool-calls-empty">Tools were offered but no calls were made — model answered from memory/training data (no webfetch/websearch/read executed).</p>
                  ) : (
                    <p className="loom-text loom-text-muted loom-tool-calls-empty">No tool call data recorded (tools may not have been offered for this turn).</p>
                  )}
                  {(() => {
                    const batchId = dialogContribution.contribution.batch_id;
                    if (!batchId || !contributions) return null;
                    const peers = contributions.filter(c => c.batch_id === batchId && c.id !== dialogContribution.contribution.id && c.tool_calls && c.tool_calls.length > 0);
                    if (peers.length === 0) return null;
                    return (
                      <div className="loom-batch-peer-tools" style={{ marginTop: "1rem", borderTop: "1px solid var(--color-border)", paddingTop: "0.75rem" }}>
                        <h4 className="loom-text loom-text-sm" style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Peer tool calls in same batch ({peers.length} response{peers.length!==1?"s":""} via {batchId.slice(0,8)}…)</h4>
                        <p className="loom-text-xs loom-text-muted" style={{ marginBottom: "0.5rem" }}>This contribution triggered peer actions (loom_query/evidence/vote/summon). Their research tool calls are stored on the peer responses, not on this invoker row — shown here for audit:</p>
                        {peers.map(pc => {
                          const peerName = participantName ? participantName(pc.participant_id) : pc.participant_id;
                          return (
                            <div key={pc.id} style={{ marginBottom: "0.75rem", paddingLeft: "0.5rem", borderLeft: "2px solid #6366f1" }}>
                              <div className="loom-text-xs" style={{ fontWeight: 600 }}>{peerName} — {pc.type} #{pc.id} {pc.tool_calls.length} tool{pc.tool_calls.length!==1?"s":""}</div>
                              <div className="loom-tool-calls-list">
                                {pc.tool_calls.map((tc, j) => (
                                  <div key={tc.callID ?? j} className="loom-tool-call-item">
                                    <div className="loom-tool-call-header">
                                      <span className="loom-tool-call-name">{tc.attempted_tool ? `attempted ${tc.attempted_tool}` : tc.tool}</span>
                                      {tc.title && <span className="loom-tool-call-title">{tc.title}</span>}
                                      <span className={tc.error || tc.status==="error" ? "loom-tool-call-status loom-tool-call-error" : "loom-tool-call-status loom-tool-call-success"}>{tc.error || tc.status==="error" ? "error" : "ok"}</span>
                                    </div>
                                    {tc.input && <pre className="loom-tool-call-input">{tc.input}</pre>}
                                    {tc.output && <pre className="loom-tool-call-output">{tc.output}</pre>}
                                    {tc.error && <pre className="loom-tool-call-error-output">{typeof tc.error==="string"?tc.error:JSON.stringify(tc.error)}</pre>}
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}
              {activeTab === "details" && (
                <div className="loom-details-panel">
                  <table className="loom-details-table">
                    <tbody>
                      <tr>
                        <td className="loom-details-label">Type</td>
                        <td className="loom-details-value">
                          <span className={cn("loom-badge", `loom-badge-${dialogContribution.contribution.type}`)}>
                            {dialogContribution.contribution.type}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="loom-details-label">Round</td>
                        <td className="loom-details-value">{dialogContribution.contribution.round}</td>
                      </tr>
                      <tr>
                        <td className="loom-details-label">Participant</td>
                        <td className="loom-details-value">{dialogContribution.participantName}</td>
                      </tr>
                      <tr>
                        <td className="loom-details-label">Timestamp</td>
                        <td className="loom-details-value">{relativeTime(dialogContribution.contribution.created_at)}</td>
                      </tr>
                      <tr>
                        <td className="loom-details-label">Word count</td>
                        <td className="loom-details-value">{(dialogContribution.contribution.content ?? "").split(/\s+/).filter(Boolean).length}</td>
                      </tr>
                      <tr>
                        <td className="loom-details-label">Contribution ID</td>
                        <td className="loom-details-value loom-details-mono">#{dialogContribution.contribution.id}</td>
                      </tr>
                      {dialogContribution.isReflection && dialogContribution.triggerAgentName && (
                        <>
                          <tr>
                            <td className="loom-details-label">Reflection on</td>
                            <td className="loom-details-value">{dialogContribution.triggerAgentName}'s {dialogContribution.triggerType}</td>
                          </tr>
                          <tr>
                            <td className="loom-details-label">Target ID</td>
                            <td className="loom-details-value loom-details-mono">#{dialogContribution.contribution.targets_which}</td>
                          </tr>
                        </>
                      )}
                      {dialogContribution.isQueryResponse && dialogContribution.sourceAgentName && (
                        <>
                          <tr>
                            <td className="loom-details-label">Query from</td>
                            <td className="loom-details-value">{dialogContribution.sourceAgentName}</td>
                          </tr>
                          <tr>
                            <td className="loom-details-label">Source ID</td>
                            <td className="loom-details-value loom-details-mono">#{dialogContribution.contribution.targets_which}</td>
                          </tr>
                        </>
                      )}
                      {dialogContribution.isEvidenceResponse && dialogContribution.sourceAgentName && (
                        <>
                          <tr>
                            <td className="loom-details-label">Evidence request from</td>
                            <td className="loom-details-value">{dialogContribution.sourceAgentName}</td>
                          </tr>
                          <tr>
                            <td className="loom-details-label">Source ID</td>
                            <td className="loom-details-value loom-details-mono">#{dialogContribution.contribution.targets_which}</td>
                          </tr>
                        </>
                      )}
                      {dialogContribution.isSummonedResponse && (
                        <>
                          <tr>
                            <td className="loom-details-label">Persona</td>
                            <td className="loom-details-value">{dialogContribution.personaName} ({dialogContribution.personaTier})</td>
                          </tr>
                          <tr>
                            <td className="loom-details-label">Summoned by</td>
                            <td className="loom-details-value">A participant</td>
                          </tr>
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {activeTab === "context" && (
                <div className="loom-context-panel">
                  {(() => {
                    const pc = dialogContribution.contribution.prompt_context;
                    const hasFull = pc && (pc.system_prompt || pc.user_prompt || pc.state_of_play);
                    const ctx = hasFull ? pc : (fetchedContext ?? pc);
                    if (contextLoading) {
                      return <p className="loom-text loom-text-muted loom-context-empty">Loading prompt context...</p>;
                    }
                    if (contextError) {
                      return <p className="loom-text loom-text-muted loom-context-empty">{contextError}</p>;
                    }
                    if (!ctx) {
                      return <p className="loom-text loom-text-muted loom-context-empty">No prompt context captured for this contribution.</p>;
                    }
                    return (
                      <>
                          {ctx.system_prompt && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">System Prompt</h4>
                              <pre className="loom-context-block loom-context-raw">{ctx.system_prompt}</pre>
                            </div>
                          )}
                          {ctx.state_of_play && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">State of Play (Round {ctx.round})</h4>
                              <div className="loom-context-block">{ctx.state_of_play}</div>
                            </div>
                          )}
                          {ctx.rag_chunks_used && ctx.rag_chunks_used.length > 0 && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">RAG Context (Vector Retrieval)</h4>
                              <div className="loom-context-block">
                                {ctx.rag_chunks_used.map((chunk, i) => (
                                  <div key={i}>{chunk}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          {ctx.recent_contributions && ctx.recent_contributions.length > 0 && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Recent Contributions</h4>
                              <div className="loom-context-block">
                                {ctx.recent_contributions.map((c) => (
                                  <div key={c.id}>
                                    <span className="loom-context-contrib-id">#{c.id}</span>
                                    <span className="loom-context-contrib-type">{c.type}</span>
                                    [{c.participant_id}]: {c.content}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {ctx.round_contributions_used && ctx.round_contributions_used.length > 0 && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Round Contributions</h4>
                              <div className="loom-context-block">
                                {ctx.round_contributions_used.map((c) => (
                                  <div key={c.id}>
                                    <span className="loom-context-contrib-id">#{c.id}</span>
                                    <span className="loom-context-contrib-type">{c.type}</span>
                                    [{c.participant_id}]: {c.content}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {ctx.reflection && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Agent's Reflection</h4>
                              <div className="loom-context-block">{ctx.reflection}</div>
                            </div>
                          )}
                          {ctx.trigger_contribution_id && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Triggered By</h4>
                              <div className="loom-context-block">
                                Contribution #{ctx.trigger_contribution_id} by {ctx.trigger_participant_id} ({ctx.trigger_type})
                              </div>
                            </div>
                          )}
                          {ctx.source_contribution_id && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Source</h4>
                              <div className="loom-context-block">
                                Contribution #{ctx.source_contribution_id} by {ctx.source_participant_id}
                                {ctx.question && <span> — Question: "{ctx.question}"</span>}
                              </div>
                            </div>
                          )}
                          {ctx.user_prompt && (
                            <div className="loom-context-section">
                              <h4 className="loom-context-heading">Full User Prompt</h4>
                              <pre className="loom-context-block loom-context-raw">{ctx.user_prompt}</pre>
                            </div>
                          )}
                        </>
                    );
                  })()}
                </div>
              )}
              {activeTab === "errors" && (() => {
                const toolCalls = dialogContribution.contribution.tool_calls ?? [];
                const errors = toolCalls.filter(tc => tc.status === "error" || tc.error);
                if (errors.length === 0) {
                  return <p className="loom-text loom-text-muted loom-tool-calls-empty">No errors recorded for this contribution.</p>;
                }
                return (
                  <div className="loom-tool-calls-panel">
                    <div className="loom-tool-calls-list">
                      {errors.map((tc, i) => (
                        <div key={tc.callID ?? i} className="loom-tool-call-item">
                          <div className="loom-tool-call-header">
                            <span className="loom-tool-call-name">{tc.attempted_tool ? `attempted ${tc.attempted_tool}` : tc.tool}</span>
                            {tc.title && <span className="loom-tool-call-title">{tc.title}</span>}
                            <span className="loom-tool-call-status loom-tool-call-error">
                              {tc.status === "error" ? "error" : tc.status ?? "unknown"}
                            </span>
                          </div>
                          {tc.input && (
                            <pre className="loom-tool-call-input">{typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input, null, 2)}</pre>
                          )}
                          {tc.error && (
                            <pre className="loom-tool-call-error-output">{typeof tc.error === "string" ? tc.error : JSON.stringify(tc.error, null, 2)}</pre>
                          )}
                          {tc.output && !tc.error && (
                            <pre className="loom-tool-call-output">{typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output, null, 2)}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </ContentDialog>
      <ContentDialog
        open={dialogOrchestratorGroup !== null}
        onClose={() => setDialogOrchestratorGroup(null)}
        title={(() => {
          if (!dialogOrchestratorGroup) return "";
          const meta = ORCHESTRATOR_TYPE_META[(dialogOrchestratorGroup.query ?? dialogOrchestratorGroup.response)?.type] || { label: "Orchestrator" };
          return meta.label;
        })()}
        className="loom-dialog-type-orchestrator"
      >
        {dialogOrchestratorGroup && (
          <div className="loom-dialog-tabs-container">
            <div className="loom-dialog-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={orchestratorActiveTab === "prompt"}
                className={cn("loom-dialog-tab", orchestratorActiveTab === "prompt" && "loom-dialog-tab-active")}
                onClick={() => setOrchestratorActiveTab("prompt")}
              >
                Prompt
              </button>
              <button
                role="tab"
                aria-selected={orchestratorActiveTab === "response"}
                className={cn("loom-dialog-tab", orchestratorActiveTab === "response" && "loom-dialog-tab-active")}
                onClick={() => setOrchestratorActiveTab("response")}
              >
                Response
              </button>
            </div>
            <div className="loom-dialog-tab-panel" role="tabpanel">
              {orchestratorActiveTab === "prompt" && dialogOrchestratorGroup.query && (
                <>
                  <pre className="loom-orchestrator-full-content">{dialogOrchestratorGroup.query.content}</pre>
                  <div className="loom-dialog-footer">
                    <button
                      className="pure-button pure-button-small loom-copy-btn"
                      onClick={() => navigator.clipboard.writeText(dialogOrchestratorGroup.query?.content ?? "")}
                    >
                      Copy text
                    </button>
                  </div>
                </>
              )}
              {orchestratorActiveTab === "prompt" && !dialogOrchestratorGroup.query && (
                <p className="loom-text loom-text-muted">No prompt recorded for this exchange.</p>
              )}
              {orchestratorActiveTab === "response" && dialogOrchestratorGroup.response && (
                <>
                  <pre className="loom-orchestrator-full-content">{dialogOrchestratorGroup.response.content}</pre>
                  <div className="loom-dialog-footer">
                    <button
                      className="pure-button pure-button-small loom-copy-btn"
                      onClick={() => navigator.clipboard.writeText(dialogOrchestratorGroup.response?.content ?? "")}
                    >
                      Copy text
                    </button>
                  </div>
                </>
              )}
              {orchestratorActiveTab === "response" && !dialogOrchestratorGroup.response && (
                <p className="loom-text loom-text-muted">No response recorded for this exchange.</p>
              )}
            </div>
          </div>
        )}
      </ContentDialog>
    </div>
  );
}

const TimelineTab = memo(TimelineTabBase);
export { TimelineTab };