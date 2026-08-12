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
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function RoundIndicator({ current, max }) {
  const pct = max > 0 ? (current / max) * 100 : 0;
  return (
    <div className="loom-card">
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <span className="loom-title-sm">Progress</span>
        <span className="loom-text-xs loom-text-muted">
          Round {current} / {max}
        </span>
      </div>
      <div className="loom-progress-track">
        <div className="loom-progress-bar" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Sidebar({
  state,
  participants,
  theme,
  setTheme,
  agentErrors,
  contributionsByParticipant,
}) {
  return (
    <aside className="loom-sidebar">
      <div className="loom-sidebar-section">
        <h2 className="loom-sidebar-title">Loom</h2>
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>

      {state && (
        <div className="loom-sidebar-section">
          <RoundIndicator current={state.round} max={state.max_rounds} />
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
                error={agentErrors.find((e) => e.participant_id === p.id)}
                contributionsByRound={contributionsByParticipant[p.id] ?? {}}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
