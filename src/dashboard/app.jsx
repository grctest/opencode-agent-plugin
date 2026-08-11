import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { cn, tierClass, typeClass, statusClass, relativeTime } from "./utils.js";

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(content) {
  const raw = marked.parse(content, { async: false });
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}

function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(`loom-${key}`);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`loom-${key}`, JSON.stringify(value));
    } catch { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
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

function ParticipantCard({ participant, error, contributionsByRound }) {
  const [expanded, setExpanded] = useState(false);
  const preview = participant.persona.slice(0, 200);
  const isLong = participant.persona.length > 200;
  const status = participant.status ?? "listening";

  const totalContribs = Object.values(contributionsByRound).reduce((a, b) => a + b, 0);

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
    <div className={cn("loom-card", "loom-participant-card", error && "loom-participant-card-error")}>
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
      {totalContribs > 0 && (
        <div className="loom-participant-contribs">
          <span className="loom-contrib-count">{totalContribs} contribution{totalContribs !== 1 ? "s" : ""}</span>
        </div>
      )}
      {error && (
        <div className="loom-error-detail">
          <span className="loom-error-type">{error.error_type}</span>
          <span className="loom-error-message">{error.error_message}</span>
          <span className="loom-error-attempts">{error.attempts} attempts</span>
        </div>
      )}
      {participant.model_id && (
        <p className="loom-text-xs loom-text-muted loom-mt-xs">
          {participant.provider_id}/{participant.model_id}
        </p>
      )}
    </div>
  );
}

function ThinkingCard({ participant }) {
  return (
    <div className="loom-card loom-thinking-card">
      <div className="loom-thinking-content">
        <span className="loom-thinking-dots">
          <span /><span /><span />
        </span>
        <span className="loom-text loom-text-muted">
          {participant.name} ({participant.tier}) is thinking...
        </span>
      </div>
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
    <div className={cn("loom-card", "loom-contribution-card", `loom-contrib-type-${contribution.type}`)}>
      <div className="loom-mb-sm">
        <div className="loom-flex loom-flex-wrap loom-gap-sm loom-items-center">
          <span className="loom-contrib-participant">{participantName}</span>
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
  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Warp (Shared Context)</h3>
      <div className="loom-warp-content">
        {warp ? (
          warp.split("\n\n").map((section, i) => (
            <div key={i} className="loom-warp-section">
              {section.startsWith("###") ? (
                <h4 className="loom-warp-heading">{section.replace("###", "").trim()}</h4>
              ) : section.startsWith("**") ? (
                <p className="loom-warp-emphasis">{section.replace(/\*\*/g, "")}</p>
              ) : (
                <p className="loom-text loom-text-muted">{section}</p>
              )}
            </div>
          ))
        ) : (
          <span className="loom-italic">No warp context yet</span>
        )}
      </div>
    </div>
  );
}

function AgentPerspective({ participant, meetingId }) {
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!meetingId || !participant.id) return;
    setLoading(true);
    fetch(`/api/agent_context?meeting=${meetingId}&participant=${participant.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setContext)
      .catch(() => setContext(null))
      .finally(() => setLoading(false));
  }, [meetingId, participant.id]);

  if (loading) {
    return (
      <div className="loom-card loom-agent-perspective">
        <div className="loom-flex loom-gap-xs loom-items-center">
          <span className="loom-thinking-dots"><span /><span /><span /></span>
          <span className="loom-text-xs loom-text-muted">{participant.name}&apos;s view...</span>
        </div>
      </div>
    );
  }

  if (!context?.participant) {
    return null;
  }

  const { participant: p, meeting } = context;

  return (
    <div className="loom-card loom-agent-perspective">
      <div className="loom-agent-perspective-header">
        <span className="loom-agent-perspective-name">{p.name}</span>
        <TierBadge tier={p.tier} />
      </div>
      <div className="loom-agent-perspective-body">
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Persona</span>
          <p className="loom-text-xs loom-text-muted">{p.persona}</p>
        </div>
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Agenda</span>
          <p className="loom-text-xs loom-text-muted">{p.agenda}</p>
        </div>
        <div className="loom-agent-perspective-section">
          <span className="loom-agent-perspective-label">Model</span>
          <p className="loom-text-xs loom-text-muted">{p.provider_id}/{p.model_id}</p>
        </div>
        {meeting?.warp && (
          <div className="loom-agent-perspective-section">
            <span className="loom-agent-perspective-label">Shared Context (Warp)</span>
            <div className="loom-agent-perspective-warp">
              {meeting.warp.slice(0, 300)}{meeting.warp.length > 300 ? "..." : ""}
            </div>
          </div>
        )}
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

const THEME_OPTIONS = [
  { value: "light", label: "☀ Light" },
  { value: "dark", label: "☾ Dark" },
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

function ParticipationMatrix({ participants, contributions, agentErrors, rounds }) {
  const roundData = useMemo(() => {
    const data = [];
    for (let r = 1; r <= rounds; r++) {
      const row = {};
      for (const p of participants) {
        const contrib = contributions.find((c) => c.participant_id === p.id && c.round === r);
        const err = agentErrors.find((e) => e.participant_id === p.id && e.round === r);
        if (contrib) row[p.id] = "contributed";
        else if (err) row[p.id] = "error";
        else if (p.status === "passed") row[p.id] = "passed";
        else row[p.id] = "none";
      }
      data.push({ round: r, participants: row });
    }
    return data;
  }, [participants, contributions, agentErrors, rounds]);

  if (rounds === 0 || participants.length === 0) return null;

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Participation</h3>
      <div className="loom-matrix-scroll">
        <table className="loom-matrix">
          <thead>
            <tr>
              <th className="loom-matrix-round-label">Round</th>
              {participants.map((p) => (
                <th key={p.id} className="loom-matrix-participant">
                  <span className="loom-matrix-participant-name">{p.name}</span>
                  <span className="loom-matrix-participant-tier">{p.tier}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roundData.map(({ round, participants: row }) => (
              <tr key={round} className={cn(agentErrors.some((e) => e.round === round) && "loom-matrix-row-error")}>
                <td className="loom-matrix-round-label">R{round}</td>
                {participants.map((p) => {
                  const status = row[p.id];
                  return (
                    <td key={p.id} className="loom-matrix-cell">
                      <span className={cn("loom-matrix-dot", `loom-matrix-${status}`)} title={status} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="loom-matrix-legend">
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-contributed" /> Contributed</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-error" /> Error</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-passed" /> Passed</span>
        <span className="loom-matrix-legend-item"><span className="loom-matrix-dot loom-matrix-none" /> Pending</span>
      </div>
    </div>
  );
}

function WarpGrowthChart({ contributions, warp }) {
  const data = useMemo(() => {
    const roundLengths = {};
    for (const c of contributions) {
      roundLengths[c.round] = (roundLengths[c.round] || 0) + c.content.length;
    }
    const rounds = Object.keys(roundLengths).map(Number).sort((a, b) => a - b);
    if (rounds.length === 0) return [];
    let cumulative = 0;
    return rounds.map((r) => {
      cumulative += roundLengths[r];
      return { round: r, length: cumulative };
    });
  }, [contributions]);

  if (data.length < 2) return null;

  const maxLen = Math.max(...data.map((d) => d.length));
  const chartHeight = 60;
  const chartWidth = 200;

  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * chartWidth;
    const y = chartHeight - (d.length / maxLen) * chartHeight;
    return `${x},${y}`;
  }).join(" ");

  return (
    <div className="loom-card">
      <h3 className="loom-title-sm loom-mb-sm">Warp Growth</h3>
      <div className="loom-warp-chart">
         <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="xMidYMid meet" className="loom-warp-svg">
          <polyline
            fill="none"
            stroke="var(--color-primary)"
            strokeWidth="2"
            points={points}
          />
          {data.map((d, i) => {
            const x = (i / (data.length - 1)) * chartWidth;
            const y = chartHeight - (d.length / maxLen) * chartHeight;
            return <circle key={i} cx={x} cy={y} r="3" fill="var(--color-primary)" />;
          })}
        </svg>
        <div className="loom-warp-chart-labels">
          <span>{data[0].length} chars</span>
          <span>{maxLen} chars</span>
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ round, contribs, collapsed, isActive, agentErrors, participantName, interjections, onToggleCollapse, extensions, originalRoundCount }) {
  const roundErrors = agentErrors.filter((e) => e.round === round);
  const showExtensionMarker = extensions.length > 0 && round === originalRoundCount + 1;

  return (
    <div>
      {showExtensionMarker && (
        <div className="loom-extension-marker">
          <span className="loom-extension-marker-line" />
          <span className="loom-extension-marker-label">🧵 Extended</span>
          <span className="loom-extension-marker-line" />
        </div>
      )}
      <div className={cn("loom-round-group", isActive && "loom-round-active")}>
        <button className="loom-round-header" onClick={() => onToggleCollapse(round)}>
          <span className="loom-round-toggle">{collapsed ? "▶" : "▼"}</span>
          <span className="loom-round-title">Round {round}</span>
          <span className="loom-round-count">{contribs.length} contribution{contribs.length !== 1 ? "s" : ""}</span>
          {roundErrors.length > 0 && (
            <span className="loom-round-errors">⚠ {roundErrors.length}</span>
          )}
        </button>
        {!collapsed && (
          <div className="loom-round-content">
            {contribs.slice(0, 5).map((c) => (
              <ContributionItem key={c.id} contribution={c} participantName={participantName(c.participant_id)} />
            ))}
            {contribs.length > 5 && (
              <p className="loom-text-xs loom-text-muted loom-mt-xs">+{contribs.length - 5} more contributions</p>
            )}
            {interjections
              .filter((ij) => {
                const contribTimes = contribs.map((c) => c.created_at);
                const roundStart = Math.min(...contribTimes);
                return ij.created_at >= roundStart;
              })
              .map((ij) => (
                <InterjectionItem key={ij.id} interjection={ij} participantName={participantName(ij.participant_id)} />
              ))}
          </div>
        )}
      </div>
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
  const [agentErrors, setAgentErrors] = useState([]);
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem("loom-theme") ?? "system");

  const [activeTab, setActiveTab] = usePersistedState("active-tab", "overview");
  const [searchQuery, setSearchQuery] = usePersistedState("search-query", "");
  const [activeType, setActiveType] = usePersistedState("active-type", "");
  const [collapsedRounds, setCollapsedRounds] = usePersistedState("collapsed-rounds", []);
  const [scrolledToBottom, setScrolledToBottom] = useState(true);
  const [extensions, setExtensions] = useState([]);
  const [extensionBanner, setExtensionBanner] = useState(null);
  const [progressFlash, setProgressFlash] = useState(false);

  const prevStatusRef = useRef(null);
  const eventSourceRef = useRef(null);
  const bannerTimeoutRef = useRef(null);
  const mainRef = useRef(null);
  const searchInputRef = useRef(null);

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
          const prevStatus = prevStatusRef.current;
          setState(data.data);
          if (data.data?.status === "weaving") {
            fetchMeetingData(meetingId);
          }
          if (prevStatus && prevStatus !== "weaving" && data.data?.status === "weaving") {
            setProgressFlash(true);
            setTimeout(() => setProgressFlash(false), 2000);
          }
          prevStatusRef.current = data.data?.status;
        } else if (data.type === "participants") {
          setParticipants(data.data);
        } else if (data.type === "agent_error") {
          setAgentErrors((prev) => [...prev, data.data]);
          fetchMeetingData(meetingId);
        }
      } catch { /* ignore */ }
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
    if (!state?.warp) return;
    const warp = state.warp;
    const extensionRegex = /\*\*User Input:\*\*\s*([^\n]+(?:\n(?!\*\*User Input:\*\*)[^\n]*)*)/g;
    const found = [];
    let match;
    while ((match = extensionRegex.exec(warp)) !== null) {
      found.push(match[1].trim());
    }
    if (found.length > extensions.length) {
      const newExtension = found[found.length - 1];
      setExtensions(found);
      setExtensionBanner({ prompt: newExtension, timestamp: Date.now() });
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
      bannerTimeoutRef.current = setTimeout(() => setExtensionBanner(null), 8000);
    } else if (found.length !== extensions.length) {
      setExtensions(found);
    }
  }, [state?.warp, extensions.length]);

  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
     fetchMeetings();
     return () => {
       if (eventSourceRef.current) eventSourceRef.current.close();
     };
   }, [fetchMeetings]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const handleScroll = () => {
      const threshold = 100;
      const atBottom = main.scrollHeight - main.scrollTop - main.clientHeight < threshold;
      setScrolledToBottom(atBottom);
    };
    main.addEventListener("scroll", handleScroll, { passive: true });
    return () => main.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    if (scrolledToBottom && mainRef.current) {
      mainRef.current.scrollTop = mainRef.current.scrollHeight;
    }
  }, [contributions.length, scrolledToBottom]);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "o") setActiveTab("overview");
      else if (e.key === "t") setActiveTab("timeline");
      else if (e.key === "w") setActiveTab("warp");
      else if (e.key === "j") {
        if (mainRef.current) mainRef.current.scrollTop += 200;
      } else if (e.key === "k") {
        if (mainRef.current) mainRef.current.scrollTop -= 200;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setActiveTab]);

  const scrollToBottom = useCallback(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: mainRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

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
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [filteredContributions]);

  const thinkingParticipants = useMemo(() => {
    return participants.filter((p) => p.status === "speaking");
  }, [participants]);

  const contributionStats = useMemo(() => {
    const typeCounts = {};
    for (const c of contributions) {
      typeCounts[c.type] = (typeCounts[c.type] ?? 0) + 1;
    }
    return typeCounts;
  }, [contributions]);

  const contributionsByParticipant = useMemo(() => {
    const map = {};
    for (const c of contributions) {
      const pid = c.participant_id;
      if (!map[pid]) map[pid] = {};
      map[pid][c.round] = (map[pid][c.round] ?? 0) + 1;
    }
    return map;
  }, [contributions]);

  const toggleRoundCollapse = (round) => {
    setCollapsedRounds((prev) =>
      prev.includes(round) ? prev.filter((r) => r !== round) : [...prev, round]
    );
  };

  const isWeaving = state?.status === "weaving";
  const activeRound = state?.round ?? 0;
  const totalRounds = state?.max_rounds ?? 0;
  const activeAgentCount = participants.filter((p) => p.status === "speaking").length;
  const errorCount = agentErrors.length;

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
          <div className={cn("loom-sidebar-section", progressFlash && "loom-progress-flash")}>
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
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
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

      <main className="loom-main" ref={mainRef}>
        {state && (
          <div className="loom-main-header">
            <h1 className="loom-title-lg loom-mb-sm">{state.question}</h1>
            <div className="loom-flex loom-flex-wrap loom-gap-md loom-items-center">
              <StatusBadge status={state.status} />
              <span className="loom-text-xs loom-text-muted">Round {state.round} / {state.max_rounds}</span>
              <span className="loom-text-xs loom-text-muted">Convergence: {state.convergence}</span>
              <span className={cn("loom-text-xs", connected ? "loom-text-live" : "loom-text-muted")}>
                {connected ? "● live" : "○ offline"}
              </span>
              {activeAgentCount > 0 && (
                <span className="loom-text-xs loom-text-active">
                  ⏳ {activeAgentCount} active
                </span>
              )}
              {errorCount > 0 && (
                <span className="loom-text-xs loom-text-agent-errors">
                  ⚠ {errorCount} error{errorCount > 1 ? "s" : ""}
                </span>
              )}
            </div>
          </div>
        )}

        {isWeaving && thinkingParticipants.length > 0 && (
          <div className="loom-active-round-banner">
            <span className="loom-thinking-dots"><span /><span /><span /></span>
            <span className="loom-text-xs loom-text-muted">
              {thinkingParticipants.map((p) => `${p.name} (${p.tier})`).join(", ")} thinking...
            </span>
          </div>
        )}

        {extensionBanner && (
          <div className="loom-extension-banner">
            <span className="loom-extension-icon">🧵</span>
            <div className="loom-extension-content">
              <span className="loom-extension-title">Loom Extended</span>
              <span className="loom-extension-prompt">{extensionBanner.prompt}</span>
            </div>
            <button className="loom-extension-dismiss" onClick={() => setExtensionBanner(null)}>✕</button>
          </div>
        )}

        <div className="pure-menu pure-menu-horizontal loom-tabs">
          <ul className="pure-menu-list">
            {["overview", "timeline", "warp"].map((tab) => (
              <li key={tab} className={cn("pure-menu-item", activeTab === tab && "pure-menu-selected")}>
                <button className="pure-menu-link" onClick={() => setActiveTab(tab)}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {activeTab === "overview" && state && (
          <div className="loom-overview">
            <div className="loom-stats-grid">
              <div className="loom-stat-card">
                <span className="loom-stat-value">{state.round}</span>
                <span className="loom-stat-label">Rounds</span>
              </div>
              <div className="loom-stat-card">
                <span className="loom-stat-value">{contributions.length}</span>
                <span className="loom-stat-label">Contributions</span>
              </div>
              <div className="loom-stat-card">
                <span className="loom-stat-value">{interjections.length}</span>
                <span className="loom-stat-label">Interjections</span>
              </div>
              <div className="loom-stat-card">
                <span className="loom-stat-value">{participants.length}</span>
                <span className="loom-stat-label">Participants</span>
              </div>
            </div>
            <div className="loom-mt-sm">
              <ParticipationMatrix
                participants={participants}
                contributions={contributions}
                agentErrors={agentErrors}
                rounds={totalRounds}
              />
            </div>
            {Object.keys(contributionStats).length > 0 && (
              <div className="loom-card loom-mt-sm">
                <h3 className="loom-title-sm loom-mb-sm">Contribution Types</h3>
                <div className="loom-stat-badges">
                  {Object.entries(contributionStats).map(([type, count]) => (
                    <span key={type} className={cn("loom-badge", typeClass(type))}>
                      {type}: {count}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <WarpGrowthChart contributions={contributions} warp={state.warp} />
            {agentErrors.length > 0 && (
              <div className="loom-card loom-card-error loom-mt-sm">
                <h3 className="loom-title-sm loom-mb-sm">Agent Errors</h3>
                <div className="loom-space-xs">
                  {agentErrors.map((err, i) => (
                    <div key={i} className="loom-error-summary">
                      <span className="loom-error-participant">{participantName(err.participant_id)}</span>
                      <span className="loom-error-type">{err.error_type}</span>
                      <span className="loom-error-message">{err.error_message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        )}

        {activeTab === "timeline" && (
          <div className="loom-main-content">
            <div className="loom-timeline-filter">
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
            {groupedContributions.length > 0 && (
               <div className="loom-timeline-list">
                 {groupedContributions.map(([round, contribs]) => (
                   <TimelineRow
                     key={round}
                     round={round}
                     contribs={contribs}
                     collapsed={collapsedRounds.includes(round)}
                     isActive={round === activeRound}
                     agentErrors={agentErrors}
                     participantName={participantName}
                     interjections={interjections}
                     onToggleCollapse={toggleRoundCollapse}
                     extensions={extensions}
                     originalRoundCount={state?.max_rounds ? state.max_rounds - (extensions.length * 4) : 0}
                   />
                 ))}
               </div>
            )}
            {filteredContributions.length === 0 && contributions.length > 0 && (
              <div className="loom-empty-state">
                <p className="loom-text loom-text-muted">No contributions match your filter.</p>
              </div>
            )}
          </div>
        )}

        {activeTab === "warp" && (
          <div className="loom-main-content">
            <WarpViewer warp={state?.warp ?? ""} />
            {participants.length > 0 && (
              <div className="loom-mt-sm">
                <h3 className="loom-title-sm loom-mb-sm">Agent Perspectives</h3>
                <p className="loom-text-xs loom-text-muted loom-mb-sm">
                  What each agent sees — persona, agenda, model, and shared context.
                </p>
                <div className="loom-space-sm">
                  {participants.map((p) => (
                    <AgentPerspective key={p.id} participant={p} meetingId={selectedMeeting} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!scrolledToBottom && (
          <button className="loom-scroll-bottom" onClick={scrollToBottom}>
            ↓ New contributions
          </button>
        )}
      </main>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
