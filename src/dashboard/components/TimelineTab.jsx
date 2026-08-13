import { useRef, useMemo, useCallback, useState, memo } from "react";
import { cn } from "../utils.js";
import { ContributionItem, InterjectionItem, ThinkingCard, ContentDialog, renderMarkdown } from "./Cards.jsx";
import { List } from "react-window";

const HEADER_HEIGHT = 48;
const CONTRIBUTION_HEIGHT = 120;
const INTERJECTION_HEIGHT = 96;
const EXTENSION_MARKER_HEIGHT = 32;

function getRowHeight(item) {
  if (item.type === "header") {
    return HEADER_HEIGHT + (item.showExtensionMarker ? EXTENSION_MARKER_HEIGHT : 0);
  }
  if (item.type === "interjection") return INTERJECTION_HEIGHT;
  return CONTRIBUTION_HEIGHT;
}

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
  interjections,
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
        const roundInterjections = interjections.filter((ij) => {
          if (contribs.length === 0) return false;
          const contribTimes = contribs.map((c) => c.created_at);
          const roundStart = Math.min(...contribTimes);
          return ij.created_at >= roundStart;
        });

        for (const c of contribs) {
          items.push({ type: "contribution", contribution: c });
        }
        for (const ij of roundInterjections) {
          items.push({ type: "interjection", interjection: ij });
        }
      }
    }
    return items;
  }, [groupedContributions, collapsedRounds, activeRound, agentErrors, interjections, extensions, maxRounds]);

  const rowHeightFn = useCallback((index) => {
    const item = flatItems[index];
    return item ? getRowHeight(item) : CONTRIBUTION_HEIGHT;
  }, [flatItems]);

  const renderRow = useCallback(({ index, style, flatItems, participantName, onToggleCollapse, onDialogOpen }) => {
    const item = flatItems[index];
    if (!item) return null;
    if (item.type === "header") {
      return (
        <div style={style} className="loom-vrow">
          {item.showExtensionMarker && (
            <div className="loom-extension-marker">
              <span className="loom-extension-marker-line" />
              <span className="loom-extension-marker-label">🧵 Extended</span>
              <span className="loom-extension-marker-line" />
            </div>
          )}
          <div className={cn("loom-round-group", item.isActive && "loom-round-active")}>
            <button className="loom-round-header" onClick={() => onToggleCollapse(item.round)}>
              <span className="loom-round-toggle">{item.isCollapsed ? "▶" : "▼"}</span>
              <span className="loom-round-title">Round {item.round}</span>
              <span className="loom-round-count">{item.contribsCount} contribution{item.contribsCount !== 1 ? "s" : ""}</span>
              {item.errorsCount > 0 && (
                <span className="loom-round-errors">⚠ {item.errorsCount}</span>
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
        <InterjectionItem interjection={item.interjection} participantName={participantName(item.interjection.participant_id)} />
      </div>
    );
  }, [flatItems, onToggleCollapse, participantName]);

  const rowProps = useMemo(() => ({
    flatItems,
    participantName,
    onToggleCollapse,
    onDialogOpen: setDialogContribution,
  }), [flatItems, participantName, onToggleCollapse]);

  const listHeight = useMemo(() => {
    return Math.min(600, flatItems.reduce((sum, item) => sum + getRowHeight(item), 0));
  }, [flatItems]);

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
          <div className="loom-empty-icon">🧵</div>
          <p className="loom-text loom-text-muted">Waiting for agents to respond...</p>
          <p className="loom-text-xs loom-text-muted">Contributions will appear here in real-time</p>
        </div>
      )}
      {flatItems.length > 0 && (
        <div className="loom-timeline-list">
          <List
            ref={listRef}
            height={listHeight}
            rowCount={flatItems.length}
            rowHeight={rowHeightFn}
            rowComponent={renderRow}
            rowProps={rowProps}
            width="100%"
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
          <div className="loom-prose" dangerouslySetInnerHTML={{
            __html: renderMarkdown(dialogContribution.contribution.content ?? "")
          }} />
        )}
      </ContentDialog>
    </div>
  );
}

const TimelineTab = memo(TimelineTabBase);
export { TimelineTab };
