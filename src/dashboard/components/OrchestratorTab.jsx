import { useMemo, memo } from "react";
import { List } from "react-window";

const TYPE_LABELS = {
  domain: "Domain Detection",
  moderation: "Moderation",
  convergence: "Convergence Check",
  compaction: "Context Compaction",
  summary: "Round Summary",
  orchestrator: "Orchestrator",
};

const EXCHANGE_HEIGHT = 300;
const MAX_LIST_HEIGHT = 600;

function formatContent(content, role) {
  if (role === "user") {
    const truncated = content.length > 300 ? content.slice(0, 300) + "..." : content;
    return truncated;
  }
  return content.length > 500 ? content.slice(0, 500) + "..." : content;
}

const OrchestratorRow = memo(({ index, style, grouped }) => {
  const group = grouped[index];
  if (!group) return null;
  return (
    <div style={style} className="loom-vrow">
      <div className="loom-orchestrator-exchange">
        {group.query && (
          <div className="loom-orchestrator-query">
            <div className="loom-orchestrator-meta">
              <span className="loom-orchestrator-type">
                {TYPE_LABELS[group.query.type] || group.query.type}
              </span>
              <span className="loom-text-xs loom-text-muted">Query</span>
            </div>
            <div className="loom-orchestrator-content loom-orchestrator-content-query">
              {formatContent(group.query.content, "user")}
            </div>
          </div>
        )}
        {group.response && (
          <div className="loom-orchestrator-response">
            <div className="loom-orchestrator-meta">
              <span className="loom-text-xs loom-text-muted">Response</span>
            </div>
            <div className="loom-orchestrator-content loom-orchestrator-content-response">
              {formatContent(group.response.content, "assistant")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

const OrchestratorTabBase = ({ messages = [] }) => {
  const grouped = useMemo(() => {
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
  }, [messages]);

  const listHeight = useMemo(() => {
    return Math.min(MAX_LIST_HEIGHT, grouped.length * EXCHANGE_HEIGHT);
  }, [grouped.length]);

  if (messages.length === 0) {
    return (
      <div className="loom-main-content">
        <div className="loom-empty-state">
          <div className="loom-empty-icon" aria-hidden="true">🎯</div>
          <p className="loom-text loom-text-muted">No orchestrator activity yet</p>
          <p className="loom-text-xs loom-text-muted">
            Domain detection, moderation, and convergence checks will appear here
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="loom-main-content">
      <div className="loom-orchestrator-list">
        <List
          rowCount={grouped.length}
          rowHeight={EXCHANGE_HEIGHT}
          rowComponent={OrchestratorRow}
          rowProps={{ grouped }}
          overscanCount={3}
          style={{ height: listHeight, width: "100%" }}
        />
      </div>
    </div>
  );
}

const OrchestratorTab = memo(OrchestratorTabBase);
export { OrchestratorTab };