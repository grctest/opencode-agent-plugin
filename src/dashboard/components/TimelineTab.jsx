import { useRef, useMemo, useCallback, useState, useEffect, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, QueryResponseRow, EvidenceResponseRow, SummonedResponseRow, VoteResponseRow, OrchestratorItem, ORCHESTRATOR_TYPE_META, ContentDialog, renderMarkdown } from "./Cards.jsx";

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

function pairOrchestratorMessages(messages) {
  const groups = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user") {
      const response = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
      groups.push({ query: msg, response });
      i += response ? 2 : 1;
    } else {
      groups.push({ query: null, response: msg });
      i += 1;
    }
  }
  return groups;
}

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
          <button className="loom-round-header" onClick={() => onToggleCollapse(item.round)}>
            <span className="loom-round-toggle">{item.isCollapsed ? "▶" : "▼"}</span>
            <span className="loom-round-title">Round {item.round}</span>
            <span className="loom-round-count">{item.contribsCount} contribution{item.contribsCount !== 1 ? "s" : ""}</span>
            {item.errorsCount > 0 && (
              <span className="loom-round-errors"><span aria-hidden="true">⚠</span> {item.errorsCount}</span>
            )}
          </button>
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

    // Per-round segment cache (audit 11 PF2)
  const roundSegmentCacheRef = useRef(new Map());
const flatItems = useMemo(() => {
    // Per-round segment cache (audit 11 PF2): an incremental contribution only
    // recomputes its own round's items — the other rounds come from cache.
    const out = [];
    const segCache = roundSegmentCacheRef.current;
    const liveRounds = new Set(groupedContributions.map(([r]) => r));
    for (const key of [...segCache.keys()]) {
      if (!liveRounds.has(key)) segCache.delete(key);
    }
    for (const [round, contribs] of groupedContributions) {
      const isCollapsed0 = collapsedRounds.includes(round);
      const roundErrors0 = agentErrors.filter((e) => e.round === round);
      const showExtensionMarker0 = extensions.length > 0 && round === (maxRounds ? maxRounds - (extensions.length * 4) : 0) + 1;
      const liveSig = [
        thinkingParticipants.map((p) => p.id).join(","),
        reflectingParticipants.map((p) => p.id).join(","),
        queryingParticipants.map((p) => p.id).join(","),
        evidenceParticipants.map((p) => p.id).join(","),
        summoningParticipants.map((p) => p.id).join(","),
      ].join("|");
      const sig = [
        round,
        contribs.length,
        contribs.length ? contribs[contribs.length - 1]?.id ?? null : null,
        isCollapsed0,
        round === activeRound,
        roundErrors0.map((e) => e.id).join(","),
        turnRequests.length,
        turnRequests.length ? turnRequests[turnRequests.length - 1]?.id ?? null : null,
        showExtensionMarker0,
        liveSig,
        orchestratorMessages?.length ?? 0,
        roundSummaries[round] ?? "",
      ].join("~");

      const cachedSeg = segCache.get(round);
      if (cachedSeg && cachedSeg.sig === sig) {
        out.push(...cachedSeg.items);
        continue;
      }

      const segItems = [];
      {
        const items = segItems;
        const isCollapsed = isCollapsed0;
        const roundErrors = roundErrors0;
        const showExtensionMarker = showExtensionMarker0;

        const visibleContribsCount = contribs.filter(c => c.type !== "vote_tally").length;
        items.push({
        type: "header",
        round,
        isCollapsed,
        isActive: round === activeRound,
        contribsCount: visibleContribsCount,
        errorsCount: roundErrors.length,
        showExtensionMarker,
      });

      if (!isCollapsed) {
        const roundTurnRequests = turnRequests.filter((tr) => {
          if (contribs.length === 0) return false;
          const contribTimes = contribs.map((c) => c.created_at);
          const roundStart = Math.min(...contribTimes);
          return tr.created_at >= roundStart;
        });

        const regularByAgent = new Map();
        const reflectionsByTarget = new Map();
        const consumedReflectionIds = new Set();
        const queryResponsesByTarget = new Map();
        const consumedQueryIds = new Set();
        const evidenceResponsesByTarget = new Map();
        const consumedEvidenceIds = new Set();
        const summonedResponses = [];
        const consumedSummonIds = new Set();
        const votesByTarget = new Map();
        const consumedVoteIds = new Set();
        // Batch grouping for inline real tool use where targets_which is null but batch_id links to invoker
        const queryByBatch = new Map();
        const evidenceByBatch = new Map();
        const votesByBatch = new Map();
        const summonByBatch = new Map();

        for (const c of contribs) {
          if (c.type === "vote_tally") {
            // Tally intentionally excluded from timeline (invoker interprets votes inline)
            continue;
          }
          if (c.type === "reflection") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!reflectionsByTarget.has(targetId)) reflectionsByTarget.set(targetId, []);
              reflectionsByTarget.get(targetId).push(c);
            }
          } else if (c.type === "query_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
              queryResponsesByTarget.get(targetId).push(c);
            } else if (c.batch_id) {
              if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
              queryByBatch.get(c.batch_id).push(c);
            }
          } else if (c.type === "perspective_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
              queryResponsesByTarget.get(targetId).push(c);
            } else if (c.batch_id) {
              if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
              queryByBatch.get(c.batch_id).push(c);
            }
          } else if (c.type === "critique_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!queryResponsesByTarget.has(targetId)) queryResponsesByTarget.set(targetId, []);
              queryResponsesByTarget.get(targetId).push(c);
            } else if (c.batch_id) {
              if (!queryByBatch.has(c.batch_id)) queryByBatch.set(c.batch_id, []);
              queryByBatch.get(c.batch_id).push(c);
            }
          } else if (c.type === "evidence_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!evidenceResponsesByTarget.has(targetId)) evidenceResponsesByTarget.set(targetId, []);
              evidenceResponsesByTarget.get(targetId).push(c);
            } else if (c.batch_id) {
              if (!evidenceByBatch.has(c.batch_id)) evidenceByBatch.set(c.batch_id, []);
              evidenceByBatch.get(c.batch_id).push(c);
            }
          } else if (c.type === "summoned_response") {
            if (c.batch_id) {
              if (!summonByBatch.has(c.batch_id)) summonByBatch.set(c.batch_id, []);
              summonByBatch.get(c.batch_id).push(c);
            } else {
              summonedResponses.push(c);
            }
          } else if (c.type === "vote_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!votesByTarget.has(targetId)) votesByTarget.set(targetId, []);
              votesByTarget.get(targetId).push(c);
            } else if (c.batch_id) {
              if (!votesByBatch.has(c.batch_id)) votesByBatch.set(c.batch_id, []);
              votesByBatch.get(c.batch_id).push(c);
            }
          } else {
            const key = c.participant_id;
            if (!regularByAgent.has(key)) regularByAgent.set(key, []);
            regularByAgent.get(key).push(c);
          }
        }

        // Map batch_id -> invoker participant_id for quick lookup
        const batchToInvoker = new Map();
        for (const [, contribs] of regularByAgent) {
          for (const c of contribs) if (c.batch_id) batchToInvoker.set(c.batch_id, c.participant_id);
        }
        // Helper to find invoker for an orphan response (query/evidence/vote/summon)
        const findInvokerIdForResponse = (resp) => {
          if (resp.batch_id && batchToInvoker.has(resp.batch_id)) {
            const v = batchToInvoker.get(resp.batch_id);
            if (v && v !== "caller" && v !== "unknown") return v;
          }
          const srcId = resp.prompt_context?.source_participant_id ?? resp.prompt_context?.sourceParticipantId ?? resp.prompt_context?.source_participant_name;
          if (srcId && srcId !== "caller" && srcId !== "unknown" && srcId !== "Unknown") {
            // prompt_context may store name instead of id for older data; try to resolve name to id via participants
            if (srcId.length < 30 && !srcId.includes(" ")) {
              // treat as id
              return srcId;
            }
          }
          if (resp.prompt_context?.source_participant_id && resp.prompt_context.source_participant_id !== "caller" && resp.prompt_context.source_participant_id !== "unknown") return resp.prompt_context.source_participant_id;
          if (resp.prompt_context?.sourceParticipantId && resp.prompt_context.sourceParticipantId !== "caller" && resp.prompt_context.sourceParticipantId !== "unknown") return resp.prompt_context.sourceParticipantId;
          // Scan tool calls on regular contributions that target this responder
          let best = null;
          let bestId = -1;
          for (const [, rContribs] of regularByAgent) {
            for (const c of rContribs) {
              if (c.id >= resp.id) continue;
              const calls = c.tool_calls ?? [];
              for (const tc of calls) {
                const tool = tc.tool ?? tc.attempted_tool;
                if (!tool) continue;
                try {
                  const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
                  if (tool === "loom_query" || tool === "loom_evidence") {
                    const queries = input.queries ?? (Array.isArray(input.targets) ? input.targets.map(t => ({target: t})) : []);
                    // also handle single question form {target, question} legacy
                    const targets = queries.map(q => q.target ?? q.targetId).filter(Boolean);
                    if (targets.includes(resp.participant_id)) {
                      if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                    }
                  } else if (tool === "loom_vote") {
                    if (resp.type === "vote_response" && resp.round === c.round) {
                      if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                    }
                  } else if (tool === "loom_summon") {
                    if (resp.type === "summoned_response" && resp.round === c.round) {
                      if (c.id > bestId) { bestId = c.id; best = c.participant_id; }
                    }
                  }
                } catch {}
              }
            }
          }
          return best;
        };

        // Order invokers chronologically by earliest contribution id/timestamp
        const sortedAgentEntries = [...regularByAgent.entries()].sort((a, b) => {
          const aFirst = a[1][0];
          const bFirst = b[1][0];
          const aId = aFirst?.id ?? 0;
          const bId = bFirst?.id ?? 0;
          if (aId !== bId) return aId - bId;
          const aTime = aFirst?.created_at ? new Date(aFirst.created_at).getTime() : 0;
          const bTime = bFirst?.created_at ? new Date(bFirst.created_at).getTime() : 0;
          return aTime - bTime;
        });
        // Thinking placeholder for agents yet to speak — shown above sub-agent rows (per user request)
        if (round === activeRound && isWeaving && thinkingParticipants.length > 0) {
          const thinkingIds = new Set(thinkingParticipants.map((p) => p.id));
          const agentIdsInRound = new Set(regularByAgent.keys());
          const pendingThinking = thinkingParticipants.filter((p) => !agentIdsInRound.has(p.id));
          for (const p of pendingThinking) {
            items.push({
              type: "thinking_turn",
              participant: p,
              round,
            });
          }
        }
        for (const [agentId, agentContribs] of sortedAgentEntries) {
          items.push({
            type: "agent_turn",
            agentId,
            round,
            contributions: agentContribs,
          });

          // Loom invocations — aesthetic indented rows under the invoker, mirroring reflections
          for (const c of agentContribs) {
            const loomCalls = (c.tool_calls ?? []).filter(tc => (tc.tool ?? tc.attempted_tool ?? "").startsWith("loom_"));
            for (const tc of loomCalls) {
              items.push({
                type: "loom_invocation",
                invocation: tc,
                sourceContributionId: c.id,
                sourceParticipantId: c.participant_id,
                round,
              });
            }
          }
          // Per-invoker thinking placeholders — shown ABOVE this invoker's sub-agent responses
          if (round === activeRound && isWeaving) {
            for (const c of agentContribs) {
              if ((c.type === "challenge" || c.type === "dissent") && !reflectionsByTarget.has(c.id)) {
                for (const p of reflectingParticipants) {
                  if (p.id !== c.participant_id) {
                    items.push({
                      type: "thinking_reflection",
                      triggerContributionId: c.id,
                      triggerType: c.type,
                      triggerAgentName: participantName(c.participant_id),
                      reflectorName: p.name,
                      round,
                    });
                  }
                }
              }
            }
            const queriedTargets = new Set();
            const evidenceTargets = new Set();
            const hasSummonCall = agentContribs.some(agc => (agc.tool_calls ?? []).some(tc => (tc.tool ?? tc.attempted_tool) === "loom_summon"));
            for (const c of agentContribs) {
              for (const tc of (c.tool_calls ?? [])) {
                const tool = tc.tool ?? tc.attempted_tool;
                if (!tool) continue;
                try {
                  const input = typeof tc.input === "string" ? JSON.parse(tc.input) : tc.input;
                  if (tool === "loom_query" || tool === "loom_evidence") {
                    const queries = input.queries ?? (Array.isArray(input.targets) ? input.targets.map(t => ({ target: t })) : []);
                    const qs = Array.isArray(queries) ? queries : [];
                    for (const q of qs) {
                      const tid = q.target ?? q.targetId;
                      if (tid) {
                        if (q.mode === "evidence" || tool === "loom_evidence") { evidenceTargets.add(tid); queriedTargets.delete(tid); }
                        else queriedTargets.add(tid);
                      }
                    }
                    if (input.target && !input.queries) {
                      const tid = input.target;
                      if (tool === "loom_evidence" || input.mode === "evidence") evidenceTargets.add(tid);
                      else queriedTargets.add(tid);
                    }
                  }
                } catch {}
              }
            }
            for (const qp of queryingParticipants) {
              if (!queriedTargets.has(qp.id)) continue;
              const hasResponded = contribs.some(c => {
                if (!["query_response","perspective_response","critique_response"].includes(c.type)) return false;
                if (c.participant_id !== qp.id) return false;
                const invoker = findInvokerIdForResponse(c);
                return invoker === agentId;
              });
              if (!hasResponded) {
                items.push({ type: "thinking_query", queriedAgentName: qp.name, round, invokerId: agentId });
              }
            }
            for (const ep of evidenceParticipants) {
              if (!evidenceTargets.has(ep.id)) continue;
              const hasResponded = contribs.some(c => c.type === "evidence_response" && c.participant_id === ep.id && findInvokerIdForResponse(c) === agentId);
              if (!hasResponded) {
                items.push({ type: "thinking_evidence", evidenceAgentName: ep.name, round, invokerId: agentId });
              }
            }
            if (hasSummonCall) {
              const hasResponded = contribs.some(c => c.type === "summoned_response" && findInvokerIdForResponse(c) === agentId);
              if (!hasResponded && summoningParticipants.length > 0) {
                for (const sp of summoningParticipants) {
                  items.push({ type: "thinking_summon", summonName: sp.name, round, invokerId: agentId });
                  break;
                }
              }
            }
          }

          for (const c of agentContribs) {
            if (reflectionsByTarget.has(c.id)) {
              for (const r of reflectionsByTarget.get(c.id)) {
                consumedReflectionIds.add(r.id);
                items.push({
                  type: "reflection",
                  reflection: r,
                  round,
                });
              }
            }
            if (queryResponsesByTarget.has(c.id)) {
              for (const qr of queryResponsesByTarget.get(c.id)) {
                consumedQueryIds.add(qr.id);
                items.push({
                  type: "query_response",
                  queryResponse: qr,
                  round,
                });
              }
            }
            if (evidenceResponsesByTarget.has(c.id)) {
              for (const er of evidenceResponsesByTarget.get(c.id)) {
                consumedEvidenceIds.add(er.id);
                items.push({
                  type: "evidence_response",
                  evidenceResponse: er,
                  round,
                });
              }
            }
            if (votesByTarget.has(c.id)) {
              for (const v of votesByTarget.get(c.id)) {
                consumedVoteIds.add(v.id);
                items.push({
                  type: "vote_response",
                  voteResponse: v,
                  round,
                });
              }
            }
            // Batch-linked inline responses (real tool use): batch_id groups when targets_which is null
            if (c.batch_id) {
              if (queryByBatch.has(c.batch_id)) {
                for (const qr of queryByBatch.get(c.batch_id)) {
                  if (!consumedQueryIds.has(qr.id)) {
                    consumedQueryIds.add(qr.id);
                    items.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: c.participant_id });
                  }
                }
              }
              if (evidenceByBatch.has(c.batch_id)) {
                for (const er of evidenceByBatch.get(c.batch_id)) {
                  if (!consumedEvidenceIds.has(er.id)) {
                    consumedEvidenceIds.add(er.id);
                    items.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: c.participant_id });
                  }
                }
              }
              if (votesByBatch.has(c.batch_id)) {
                for (const v of votesByBatch.get(c.batch_id)) {
                  if (!consumedVoteIds.has(v.id)) {
                    consumedVoteIds.add(v.id);
                    items.push({ type: "vote_response", voteResponse: v, round, invokerId: c.participant_id });
                  }
                }
              }
              if (summonByBatch.has(c.batch_id)) {
                for (const sr of summonByBatch.get(c.batch_id)) {
                  if (!consumedSummonIds.has(sr.id)) {
                    consumedSummonIds.add(sr.id);
                    items.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: c.participant_id });
                  }
                }
              }
            }
          }
          // Attach any remaining orphan responses that belong to this invoker via batch/prompt/tool-call fallback
          // Query (including perspective/critique)
          for (const [, list] of queryResponsesByTarget) {
            for (const qr of list) {
              if (consumedQueryIds.has(qr.id)) continue;
              const invoker = findInvokerIdForResponse(qr);
              if (invoker === agentId) {
                consumedQueryIds.add(qr.id);
                items.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: agentId });
              }
            }
          }
          for (const [bid, list] of queryByBatch) {
            for (const qr of list) {
              if (consumedQueryIds.has(qr.id)) continue;
              const invoker = findInvokerIdForResponse(qr);
              if (invoker === agentId) {
                consumedQueryIds.add(qr.id);
                items.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: agentId });
              }
            }
          }
          for (const [, list] of evidenceResponsesByTarget) {
            for (const er of list) {
              if (consumedEvidenceIds.has(er.id)) continue;
              const invoker = findInvokerIdForResponse(er);
              if (invoker === agentId) {
                consumedEvidenceIds.add(er.id);
                items.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: agentId });
              }
            }
          }
          for (const [bid, list] of evidenceByBatch) {
            for (const er of list) {
              if (consumedEvidenceIds.has(er.id)) continue;
              const invoker = findInvokerIdForResponse(er);
              if (invoker === agentId) {
                consumedEvidenceIds.add(er.id);
                items.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: agentId });
              }
            }
          }
          for (const [, list] of votesByTarget) {
            for (const v of list) {
              if (consumedVoteIds.has(v.id)) continue;
              const invoker = findInvokerIdForResponse(v);
              if (invoker === agentId) {
                consumedVoteIds.add(v.id);
                items.push({ type: "vote_response", voteResponse: v, round, invokerId: agentId });
              }
            }
          }
          for (const [bid, list] of votesByBatch) {
            for (const v of list) {
              if (consumedVoteIds.has(v.id)) continue;
              const invoker = findInvokerIdForResponse(v);
              if (invoker === agentId) {
                consumedVoteIds.add(v.id);
                items.push({ type: "vote_response", voteResponse: v, round, invokerId: agentId });
              }
            }
          }
          for (const [bid, list] of summonByBatch) {
            for (const sr of list) {
              if (consumedSummonIds.has(sr.id)) continue;
              const invoker = findInvokerIdForResponse(sr);
              if (invoker === agentId) {
                consumedSummonIds.add(sr.id);
                items.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: agentId });
              }
            }
          }
          for (const sr of summonedResponses) {
            if (consumedSummonIds.has(sr.id)) continue;
            const invoker = findInvokerIdForResponse(sr);
            if (invoker === agentId) {
              consumedSummonIds.add(sr.id);
              items.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: agentId });
            }
          }
          for (const [, list] of reflectionsByTarget) {
            for (const r of list) {
              if (consumedReflectionIds.has(r.id)) continue;
              const target = contribs.find(c => c.id === r.targets_which);
              if (target && target.participant_id === agentId) {
                consumedReflectionIds.add(r.id);
                items.push({ type: "reflection", reflection: r, round });
              }
            }
          }
        }

        for (const [, reflections] of reflectionsByTarget) {
          for (const r of reflections) {
            if (!consumedReflectionIds.has(r.id)) {
              items.push({
                type: "reflection",
                reflection: r,
                round,
              });
            }
          }
        }

        for (const [, queryResponses] of queryResponsesByTarget) {
          for (const qr of queryResponses) {
            if (!consumedQueryIds.has(qr.id)) {
              const invoker = findInvokerIdForResponse(qr);
              items.push({
                type: qr.type,
                queryResponse: qr,
                perspectiveResponse: qr,
                critiqueResponse: qr,
                round,
                invokerId: invoker,
              });
            }
          }
        }

        for (const [, evidenceResponses] of evidenceResponsesByTarget) {
          for (const er of evidenceResponses) {
            if (!consumedEvidenceIds.has(er.id)) {
              const invoker = findInvokerIdForResponse(er);
              items.push({
                type: "evidence_response",
                evidenceResponse: er,
                round,
                invokerId: invoker,
              });
            }
          }
        }

        // Orphan summoned responses without batch_id (fallback)
        for (const sr of summonedResponses) {
          if (!consumedSummonIds.has(sr.id)) {
            const invoker = findInvokerIdForResponse(sr);
            items.push({
              type: "summoned_response",
              summonedResponse: sr,
              round,
              invokerId: invoker,
            });
          }
        }
        // Orphan batch-linked summoned responses (invoker had no regular contribution — fallback)
        for (const [, srs] of summonByBatch) {
          for (const sr of srs) {
            if (!consumedSummonIds.has(sr.id)) {
              const invoker = findInvokerIdForResponse(sr);
              items.push({ type: "summoned_response", summonedResponse: sr, round, invokerId: invoker });
              consumedSummonIds.add(sr.id);
            }
          }
        }

        for (const [, votes] of votesByTarget) {
          for (const v of votes) {
            if (!consumedVoteIds.has(v.id)) {
              const invoker = findInvokerIdForResponse(v);
              items.push({
                type: "vote_response",
                voteResponse: v,
                round,
                invokerId: invoker,
              });
            }
          }
        }
        // Orphan batch-linked votes (if invoker had no regular contribution but vote still exists — fallback)
        for (const [, votes] of votesByBatch) {
          for (const v of votes) {
            if (!consumedVoteIds.has(v.id)) {
              const invoker = findInvokerIdForResponse(v);
              items.push({ type: "vote_response", voteResponse: v, round, invokerId: invoker });
              consumedVoteIds.add(v.id);
            }
          }
        }
        for (const [, qrs] of queryByBatch) {
          for (const qr of qrs) {
            if (!consumedQueryIds.has(qr.id)) {
              const invoker = findInvokerIdForResponse(qr);
              items.push({ type: qr.type, queryResponse: qr, perspectiveResponse: qr, critiqueResponse: qr, round, invokerId: invoker });
              consumedQueryIds.add(qr.id);
            }
          }
        }
        for (const [, ers] of evidenceByBatch) {
          for (const er of ers) {
            if (!consumedEvidenceIds.has(er.id)) {
              const invoker = findInvokerIdForResponse(er);
              items.push({ type: "evidence_response", evidenceResponse: er, round, invokerId: invoker });
              consumedEvidenceIds.add(er.id);
            }
          }
        }

        for (const tr of roundTurnRequests) {
          items.push({ type: "turn_request", turnRequest: tr });
        }

        // Add model fallback events as timeline items
        for (const err of roundErrors) {
          if (err.error_type === "model_fallback") {
            items.push({ type: "model_fallback", error: err, round });
          }
        }

        const roundOrchestratorMessages = orchestratorMessages
          ? orchestratorMessages
              .filter((m) => m.round === round && (m.role === "user" || m.role === "assistant"))
              .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
          : [];

        const orchestratorGroups = pairOrchestratorMessages(roundOrchestratorMessages);

        for (const og of orchestratorGroups) {
          items.push({ type: "orchestrator", group: og });
        }

        const roundSummary = roundSummaries[round];
        const summaryMsgs = roundOrchestratorMessages.filter((m) => m.type === "summary");
        // Only render the rounds-table summary when no LLM summary exchange
        // was recorded — otherwise the grey OrchestratorItem already shows it.
        if (roundSummary && summaryMsgs.length === 0) {
          items.push({
            type: "round_summary",
            round,
            summary: roundSummary,
            group: {
              query: null,
              response: { type: "summary", role: "assistant", content: roundSummary, created_at: null },
            },
          });
        }
      }
      }
      segCache.set(round, { sig, items: segItems });
      out.push(...segItems);
    }
    return out;
  }, [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving, thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants, participantName, orchestratorMessages, roundSummaries]);

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
      {groupedContributions.length === 0 && contributions.length === 0 && !isWeaving && (
        <div className="loom-empty-state">
          <div className="loom-empty-icon" aria-hidden="true">🧵</div>
          <p className="loom-text loom-text-muted">Waiting for agents to respond...</p>
          <p className="loom-text-xs loom-text-muted">Contributions will appear here in real-time</p>
        </div>
      )}
      {flatItems.length > 0 && (
        <div className="loom-timeline-list">
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