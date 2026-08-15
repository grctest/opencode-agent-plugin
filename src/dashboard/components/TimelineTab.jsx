import { useRef, useMemo, useCallback, useState, memo } from "react";
import { cn } from "../utils.js";
import { ContributionItem, TurnRequestItem, ThinkingCard, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { LoadingSkeleton } from "./Skeleton.jsx";
import { List } from "react-window";

const HEADER_HEIGHT = 48;
const CONTRIBUTION_HEIGHT = 56;
const INTERJECTION_HEIGHT = 72;
const EXTENSION_MARKER_HEIGHT = 32;

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "turn_request") return INTERJECTION_HEIGHT;
  // Dynamic height: base height + ~16px per line of content (60 chars/line at ~0.875rem)
  const content = item.contribution?.content || "";
  const estimatedLines = Math.max(1, Math.ceil(content.length / 60));
  const contentHeight = estimatedLines * 16;
  return 115;
}

const TimelineRow = memo(({ index, style, items, onToggleCollapse, participantName, onDialogOpen }) => {
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
  filteredContributions,
  isWeaving,
  thinkingParticipants,
  activeType,
  onActiveTypeChange,
  contributionTypes,
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

        for (const c of contribs) {
          items.push({ type: "contribution", contribution: c });
        }
        for (const tr of roundTurnRequests) {
          items.push({ type: "turn_request", turnRequest: tr });
        }
      }
    }
    return items;
  }, [groupedContributions, collapsedRounds, activeRound, agentErrors, turnRequests, extensions, maxRounds]);

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
    onDialogOpen: setDialogContribution,
  }), [flatItems, onToggleCollapse, participantName]);

  return (
    <div className="loom-main-content">
      <div className="loom-timeline-filter">
        <div className="loom-flex loom-flex-wrap loom-gap-xs">
          <button
            className={cn(
              "pure-button loom-filter-btn",
              activeType === "" && "pure-button-active"
            )}
            onClick={() => onActiveTypeChange("")}
          >
            All
          </button>
          {contributionTypes.map((type) => (
            <button
              key={type}
              className={cn(
                "pure-button loom-filter-btn",
                activeType === type && "pure-button-active"
              )}
              onClick={() => onActiveTypeChange(type)}
            >
              {type}
            </button>
          ))}
        </div>
      </div>
      {isWeaving && thinkingParticipants.length > 0 && (
        <div className="loom-thinking-placeholders">
          {thinkingParticipants.map((p) => (
            <ThinkingCard key={p.id} participant={p} />
          ))}
        </div>
      )}
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
      {filteredContributions.length === 0 && contributions.length > 0 && (
        <div className="loom-empty-state">
          <p className="loom-text loom-text-muted">No contributions match your filter.</p>
        </div>
      )}
      <ContentDialog
        open={dialogContribution !== null}
        onClose={() => setDialogContribution(null)}
        title={dialogContribution ? `${dialogContribution.participantName} — ${dialogContribution.contribution.type}` : ""}
        className={dialogContribution ? `loom-dialog-type-${dialogContribution.contribution.type}` : ""}
      >
        {dialogContribution && (
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
      </ContentDialog>
    </div>
  );
}

const TimelineTab = memo(TimelineTabBase);
export { TimelineTab };