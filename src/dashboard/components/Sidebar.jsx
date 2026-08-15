import { memo, useMemo } from "react";
import { cn } from "../utils.js";
import { ParticipantCard } from "./Cards.jsx";

const THEME_OPTIONS = [
  { value: "light", label: "☀ Light" },
  { value: "dark", label: "☾ Dark" },
  { value: "system", label: "💻 System" },
];

function ThemeToggle({ theme, setTheme }) {
  return (
    <div className="loom-theme-toggle">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          className={cn("pure-button loom-theme-btn", theme === opt.value && "pure-button-active")}
          onClick={() => setTheme(opt.value)}
          aria-pressed={theme === opt.value}
          aria-label={`${opt.label} theme`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoundIndicator({ current, max, status }) {
  const pct = max > 0 ? (current / max) * 100 : 0;
  return (
    <div className="loom-card">
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <span className="loom-title-sm">Progress</span>
        <span className="loom-text-xs loom-text-muted">
          Round {current} / {max}
        </span>
      </div>
      <div className="loom-progress-track" role="progressbar" aria-valuenow={current} aria-valuemin={0} aria-valuemax={max} aria-label="Meeting progress">
        <div className="loom-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      {status && status !== "weaving" && status !== "initializing" && (
        <span className="loom-text-xs loom-text-muted loom-mt-xs">Status: {status}</span>
      )}
    </div>
  );
}

const Sidebar = memo(function Sidebar({
  state,
  participants,
  theme,
  setTheme,
  agentErrors,
  contributionsByParticipant,
  selectedMeeting,
  embeddingStatus,
}) {
  const errorByParticipant = useMemo(() => {
    const map = new Map();
    for (const e of agentErrors) {
      if (!map.has(e.participant_id)) map.set(e.participant_id, e);
    }
    return map;
  }, [agentErrors]);

  const modelName = embeddingStatus?.model?.split("/").pop() ?? embeddingStatus?.model;

  return (
    <aside className="loom-sidebar">
      <div className="loom-sidebar-section">
        <h2 className="loom-sidebar-title">Loom</h2>
        <ThemeToggle theme={theme} setTheme={setTheme} />
        {modelName && (
          <div className="loom-flex loom-gap-xs loom-mt-xs loom-items-center">
            <span
              className={cn(
                "loom-text-xs",
                embeddingStatus.state === "ready" ? "loom-text-live" : "loom-text-muted"
              )}
              title={embeddingStatus.message ? `Embedding model: ${embeddingStatus.message}` : `Embedding model: ${embeddingStatus.model}`}
            >
              <span aria-hidden="true">🧮</span> {modelName}
              {embeddingStatus.dims ? ` (${embeddingStatus.dims}d)` : ""}
              {" "}{embeddingStatus.state === "ready" ? "●" : embeddingStatus.state === "error" ? "⚠" : "…"}
            </span>
          </div>
        )}
        {embeddingStatus?.state === "error" && (
          <div className="loom-text-xs loom-text-muted" title={embeddingStatus.message}>
            <span aria-hidden="true">⚠</span> Emb. model failed — using placeholder vectors
          </div>
        )}
      </div>

      {state && (
        <div className="loom-sidebar-section">
          <RoundIndicator current={state.round} max={state.max_rounds} status={state.status} />
        </div>
      )}

      {selectedMeeting && (
        <div className="loom-sidebar-section">
          <div className="loom-flex loom-flex-between loom-mb-xs">
            <span className="loom-title-sm">Export</span>
          </div>
          <div className="loom-space-xs">
            <a
              className="pure-button pure-button-small pure-button-secondary loom-export-stream-btn"
              href={`/api/export/stream?meeting=${selectedMeeting}`}
              download
            >
              <span aria-hidden="true">📥</span> Stream Markdown
            </a>
            <a
              className="pure-button pure-button-small pure-button-secondary"
              href={`/api/export?meeting=${selectedMeeting}&format=markdown`}
              download
            >
              <span aria-hidden="true">⬇</span> Export Markdown
            </a>
            <a
              className="pure-button pure-button-small pure-button-secondary"
              href={`/api/export?meeting=${selectedMeeting}&format=json`}
              download
            >
              <span aria-hidden="true">⬇</span> Export JSON
            </a>
          </div>
        </div>
      )}

      {state && (
        <div className="loom-sidebar-section">
          <h3 className="loom-sidebar-heading">Participants ({participants.length})</h3>
          <div className="loom-space-xs">
            {participants.map((p) => (
              <ParticipantCard
                key={p.id}
                participant={p}
                error={errorByParticipant.get(p.id)}
                contributionsByRound={contributionsByParticipant[p.id] ?? {}}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
});

export { Sidebar };
