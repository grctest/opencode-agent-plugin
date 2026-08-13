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
}) {
  const errorByParticipant = useMemo(() => {
    const map = new Map();
    for (const e of agentErrors) {
      if (!map.has(e.participant_id)) map.set(e.participant_id, e);
    }
    return map;
  }, [agentErrors]);

  return (
    <aside className="loom-sidebar">
      <div className="loom-sidebar-section">
        <h2 className="loom-sidebar-title">Loom</h2>
        <ThemeToggle theme={theme} setTheme={setTheme} />
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
              📥 Stream Markdown
            </a>
            <a
              className="pure-button pure-button-small pure-button-secondary"
              href={`/api/export?meeting=${selectedMeeting}&format=markdown`}
              download
            >
              ⬇ Export Markdown
            </a>
            <a
              className="pure-button pure-button-small pure-button-secondary"
              href={`/api/export?meeting=${selectedMeeting}&format=json`}
              download
            >
              ⬇ Export JSON
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
