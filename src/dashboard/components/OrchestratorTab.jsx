import { useMemo, useCallback, memo } from "react";
import { List } from "react-window";
import { cn } from "../utils.js";

const TYPE_LABELS = {
  domain: "Domain Detection",
  moderation: "Moderation",
  convergence: "Convergence Check",
  compaction: "Context Compaction",
  summary: "Round Summary",
  orchestrator: "Orchestrator",
  governance: "Governance Directive",
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

  const rowHeightFn = useCallback(() => EXCHANGE_HEIGHT, []);

  const listHeight = useMemo(() => {
    return Math.min(MAX_LIST_HEIGHT, grouped.length * EXCHANGE_HEIGHT);
  }, [grouped.length]);

  const Row = useCallback(({ index, style }) => {
    const group = grouped[index];
    return (
      <div style={style} className="loom-vrow">
        <div className="loom-orchestrator-exchange">
          {group.query && (
            <div className="loom-orchestrator-query">
              <div className="loom-orchestrator-meta">
                <span className={cn("loom-orchestrator-type", group.query.type === "governance" && "loom-orchestrator-type-governance")}>
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
  }, [grouped]);

  if (messages.length === 0) {
    return (
      <div className="loom-main-content">
        <div className="loom-empty-state">
          <div className="loom-empty-icon">🎯</div>
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
          height={listHeight}
          rowCount={grouped.length}
          rowHeight={rowHeightFn}
          width="100%"
        >
          {Row}
        </List>
      </div>
    </div>
  );
}

const OrchestratorTab = memo(OrchestratorTabBase);
export { OrchestratorTab };
