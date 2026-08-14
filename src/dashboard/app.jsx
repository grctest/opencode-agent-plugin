import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { cn, statusClass } from "./utils.js";
import { StatusBadge } from "./components/Badges.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { OverviewTab } from "./components/OverviewTab.jsx";
import { OrchestratorTab } from "./components/OrchestratorTab.jsx";
import { TimelineTab } from "./components/TimelineTab.jsx";
import { FabricTab } from "./components/FabricTab.jsx";
import { OutputTab } from "./components/OutputTab.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { usePersistedState, useMeetingApi, useSSEReset } from "./hooks.js";

const POLLING_FALLBACK_INTERVAL = 3000;

const CONVERGENCE_LABELS = {
  consensus: "Consensus",
  majority: "Majority vote",
  moderator_forces: "Moderator-forced",
};

function useSSE(meetingId, onEvent) {
  const [connected, setConnected] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState(null);
  const esRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pollingRef = useRef(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const maxReconnectAttempts = 10;

  useEffect(() => {
    if (!meetingId) return;

    let cancelled = false;
    let fallbackPoll = false;

    function startPolling() {
      if (fallbackPoll) return;
      fallbackPoll = true;
      setConnected(false);
      setLastError("Live updates unavailable — using periodic refresh.");

      const poll = async () => {
        if (cancelled || !fallbackPoll) return;
        try {
          const res = await fetch(`/api/meeting?meeting=${meetingId}&limit=500`);
          if (res.ok) {
            const data = await res.json();
            const timestamp = new Date().toISOString();
            const newContribs = Array.isArray(data) ? data : (data.contributions ?? []);
            onEventRef.current({ type: "contributions", data: newContribs, timestamp });
            if (data.state) onEventRef.current({ type: "state", data: data.state, timestamp });
            if (data.participants) onEventRef.current({ type: "participants", data: data.participants, timestamp });
            if (data.artifact) onEventRef.current({ type: "artifact", data: data.artifact, timestamp });
          }
        } catch (err) {
          window.dispatchEvent(new CustomEvent("loom-sse-error", {
            detail: { message: err.message, phase: "polling" }
          }));
        }
        if (!cancelled && fallbackPoll) {
          pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
        }
      };
      pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
    }

    const handleSSEError = (e) => {
      if (e?.detail?.message) {
        setLastError(e.detail.message);
      }
    };
    window.addEventListener("loom-sse-error", handleSSEError);

    function connect() {
      if (cancelled) return;

      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource(`/api/stream?meeting=${meetingId}`);
      esRef.current = es;

      es.onopen = () => {
        if (cancelled) return;
        fallbackPoll = false;
        if (pollingRef.current) clearTimeout(pollingRef.current);
        setConnected(true);
        setReconnectAttempt(0);
        setLastError(null);
        // Dispatch reset so the app re-fetches state from the server on reconnect
        window.dispatchEvent(new CustomEvent("loom-sse-reset"));
      };

      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        es.close();
        esRef.current = null;

        setReconnectAttempt((prev) => {
          if (prev >= maxReconnectAttempts) {
            startPolling();
            return prev;
          }
          setLastError(`Reconnecting to live updates (attempt ${prev + 1}/${maxReconnectAttempts}).`);
          const delay = Math.min(1000 * Math.pow(2, prev), 30000);
          reconnectTimeoutRef.current = setTimeout(connect, delay);
          return prev + 1;
        });
      };

      es.onmessage = (event) => {
        if (cancelled) return;
        try {
          const data = JSON.parse(event.data);
          onEventRef.current(data);
        } catch (err) {
          window.dispatchEvent(new CustomEvent("loom-sse-error", {
            detail: { message: `Failed to parse SSE message: ${err.message}`, phase: "parse" }
          }));
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      fallbackPoll = false;
      window.removeEventListener("loom-sse-error", handleSSEError);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (pollingRef.current) clearTimeout(pollingRef.current);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [meetingId]);

  return { connected, reconnectAttempt, lastError };
}

function ThemeProvider({ theme, setTheme, children }) {
  useEffect(() => {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    localStorage.setItem("loom-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => {
      document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
    };
    handler(mediaQuery);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);

  return children;
}

function MeetingHeader({ state, connected, reconnectAttempt, activeAgentCount, errorCount, selectedMeeting }) {
  return (
    <div className="loom-main-header">
      <h1 className="loom-title-lg loom-mb-sm">{state.question}</h1>
      <div className="loom-flex loom-flex-wrap loom-gap-md loom-items-center">
        <StatusBadge status={state.status} />
        <span className="loom-text-xs loom-text-muted">Round {state.round} / {state.max_rounds}</span>
        <span className="loom-text-xs loom-text-muted">Convergence: {CONVERGENCE_LABELS[state.convergence] ?? state.convergence}</span>
        <span className={cn("loom-text-xs", connected ? "loom-text-live" : "loom-text-muted")}>
          {connected ? "● live" : reconnectAttempt > 0 ? `○ reconnecting (${reconnectAttempt})` : "○ offline"}
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
        <a
          className="pure-button loom-export-btn"
          href={`/api/export?meeting=${selectedMeeting}`}
          download
        >
          ↓ Export Markdown
        </a>
      </div>
    </div>
  );
}

function ThinkingBanner({ thinkingParticipants }) {
  if (thinkingParticipants.length === 0) return null;
  return (
    <div className="loom-active-round-banner">
      <span className="loom-thinking-dots"><span /><span /><span /></span>
      <span className="loom-text-xs loom-text-muted">
        {thinkingParticipants.map((p) => `${p.name} (${p.tier})`).join(", ")} thinking...
      </span>
    </div>
  );
}

function ExtensionBanner({ banner, onDismiss }) {
  if (!banner) return null;
  return (
    <div className="loom-extension-banner">
      <span className="loom-extension-icon">🧵</span>
      <div className="loom-extension-content">
        <span className="loom-extension-title">Loom Extended</span>
        <span className="loom-extension-prompt">{banner.prompt}</span>
      </div>
      <button className="loom-extension-dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}

function ConnectionBanner({ connected, reconnectAttempt, lastError }) {
  const visible = !connected && (lastError != null || reconnectAttempt > 0);
  if (!visible) return null;
  return (
    <div className="loom-card loom-connection-banner">
      <span className="loom-connection-icon" aria-hidden="true">{lastError ? "⚠" : "⟳"}</span>
      <div className="loom-connection-body">
        <span className="loom-connection-title">
          {lastError ? "Live updates interrupted" : "Reconnecting to live updates"}
        </span>
        {lastError && <span className="loom-connection-reason">{lastError}</span>}
        <span className="loom-connection-hint">State keeps refreshing, but at a slower rate.</span>
      </div>
    </div>
  );
}

function useMeetingsList() {
  const [meetings, setMeetings] = useState([]);

  const fetchMeetings = useCallback(async () => {
    try {
      const res = await fetch("/api/meetings");
      if (res.ok) {
        const newMeetings = await res.json();
        setMeetings((prev) => {
          if (prev.length !== newMeetings.length) return newMeetings;
          const same = prev.every((m, i) => m.id === newMeetings[i].id && m.status === newMeetings[i].status);
          return same ? prev : newMeetings;
        });
      }
    } catch (err) {
      console.error("[Loom dashboard] Failed to fetch meetings:", err);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
    const interval = setInterval(fetchMeetings, 5000);
    return () => clearInterval(interval);
  }, [fetchMeetings]);

  return meetings;
}

export function App() {
  const [selectedMeeting, setSelectedMeeting] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("loom-theme") ?? "system");
  const [activeTab, setActiveTab] = usePersistedState("active-tab", "overview");
  const [activeType, setActiveType] = usePersistedState("active-type", "");
  const [collapsedRounds, setCollapsedRounds] = usePersistedState("collapsed-rounds", []);
  const [scrolledToBottom, setScrolledToBottom] = useState(true);
  const [extensions, setExtensions] = useState([]);
  const [extensionBanner, setExtensionBanner] = useState(null);
  const [orchestratorMessages, setOrchestratorMessages] = useState([]);

  const bannerTimeoutRef = useRef(null);
  const mainRef = useRef(null);

  const dismissExtensionBanner = useCallback(() => setExtensionBanner(null), []);

  const meetings = useMeetingsList();
  const { resetKey } = useSSEReset(selectedMeeting);
  const {
    state,
    participants,
    contributions,
    turnRequests,
    agentErrors,
    artifact,
    error,
  } = useMeetingApi(selectedMeeting, resetKey);

  const handleSSEEvent = useCallback((data) => {
    if (data.type === "contributions") {
      const newContribs = data.data;
      if (newContribs && newContribs.length > 0) {
        window.dispatchEvent(new CustomEvent("loom-new-contributions", { detail: newContribs }));
      }
    } else if (data.type === "state") {
      window.dispatchEvent(new CustomEvent("loom-state-update", { detail: data.data }));
    } else if (data.type === "participants") {
      window.dispatchEvent(new CustomEvent("loom-participants-update", { detail: data.data }));
    } else if (data.type === "agent_error") {
      window.dispatchEvent(new CustomEvent("loom-agent-error", { detail: data.data }));
    } else if (data.type === "artifact") {
      window.dispatchEvent(new CustomEvent("loom-artifact", { detail: data.data }));
    } else if (data.type === "turn_requests") {
      const newTrs = data.data;
      if (newTrs && newTrs.length > 0) {
        window.dispatchEvent(new CustomEvent("loom-new-turn-requests", { detail: newTrs }));
      }
    } else if (data.type === "orchestrator_messages") {
      const newMsgs = data.data;
      if (newMsgs && newMsgs.length > 0) {
        window.dispatchEvent(new CustomEvent("loom-orchestrator-messages", { detail: newMsgs }));
      }
    }
  }, []);

  const { connected, reconnectAttempt, lastError } = useSSE(selectedMeeting, handleSSEEvent);

  useEffect(() => {
    if (!selectedMeeting && meetings.length > 0) {
      setSelectedMeeting(meetings[0].meeting_id);
    }
  }, [meetings, selectedMeeting]);

  useEffect(() => {
    if (!selectedMeeting) return;
    let lastMaxId = 0;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/orchestrator_messages?meeting=${selectedMeeting}`);
        if (res.ok) {
          const data = await res.json();
          const msgs = data.messages || [];
          const newMaxId = msgs.length > 0 ? Math.max(...msgs.map((m) => m.id)) : 0;
          if (newMaxId > lastMaxId) {
            lastMaxId = newMaxId;
            setOrchestratorMessages(msgs);
          }
        }
      } catch (err) {
        console.error("[Loom dashboard] Failed to fetch orchestrator messages:", err);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [selectedMeeting]);

  useEffect(() => {
    if (!state?.fabric) return;
    const fabric = state.fabric;
    const extensionRegex = /\*\*User Input:\*\*\s*([^\n]+(?:\n(?!\*\*User Input:\*\*)[^\n]*)*)/g;
    const found = [];
    let match;
    while ((match = extensionRegex.exec(fabric)) !== null) {
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
  }, [state?.fabric, extensions.length]);

  useEffect(() => {
    return () => {
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    };
  }, []);

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
      if (e.key === "j") {
        window.scrollBy(0, 200);
      } else if (e.key === "k") {
        window.scrollBy(0, -200);
      } else if (e.key === "o") setActiveTab("overview");
      else if (e.key === "r") setActiveTab("orchestrator");
      else if (e.key === "t") setActiveTab("timeline");
      else if (e.key === "w") setActiveTab("fabric");
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [setActiveTab]);

  const scrollToBottom = useCallback(() => {
    if (mainRef.current) {
      mainRef.current.scrollTo({ top: mainRef.current.scrollHeight, behavior: "smooth" });
    }
  }, []);

  const participantNameMap = useMemo(() => {
    const map = new Map();
    for (const p of participants) map.set(p.id, p.name);
    return map;
  }, [participants]);

  const participantName = useCallback((id) => participantNameMap.get(id) ?? id, [participantNameMap]);

  const contributionTypes = useMemo(() => {
    const types = new Set();
    for (const c of contributions) types.add(c.type);
    return Array.from(types).sort();
  }, [contributions]);

  const filteredContributions = useMemo(() => {
    const type = activeType;
    return contributions.filter((c) => {
      if (type && c.type !== type) return false;
      return true;
    });
  }, [contributions, activeType]);

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

  const contributionsByParticipant = useMemo(() => {
    const map = {};
    for (const c of contributions) {
      const pid = c.participant_id;
      if (!map[pid]) map[pid] = {};
      map[pid][c.round] = (map[pid][c.round] ?? 0) + 1;
    }
    return map;
  }, [contributions]);

  const toggleRoundCollapse = useCallback((round) => {
    setCollapsedRounds((prev) =>
      prev.includes(round) ? prev.filter((r) => r !== round) : [...prev, round]
    );
  }, [setCollapsedRounds]);

  const isWeaving = state?.status === "weaving";
  const activeRound = state?.round ?? 0;
  const totalRounds = state?.max_rounds ?? 0;
  const activeAgentCount = thinkingParticipants.length;
  const errorCount = agentErrors.length;

  return (
    <ThemeProvider theme={theme} setTheme={setTheme}>
      <div className="loom-layout">
        {error && (
          <div className="loom-card loom-card-error loom-layout-error">
            <p className="loom-text">{error}</p>
            <button
              className="pure-button pure-button-primary loom-mt-sm"
              onClick={() => window.location.reload()}
            >
              Retry
            </button>
          </div>
        )}

         <ErrorBoundary fallbackMessage="Failed to render sidebar" label="Sidebar">
          <Sidebar
            state={state}
            participants={participants}
            theme={theme}
            setTheme={setTheme}
            agentErrors={agentErrors}
            contributionsByParticipant={contributionsByParticipant}
            selectedMeeting={selectedMeeting}
          />
         </ErrorBoundary>

        <main className="loom-main" ref={mainRef}>
          {state && (
            <ErrorBoundary fallbackMessage="Failed to render meeting header">
              <MeetingHeader
                state={state}
                connected={connected}
                reconnectAttempt={reconnectAttempt}
                activeAgentCount={activeAgentCount}
                errorCount={errorCount}
                selectedMeeting={selectedMeeting}
              />
            </ErrorBoundary>
          )}

          <ErrorBoundary fallbackMessage="Failed to render thinking banner">
            <ThinkingBanner thinkingParticipants={thinkingParticipants} />
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render extension banner">
            <ExtensionBanner
              banner={extensionBanner}
              onDismiss={dismissExtensionBanner}
            />
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render connection banner">
            <ConnectionBanner
              connected={connected}
              reconnectAttempt={reconnectAttempt}
              lastError={lastError}
            />
          </ErrorBoundary>

          <div className="pure-menu pure-menu-horizontal loom-tabs">
            <ul className="pure-menu-list">
              {["overview", "orchestrator", "timeline", "output", "fabric"].map((tab) => (
                <li key={tab} className={cn("pure-menu-item", activeTab === tab && "pure-menu-selected")}>
                  <button className="pure-menu-link" onClick={() => setActiveTab(tab)}>
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <ErrorBoundary fallbackMessage="Failed to render the overview tab">
            {activeTab === "overview" && state && (
              <OverviewTab
                state={state}
                contributions={contributions}
                turnRequests={turnRequests}
                participants={participants}
                agentErrors={agentErrors}
                participantName={participantName}
                totalRounds={totalRounds}
              />
            )}
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render the orchestrator tab">
            {activeTab === "orchestrator" && (
              <OrchestratorTab messages={orchestratorMessages} />
            )}
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render the timeline tab">
            {activeTab === "timeline" && (
              <TimelineTab
                contributions={contributions}
                groupedContributions={groupedContributions}
                filteredContributions={filteredContributions}
                isWeaving={isWeaving}
                thinkingParticipants={thinkingParticipants}
                activeType={activeType}
                onActiveTypeChange={setActiveType}
                contributionTypes={contributionTypes}
                collapsedRounds={collapsedRounds}
                onToggleCollapse={toggleRoundCollapse}
                agentErrors={agentErrors}
                participantName={participantName}
                turnRequests={turnRequests}
                extensions={extensions}
                activeRound={activeRound}
                maxRounds={state?.max_rounds}
              />
            )}
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render the output tab">
            {activeTab === "output" && (
              <OutputTab artifact={artifact} participants={participants} />
            )}
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render the fabric tab">
            {activeTab === "fabric" && (
              <FabricTab state={state} participants={participants} />
            )}
          </ErrorBoundary>

          {!scrolledToBottom && (
            <button className="loom-scroll-bottom" onClick={scrollToBottom}>
              ↓ New contributions
            </button>
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<App />);
}
