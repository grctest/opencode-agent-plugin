import { cn } from "../utils.js";
import { StatusBadge, TierBadge } from "./Badges.jsx";
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

function MeetingSelector({ meetings, selected, onSelect }) {
  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Meetings</h3>
      <nav className="pure-menu">
        <ul className="pure-menu-list loom-menu-list">
          {meetings.map((m) => (
            <li key={m.meeting_id} className="pure-menu-item">
              <button
                className={cn(
                  "pure-menu-link loom-menu-link",
                  m.meeting_id === selected && "pure-menu-selected"
                )}
                onClick={() => onSelect(m.meeting_id)}
              >
                <span className="pure-u-1">
                  <span className="loom-menu-question">{m.question.slice(0, 50)}</span>
                  <StatusBadge status={m.status} />
                </span>
              </button>
            </li>
          ))}
          {meetings.length === 0 && (
            <li className="pure-menu-item">
              <span className="pure-menu-link loom-text-xs loom-text-muted">No meetings yet</span>
            </li>
          )}
        </ul>
      </nav>
    </div>
  );
}

export function Sidebar({
  state,
  participants,
  meetings,
  selectedMeeting,
  onSelectMeeting,
  theme,
  setTheme,
  searchQuery,
  onSearchChange,
  agentErrors,
  contributionsByParticipant,
  searchInputRef,
}) {
  return (
    <aside className="loom-sidebar">
      <div className="loom-sidebar-section">
        <h2 className="loom-sidebar-title">Loom</h2>
        <ThemeToggle theme={theme} setTheme={setTheme} />
      </div>

      <div className="loom-sidebar-section">
        <h3 className="loom-sidebar-heading">Meetings</h3>
        <MeetingSelector
          meetings={meetings}
          selected={selectedMeeting}
          onSelect={onSelectMeeting}
        />
      </div>

      {state && (
        <div className="loom-sidebar-section">
          <RoundIndicator current={state.round} max={state.max_rounds} />
        </div>
      )}

      <div className="loom-sidebar-section">
        <h3 className="loom-sidebar-heading">Search</h3>
        <form className="pure-form">
          <input
            ref={searchInputRef}
            type="text"
            placeholder="Filter contributions... (press /)"
            value={searchQuery}
            onInput={(e) => onSearchChange(e.currentTarget.value)}
            className="pure-input-1 loom-search-input"
          />
        </form>
      </div>

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
