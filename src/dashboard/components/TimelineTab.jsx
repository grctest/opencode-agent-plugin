import { useRef, useMemo, useCallback, useState, memo } from "react";
import { cn, relativeTime } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ReflectionRow, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { LoadingSkeleton } from "./Skeleton.jsx";
import { List } from "react-window";

const THINKING_TURN_HEIGHT = 56;
const THINKING_REFLECTION_HEIGHT = 56;

const HEADER_HEIGHT = 48;
const CONTRIBUTION_HEIGHT = 56;
const INTERJECTION_HEIGHT = 72;
const EXTENSION_MARKER_HEIGHT = 32;
const REFLECTION_HEIGHT = 80;

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "turn_request") return INTERJECTION_HEIGHT;
  if (item.type === "reflection") return REFLECTION_HEIGHT;
  if (item.type === "thinking_turn") return THINKING_TURN_HEIGHT;
  if (item.type === "thinking_reflection") return THINKING_REFLECTION_HEIGHT;
  if (item.type === "agent_turn") {
    return 115;
  }
  return 115;
}

const TimelineRow = memo(({ index, style, items, onToggleCollapse, participantName, onDialogOpen, contributions }) => {
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
  if (item.type === "contribution") {
    return (
      <div style={style} className="loom-vrow">
        <ContributionItem contribution={item.contribution} participantName={participantName(item.contribution.participant_id)} onDialogOpen={onDialogOpen} />
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
  collapsedRounds,
  onToggleCollapse,
  agentErrors,
  participantName,
  turnRequests,
  extensions,
  activeRound,
  maxRounds,
}) => {
  const listRef = useRef(null);
  const [dialogContribution, setDialogContribution] = useState(null);
  const [activeTab, setActiveTab] = useState("response");

  const handleDialogOpen = useCallback((data) => {
    setDialogContribution(data);
    setActiveTab("response");
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

        for (const c of contribs) {
          if (c.type === "reflection") {
            const targetId = c.targets_which;
            if (targetId != null) {
              if (!reflectionsByTarget.has(targetId)) reflectionsByTarget.set(targetId, []);
              reflectionsByTarget.get(targetId).push(c);
            }
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

        for (const tr of roundTurnRequests) {
          items.push({ type: "turn_request", turnRequest: tr });
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
        }
      }
    }
    return items;
  }, [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds, isWeaving, thinkingParticipants, reflectingParticipants, participantName]);

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
    contributions,
  }), [flatItems, onToggleCollapse, participantName, contributions, handleDialogOpen]);

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
          : `${dialogContribution.participantName} — ${dialogContribution.contribution.type}`) : ""}
        className={dialogContribution ? (dialogContribution.isReflection
          ? "loom-dialog-type-reflection"
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
                    </tbody>
                  </table>
                </div>
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