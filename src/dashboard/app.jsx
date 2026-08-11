import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { cn, tierClass, typeClass, statusClass, relativeTime } from "./utils.js";

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(content) {
  return marked.parse(content, { async: false });
}

function StatusBadge({ status }) {
  return (
    <span className={cn("loom-badge", statusClass(status))}>
      {status}
    </span>
  );
}

function TierBadge({ tier }) {
  return (
    <span className={cn("loom-badge", tierClass(tier))}>
      {tier}
    </span>
  );
}

function TypeBadge({ type }) {
  return (
    <span className={cn("loom-badge", typeClass(type))}>
      {type}
    </span>
  );
}

function ParticipantCard({ participant, error }) {
  const [expanded, setExpanded] = useState(false);
  const preview = participant.persona.slice(0, 200);
  const isLong = participant.persona.length > 200;
  const status = participant.status ?? "listening";

  const statusIndicator = () => {
    if (error) {
      return <span className="loom-agent-status loom-agent-error" title={`${error.error_type}: ${error.error_message}`} />;
    }
    if (status === "speaking") {
      return <span className="loom-agent-status loom-agent-thinking" />;
    }
    if (status === "passed") {
      return <span className="loom-agent-status loom-agent-passed" />;
    }
    return null;
  };

  return (
    <div className="loom-card">
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <span className="loom-title-sm loom-flex loom-gap-xs loom-items-center">
          {statusIndicator()}
          {participant.name}
        </span>
        <TierBadge tier={participant.tier} />
      </div>
      <p className="loom-text loom-text-muted">
        {expanded || !isLong ? participant.persona : `${preview}...`}
      </p>
      {isLong && (
        <button className="loom-link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {error && (
        <p className="loom-text-xs loom-mt-xs loom-agent-error-text">
          {error.error_type}: {error.error_message}
        </p>
      )}
      {participant.model_id && !error && (
        <p className="loom-text-xs loom-text-muted loom-mt-xs">
          {participant.provider_id}/{participant.model_id}
        </p>
      )}
    </div>
  );
}

function ContributionItem({ contribution, participantName }) {
  const [expanded, setExpanded] = useState(false);
  const content = contribution.content ?? "";
  const html = renderMarkdown(content);
  const preview = content.slice(0, 300);
  const isLong = content.length > 300;

  return (
    <div className="loom-card">
      <div className="loom-mb-sm">
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-title-sm">{participantName}</span>
          <TypeBadge type={contribution.type} />
          <span className="loom-text-xs loom-text-muted">Round {contribution.round}</span>
          <span className="loom-text-xs loom-text-muted">{relativeTime(contribution.created_at)}</span>
          {contribution.confidence != null && (
            <span className="loom-text-xs loom-text-muted">
              {(contribution.confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
      </div>
      {expanded || !isLong ? (
        <div className="loom-prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="loom-text loom-text-muted">{preview}...</p>
      )}
      {isLong && (
        <button className="loom-link-btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function InterjectionItem({ interjection, participantName }) {
  return (
    <div className="loom-card loom-card-dashed">
      <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center loom-mb-xs">
        <span className="loom-title-sm">{participantName}</span>
        <span className="loom-badge loom-badge-interjection">interjection</span>
        <span className="loom-text-xs loom-text-muted">priority {interjection.priority}</span>
        <span className={cn("loom-text-xs", interjection.granted ? "loom-text-granted" : "loom-text-denied")}>
          {interjection.granted ? "granted" : "denied"}
        </span>
        <span className="loom-text-xs loom-text-muted">{relativeTime(interjection.created_at)}</span>
      </div>
      <p className="loom-text loom-text-muted">{interjection.content}</p>
      {interjection.pushback && (
        <p className="loom-text-xs loom-text-muted loom-mt-xs loom-italic">
          pushback: {interjection.pushback}
        </p>
      )}
    </div>
  );
}

function WarpViewer({ warp }) {
  const [expanded, setExpanded] = useState(false);
  const preview = warp.slice(0, 300);
  const isLong = warp.length > 300;

  return (
    <div className="loom-card">
      <div className="loom-flex loom-flex-between loom-mb-sm">
        <h3 className="loom-title-sm">Warp (Shared Context)</h3>
        {isLong && (
          <button className="loom-link-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <div className="loom-text loom-text-muted loom-mono loom-pre-wrap">
        {expanded || !isLong ? warp || <span className="loom-italic">No warp context yet</span> : `${preview}...`}
      </div>
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
        <div
          className="loom-progress-bar"
          style={{ width: `${pct}%` }}
        />
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

const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
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

export function App() {
  const [meetings, setMeetings] = useState([]);
  const [selectedMeeting, setSelectedMeeting] = useState("");
  const [state, setState] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [interjections, setInterjections] = useState([]);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("timeline");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeType, setActiveType] = useState("");
  const [connected, setConnected] = useState(false);
  const [agentErrors, setAgentErrors] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem("loom-theme") ?? "system");

  const eventSourceRef = useRef(null);
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
    localStorage.setItem("loom-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => document.documentElement.removeAttribute("data-theme");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/meetings");
      if (res.ok) {
        const m = await res.json();
        setMeetings(m);
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const fetchMeetingData = useCallback(async (meetingId) => {
    try {
      const [stateRes, partsRes, contribsRes, interRes, errorsRes] = await Promise.all([
        fetch(`/api/state?meeting=${meetingId}`),
        fetch(`/api/participants?meeting=${meetingId}`),
        fetch(`/api/contributions?meeting=${meetingId}`),
        fetch(`/api/interjections?meeting=${meetingId}`),
        fetch(`/api/agent_errors?meeting=${meetingId}`),
      ]);
      if (stateRes.ok) setState(await stateRes.json());
      if (partsRes.ok) setParticipants(await partsRes.json());
      if (contribsRes.ok) setContributions(await contribsRes.json());
      if (interRes.ok) setInterjections(await interRes.json());
      if (errorsRes.ok) setAgentErrors(await errorsRes.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const connectSSE = useCallback((meetingId) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnected(false);

    const es = new EventSource(`/api/stream?meeting=${meetingId}`);
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      es.close();
      eventSourceRef.current = null;
    };
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "connected") {
          setConnected(true);
        } else if (data.type === "contribution") {
          fetchMeetingData(meetingId);
        } else if (data.type === "state") {
          setState(data.data);
        } else if (data.type === "participants") {
          setParticipants(data.data);
        } else if (data.type === "agent_error") {
          setAgentErrors((prev) => [...prev, data.data]);
        }
      } catch {
      }
    };
  }, [fetchMeetingData]);

  useEffect(() => {
    if (!selectedMeeting && meetings.length > 0) {
      setSelectedMeeting(meetings[0].meeting_id);
    }
  }, [meetings, selectedMeeting]);

  useEffect(() => {
    if (selectedMeeting) {
      fetchMeetingData(selectedMeeting);
      connectSSE(selectedMeeting);
    }
  }, [selectedMeeting, fetchMeetingData, connectSSE]);

  useEffect(() => {
    fetchMeetings();
    pollIntervalRef.current = setInterval(fetchMeetings, 5000);
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [fetchMeetings]);

  const participantName = (id) => {
    const p = participants.find((pp) => pp.id === id);
    return p?.name ?? id;
  };

  const contributionTypes = useMemo(() => {
    const types = new Set();
    for (const c of contributions) types.add(c.type);
    return Array.from(types).sort();
  }, [contributions]);

  const filteredContributions = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const type = activeType;
    return contributions.filter((c) => {
      if (type && c.type !== type) return false;
      if (query && !c.content.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [contributions, searchQuery, activeType]);

  const groupedContributions = useMemo(() => {
    const groups = new Map();
    for (const c of filteredContributions) {
      if (!groups.has(c.round)) groups.set(c.round, []);
      groups.get(c.round).push(c);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]);
  }, [filteredContributions]);

  return (
    <div className="loom-layout">
      {error && (
        <div className="loom-card loom-card-error loom-layout-error">
          <p className="loom-text">{error}</p>
          <button
            className="pure-button pure-button-primary loom-mt-sm"
            onClick={() => {
              fetchMeetings();
              if (selectedMeeting) fetchMeetingData(selectedMeeting);
            }}
          >
            Retry
          </button>
        </div>
      )}

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
            onSelect={setSelectedMeeting}
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
              type="text"
              placeholder="Filter contributions..."
              value={searchQuery}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              className="pure-input-1 loom-search-input"
            />
          </form>
        </div>

        <div className="loom-sidebar-section">
          <h3 className="loom-sidebar-heading">Filter by Type</h3>
          <div className="loom-flex loom-flex-wrap loom-gap-xs">
            <button
              className={cn(
                "pure-button loom-filter-btn",
                activeType === "" && "pure-button-active"
              )}
              onClick={() => setActiveType("")}
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
                onClick={() => setActiveType(type)}
              >
                {type}
              </button>
            ))}
          </div>
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
                />
              ))}
            </div>
          </div>
        )}
      </aside>

      <main className="loom-main">
        {state && (
          <div className="loom-main-header">
            <h1 className="loom-title-lg loom-mb-sm">{state.question}</h1>
            <div className="loom-flex loom-flex-wrap loom-gap-md loom-items-center">
              <StatusBadge status={state.status} />
              <span className="loom-text-xs loom-text-muted">ID: {state.meeting_id}</span>
              <span className="loom-text-xs loom-text-muted">Convergence: {state.convergence}</span>
              <span className={cn("loom-text-xs", connected ? "loom-text-live" : "loom-text-muted")}>
                {connected ? "● live" : "○ offline"}
              </span>
            </div>
          </div>
        )}

        <div className="pure-menu pure-menu-horizontal loom-tabs">
          <ul className="pure-menu-list">
            <li className={cn("pure-menu-item", activeTab === "timeline" && "pure-menu-selected")}>
              <button className="pure-menu-link" onClick={() => setActiveTab("timeline")}>
                Timeline
              </button>
            </li>
            <li className={cn("pure-menu-item", activeTab === "warp" && "pure-menu-selected")}>
              <button className="pure-menu-link" onClick={() => setActiveTab("warp")}>
                Warp
              </button>
            </li>
          </ul>
        </div>

        {activeTab === "timeline" && (
          <div className="loom-main-content">
            {groupedContributions.map(([round, contribs]) => (
              <div key={round} className="loom-space-xs">
                <h4 className="loom-text-sm loom-text-muted loom-title-sm">Round {round}</h4>
                <div className="loom-space-xs">
                  {contribs.map((c) => (
                    <ContributionItem
                      key={c.id}
                      contribution={c}
                      participantName={participantName(c.participant_id)}
                    />
                  ))}
                  {interjections
                    .filter((ij) => ij.created_at >= (contribs[0]?.created_at ?? ""))
                    .map((ij) => (
                      <InterjectionItem
                        key={ij.id}
                        interjection={ij}
                        participantName={participantName(ij.participant_id)}
                      />
                    ))}
                </div>
              </div>
            ))}
            {filteredContributions.length === 0 && contributions.length === 0 && (
              <p className="loom-text loom-text-muted loom-text-center loom-py-lg">
                No contributions yet. Waiting for agents to respond...
              </p>
            )}
            {filteredContributions.length === 0 && contributions.length > 0 && (
              <p className="loom-text loom-text-muted loom-text-center loom-py-lg">
                No contributions match your filter.
              </p>
            )}
          </div>
        )}

        {activeTab === "warp" && (
          <div className="loom-main-content">
            <WarpViewer warp={state?.warp ?? ""} />
          </div>
        )}
      </main>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
