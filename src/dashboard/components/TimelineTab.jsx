import { useRef, useMemo, useCallback, useState, useEffect, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, QueryResponseRow, EvidenceResponseRow, SummonedResponseRow, VoteResponseRow, VoteTallyRow, OrchestratorItem, ORCHESTRATOR_TYPE_META, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { LoadingSkeleton } from "./Skeleton.jsx";
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
const VOTE_TALLY_HEIGHT = 100;
const ORCHESTRATOR_ITEM_HEIGHT = 80;

const ROUND_SUMMARY_HEIGHT = 88;

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
  if (item.type === "evidence_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "summoned_response") return SUMMONED_RESPONSE_HEIGHT;
  if (item.type === "vote_response") return VOTE_RESPONSE_HEIGHT;
  if (item.type === "vote_tally") return VOTE_TALLY_HEIGHT;
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
        />
      </div>
    );
  }
  if (item.type === "summoned_response") {
    return (
      <div style={style} className="loom-vrow loom-vrow-summoned-response">
        <SummonedResponseRow
          summonedResponse={item.summonedResponse}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
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
        />
      </div>
    );
  }
  if (item.type === "vote_tally") {
    return (
      <div style={style} className="loom-vrow loom-vrow-vote-tally">
        <VoteTallyRow
          tally={item.tally}
          participantName={participantName}
          onDialogOpen={onDialogOpen}
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
    if (activeTab !== "context" || !dialogContribution || dialogContribution.contribution.prompt_context || fetchedContext || contextLoading) return;
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

  const flatItems = useMemo(() => {
    const items = [];
    for (const [round, contribs] of groupedContributions) {
      const isCollapsed = collapsedRounds.includes(round);
      const roundErrors = agentErrors.filter((e) => e.round === round);
      const showExtensionMarker = extensions.length > 0 && round === (maxRounds ? maxRounds - (extensions.length * 4) : 0) + 1;

      items.push({
        type: "header",
        round,
        isCollapsed,
        isActive: round === activeRound,
        contribsCount: contribs.length,
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
        const voteTallies = [];
        const consumedTallyIds = new Set();

        for (const c of contribs) {
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
            }
          } else if (c.type === "evidence_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!evidenceResponsesByTarget.has(targetId)) evidenceResponsesByTarget.set(targetId, []);
              evidenceResponsesByTarget.get(targetId).push(c);
            }
          } else if (c.type === "summoned_response") {
            summonedResponses.push(c);
          } else if (c.type === "vote_response") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!votesByTarget.has(targetId)) votesByTarget.set(targetId, []);
              votesByTarget.get(targetId).push(c);
            }
          } else if (c.type === "vote_tally") {
            voteTallies.push(c);
          } else {
            const key = c.participant_id;
            if (!regularByAgent.has(key)) regularByAgent.set(key, []);
            regularByAgent.get(key).push(c);
          }
        }

        for (const [agentId, agentContribs] of regularByAgent) {
          items.push({
            type: "agent_turn",
            agentId,
            round,
            contributions: agentContribs,
          });

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
              items.push({
                type: "query_response",
                queryResponse: qr,
                round,
              });
            }
          }
        }

        for (const [, evidenceResponses] of evidenceResponsesByTarget) {
          for (const er of evidenceResponses) {
            if (!consumedEvidenceIds.has(er.id)) {
              items.push({
                type: "evidence_response",
                evidenceResponse: er,
                round,
              });
            }
          }
        }

        for (const sr of summonedResponses) {
          items.push({
            type: "summoned_response",
            summonedResponse: sr,
            round,
          });
        }

        for (const [, votes] of votesByTarget) {
          for (const v of votes) {
            if (!consumedVoteIds.has(v.id)) {
              items.push({
                type: "vote_response",
                voteResponse: v,
                round,
              });
            }
          }
        }

        for (const tally of voteTallies) {
          if (!consumedTallyIds.has(tally.id)) {
            items.push({
              type: "vote_tally",
              tally,
              round,
            });
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

        if (round === activeRound && isWeaving) {
          for (const c of contribs) {
            if ((c.type === "challenge" || c.type === "dissent") && !reflectionsByTarget.has(c.id)) {
              const triggerAgentName = participantName(c.participant_id);
              for (const p of reflectingParticipants) {
                if (p.id !== c.participant_id) {
                  items.push({
                    type: "thinking_reflection",
                    triggerContributionId: c.id,
                    triggerType: c.type,
                    triggerAgentName,
                    reflectorName: p.name,
                    round,
                  });
                }
              }
            }
          }

          // Thinking placeholders for active queries
          for (const qp of queryingParticipants) {
            const hasResponded = contribs.some(
              (c) => c.type === "query_response" && c.participant_id === qp.id
            );
            if (!hasResponded) {
              items.push({
                type: "thinking_query",
                queriedAgentName: qp.name,
                round,
              });
            }
          }

          // Thinking placeholders for active evidence requests
          for (const ep of evidenceParticipants) {
            const hasResponded = contribs.some(
              (c) => c.type === "evidence_response" && c.participant_id === ep.id
            );
            if (!hasResponded) {
              items.push({
                type: "thinking_evidence",
                evidenceAgentName: ep.name,
                round,
              });
            }
          }

          // Thinking placeholders for active summons
          for (const sp of summoningParticipants) {
            const hasResponded = contribs.some(
              (c) => c.type === "summoned_response" && c.participant_id === sp.id
            );
            if (!hasResponded) {
              items.push({
                type: "thinking_summon",
                summonName: sp.name,
                round,
              });
            }
          }
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
    return items;
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
      {groupedContributions.length === 0 && contributions.length === 0 && isWeaving && (
        <LoadingSkeleton rounds={2} />
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
        : dialogContribution.isVoteTally
        ? `Vote tally by ${dialogContribution.participantName}`
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
        : dialogContribution.isVoteTally
        ? "loom-dialog-type-vote_tally"
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
                              <pre className="loom-tool-call-input">{tc.input}</pre>
                            )}
                            {tc.output && (
                              <pre className="loom-tool-call-output">{tc.output}</pre>
                            )}
                            {tc.error && (
                              <pre className="loom-tool-call-error-output">{typeof tc.error === "string" ? tc.error : JSON.stringify(tc.error)}</pre>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="loom-text loom-text-muted loom-tool-calls-empty">No tool calls were recorded for this contribution.</p>
                  )}
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
                    const ctx = dialogContribution.contribution.prompt_context ?? fetchedContext;
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