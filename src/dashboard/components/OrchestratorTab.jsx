import { useMemo, useState, useCallback, memo } from "react";
import { List } from "react-window";
import { ContentDialog } from "./Cards.jsx";
import { cn } from "../utils.js";

const TYPE_META = {
  domain: { emoji: "🔍", label: "Domain Detection" },
  moderation: { emoji: "🛡️", label: "Moderation" },
  convergence: { emoji: "🎯", label: "Convergence Check" },
  compaction: { emoji: "📦", label: "Context Compaction" },
  summary: { emoji: "📝", label: "Round Summary" },
  orchestrator: { emoji: "🎛️", label: "Orchestrator" },
  turn_order: { emoji: "🔄", label: "Turn Planning" },
};

const ROW_HEIGHT = 36;
const MAX_LIST_HEIGHT = 600;

const OrchestratorRow = memo(({ index, style, grouped, onSelect }) => {
  const group = grouped[index];
  if (!group) return null;
  const rawType = group.query
    ? group.query.type
    : group.response
      ? group.response.type
      : null;
  const meta = rawType ? (TYPE_META[rawType] || { emoji: "❓", label: rawType }) : { emoji: "❓", label: "Unknown" };
  return (
    <div
      style={style}
      className="loom-orchestrator-row"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(group)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(group);
        }
      }}
    >
      <span className="loom-orchestrator-row-type">
        <span className="loom-orchestrator-row-emoji" aria-hidden="true">{meta.emoji}</span>
        {meta.label}
      </span>
    </div>
  );
});

const OrchestratorTabBase = ({ messages = [] }) => {
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [activeTab, setActiveTab] = useState("prompt");

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
    return Math.min(MAX_LIST_HEIGHT, grouped.length * ROW_HEIGHT);
  }, [grouped.length]);

  const handleSelect = useCallback((group) => {
    setSelectedGroup(group);
    setActiveTab("prompt");
  }, []);

  const handleClose = useCallback(() => {
    setSelectedGroup(null);
  }, []);

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

  const rawType = selectedGroup
    ? (selectedGroup.query?.type || selectedGroup.response?.type || null)
    : null;
  const dialogTitle = rawType ? (TYPE_META[rawType]?.label || rawType) : "";

  return (
    <div className="loom-main-content">
      <div className="loom-orchestrator-list">
        <List
          rowCount={grouped.length}
          rowHeight={ROW_HEIGHT}
          rowComponent={OrchestratorRow}
          rowProps={{ grouped, onSelect: handleSelect }}
          overscanCount={5}
          style={{ height: listHeight, width: "100%" }}
        />
      </div>

      <ContentDialog open={selectedGroup !== null} onClose={handleClose} title={dialogTitle}>
        {selectedGroup && (
          <div className="loom-orchestrator-dialog">
            <div className="loom-orchestrator-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === "prompt"}
                className={cn("loom-orchestrator-tab", activeTab === "prompt" && "loom-orchestrator-tab-active")}
                onClick={() => setActiveTab("prompt")}
              >
                Prompt
              </button>
              <button
                role="tab"
                aria-selected={activeTab === "response"}
                className={cn("loom-orchestrator-tab", activeTab === "response" && "loom-orchestrator-tab-active")}
                onClick={() => setActiveTab("response")}
              >
                Response
              </button>
            </div>
            <div className="loom-orchestrator-dialog-content" role="tabpanel">
              {activeTab === "prompt" && selectedGroup.query && (
                <pre className="loom-orchestrator-full-content">{selectedGroup.query.content}</pre>
              )}
              {activeTab === "prompt" && !selectedGroup.query && (
                <p className="loom-text loom-text-muted">No prompt recorded for this exchange.</p>
              )}
              {activeTab === "response" && selectedGroup.response && (
                <pre className="loom-orchestrator-full-content">{selectedGroup.response.content}</pre>
              )}
              {activeTab === "response" && !selectedGroup.response && (
                <p className="loom-text loom-text-muted">No response recorded for this exchange.</p>
              )}
            </div>
            <div className="loom-dialog-footer">
              <button
                className="pure-button pure-button-small loom-copy-btn"
                onClick={() => {
                  const content = activeTab === "prompt"
                    ? selectedGroup.query?.content ?? ""
                    : selectedGroup.response?.content ?? "";
                  navigator.clipboard.writeText(content);
                }}
              >
                Copy
              </button>
            </div>
          </div>
        )}
      </ContentDialog>
    </div>
  );
}

const OrchestratorTab = memo(OrchestratorTabBase);
export { OrchestratorTab };
