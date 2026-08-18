import { useRef, useMemo, useCallback, useState, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, QueryResponseRow, EvidenceResponseRow, SummonedResponseRow, OrchestratorItem, ORCHESTRATOR_TYPE_META, ContentDialog, renderMarkdown } from "./Cards.jsx";
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
const ORCHESTRATOR_ITEM_HEIGHT = 80;

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "turn_request") return INTERJECTION_HEIGHT;
  if (item.type === "reflection") return REFLECTION_HEIGHT;
  if (item.type === "query_response") return QUERY_RESPONSE_HEIGHT;
  if (item.type === "evidence_response") return EVIDENCE_RESPONSE_HEIGHT;
  if (item.type === "summoned_response") return SUMMONED_RESPONSE_HEIGHT;
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
}) => {
  const listRef = useRef(null);
  const [dialogContribution, setDialogContribution] = useState(null);
  const [dialogOrchestratorGroup, setDialogOrchestratorGroup] = useState(null);
  const [activeTab, setActiveTab] = useState("response");
  const [orchestratorActiveTab, setOrchestratorActiveTab] = useState("prompt");

  const handleDialogOpen = useCallback((data) => {
    setDialogContribution(data);
    setActiveTab("response");
  }, []);

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

        for (const tr of roundTurnRequests) {
          items.push({ type: "turn_request", turnRequest: tr });
        }

        const roundOrchestratorMessages = orchestratorMessages
          ? orchestratorMessages
              .filter((m) => m.round === round && (m.role === "user" || m.role === "assistant"))
              .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
          : [];

        const orchestratorGroups = [];
        let i = 0;
        while (i < roundOrchestratorMessages.length) {
          const msg = roundOrchestratorMessages[i];
          if (msg.role === "user") {
            const response = roundOrchestratorMessages[i + 1]?.role === "assistant" ? roundOrchestratorMessages[i + 1] : null;
            orchestratorGroups.push({ query: msg, response });
            i += response ? 2 : 1;
          } else {
            orchestratorGroups.push({ query: null, response: msg });
            i += 1;
          }
        }

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
      }
    }
    return items;
  }, [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving, thinkingParticipants, reflectingParticipants, queryingParticipants, evidenceParticipants, summoningParticipants, participantName, orchestratorMessages]);

  const rowHeightFn = useCallback((index, cellProps) => {
    const item = cellProps.items[index];
    return item ? getRowHeight(item) : CONTRIBUTION_HEIGHT;
  }, []);

  const listHeight = useMemo(() => {
    return Math.min(600, flatItems.reduce((sum, item) => sum + getRowHeight(item), 0));
  }, [flatItems]);

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
            overscanCount={3}
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
        : `${dialogContribution.participantName} — ${dialogContribution.contribution.type}`) : ""}
      className={dialogContribution ? (dialogContribution.isReflection
        ? "loom-dialog-type-reflection"
        : dialogContribution.isQueryResponse
        ? "loom-dialog-type-query_response"
        : dialogContribution.isEvidenceResponse
        ? "loom-dialog-type-evidence_response"
        : dialogContribution.isSummonedResponse
        ? "loom-dialog-type-summoned_response"
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
                      {dialogContribution.contribution.tool_calls.map((tc, i) => (
                        <div key={tc.callID ?? i} className="loom-tool-call-item">
                          <div className="loom-tool-call-header">
                            <span className="loom-tool-call-name">{tc.tool}</span>
                            {tc.title && <span className="loom-tool-call-title">{tc.title}</span>}
                            {tc.error ? (
                              <span className="loom-tool-call-status loom-tool-call-error">error</span>
                            ) : (
                              <span className="loom-tool-call-status loom-tool-call-success">ok</span>
                            )}
                          </div>
                          {tc.output && (
                            <pre className="loom-tool-call-output">{tc.output}</pre>
                          )}
                          {tc.error && (
                            <pre className="loom-tool-call-error-output">{tc.error}</pre>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="loom-text loom-text-muted loom-tool-calls-empty">No tools were used for this contribution.</p>
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
                  {dialogContribution.contribution.prompt_context ? (
                    (() => {
                      const ctx = dialogContribution.contribution.prompt_context;
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
                    })()
                  ) : (
                    <p className="loom-text loom-text-muted loom-context-empty">
                      No prompt context captured for this contribution.
                    </p>
                  )}
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