import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { cn } from "./utils.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { OverviewTab } from "./components/OverviewTab.jsx";
import { TimelineTab } from "./components/TimelineTab.jsx";
import { OutputTab } from "./components/OutputTab.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { usePersistedState, useMeetingApi, useSSEReset, useEmbeddingStatus } from "./hooks.js";

const POLLING_FALLBACK_INTERVAL = 3000;

function useSSE(meetingId, onEvent) {
  const [connected, setConnected] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [lastError, setLastError] = useState(null);
  const esRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pollingRef = useRef(null);
  const lastPollIdRef = useRef(0);
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
        // Visibility pause (audit 11 UF7 / audit 17 PF3): hidden tabs skip API calls
        if (typeof document !== "undefined" && document.hidden) {
          pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
          return;
        }
        try {
          const timestamp = new Date().toISOString();
          const cRes = await fetch(`/api/contributions?meeting=${meetingId}&since=${lastPollIdRef.current}&include_context=1`);
          if (cRes.ok) {
            const contribs = await cRes.json();
            const arr = Array.isArray(contribs) ? contribs : (contribs.contributions ?? []);
            if (arr.length > 0) {
              lastPollIdRef.current = Math.max(...arr.map((c) => c.id ?? 0), lastPollIdRef.current);
              onEventRef.current({ type: "contributions", data: arr, timestamp });
            }
          }
          const sRes = await fetch(`/api/state?meeting=${meetingId}`);
          if (sRes.ok) {
            const sData = await sRes.json();
            onEventRef.current({ type: "state", data: sData, timestamp });
          }
          const pRes = await fetch(`/api/participants?meeting=${meetingId}`);
          if (pRes.ok) {
            const pData = await pRes.json();
            onEventRef.current({ type: "participants", data: pData, timestamp });
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
        // Gap-fill: fetch any contributions missed during disconnect via incremental API.
        // This is the SOLE recovery path — no unconditional full refetch on open (audit 11 UF4).
        fetch(`/api/contributions?meeting=${meetingId}&since=${lastPollIdRef.current}&include_context=1`).then(async (r) => {
          if (r.ok) {
            const data = await r.json().catch(() => null);
            const arr = Array.isArray(data) ? data : (data?.contributions ?? []);
            if (arr.length > 0) {
              lastPollIdRef.current = Math.max(...arr.map((c) => c.id ?? 0), lastPollIdRef.current);
              onEventRef.current({ type: "contributions", data: arr, timestamp: new Date().toISOString() });
            }
          }
        }).catch(() => {});
        fallbackPoll = false;
        if (pollingRef.current) clearTimeout(pollingRef.current);
        setConnected(true);
        setReconnectAttempt(0);
        setLastError(null);
        // Note: no loom-sse-reset dispatch here — resetting on every open triggered
        // the heavy /api/meeting refetch twice per load and fully on each reconnect
        // (audit 11 UF4). The gap-fill above covers missed contributions; state
        // refresh happens through the normal SSE state events.
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

  useEffect(() => {
    const handleInitial = (e) => {
      const contributions = e.detail;
      if (Array.isArray(contributions) && contributions.length > 0) {
        lastPollIdRef.current = Math.max(...contributions.map(c=>c.id), 0, lastPollIdRef.current);
      }
    };
    window.addEventListener("loom-initial-contributions", handleInitial);
    window.addEventListener("loom-new-contributions", handleInitial);
    return () => {
      window.removeEventListener("loom-initial-contributions", handleInitial);
      window.removeEventListener("loom-new-contributions", handleInitial);
    };
  }, []);

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
    document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
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

function MeetingHeader({ state, activeAgentCount, errorCount }) {
  return (
    <div className="loom-main-header">
      <h1 className="loom-title-lg loom-mb-sm">{state.question}</h1>
      <div className="loom-flex loom-flex-wrap loom-gap-md loom-items-center">
        {activeAgentCount > 0 && (
          <span className="loom-text-xs loom-text-active">
            <span aria-hidden="true">⏳</span> {activeAgentCount} active
          </span>
        )}
        {errorCount > 0 && (
          <span className="loom-text-xs loom-text-agent-errors">
            <span aria-hidden="true">⚠</span> {errorCount} error{errorCount > 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}



function ExtensionBanner({ banner, onDismiss }) {
  if (!banner) return null;
  return (
    <div className="loom-extension-banner">
      <span className="loom-extension-icon" aria-hidden="true">🧵</span>
      <div className="loom-extension-content">
        <span className="loom-extension-title">Loom Extended</span>
        <span className="loom-extension-prompt">{banner.prompt}</span>
      </div>
      <button className="loom-extension-dismiss" onClick={onDismiss}>✕</button>
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
          const same = prev.every((m, i) => m.meeting_id === newMeetings[i].meeting_id && m.status === newMeetings[i].status);
          return same ? prev : newMeetings;
        });
      }
    } catch (err) {
      console.error("[Loom dashboard] Failed to fetch meetings:", err);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
    // Visibility-aware polling (audit 11 UF7 / audit 17 PF3): skip fetches in hidden tabs
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchMeetings();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchMeetings]);

  return meetings;
}

export function App() {
  const [selectedMeeting, setSelectedMeeting] = useState("");
  const [theme, setTheme] = useState(() => localStorage.getItem("loom-theme") ?? "system");
  const [activeTab, setActiveTab] = usePersistedState("active-tab", "overview");
  const [collapsedMap, setCollapsedMap] = usePersistedState("collapsed-rounds", {});
  const collapsedRounds = collapsedMap[selectedMeeting] ?? [];
  const setCollapsedRounds = useCallback((updater) => {
    setCollapsedMap((prev) => {
      const current = prev[selectedMeeting] ?? [];
      const next = typeof updater === "function" ? updater(current) : updater;
      return { ...prev, [selectedMeeting]: next };
    });
  }, [selectedMeeting, setCollapsedMap]);
  const [extensions, setExtensions] = useState([]);
  const [extensionBanner, setExtensionBanner] = useState(null);

  const bannerTimeoutRef = useRef(null);

  const dismissExtensionBanner = useCallback(() => setExtensionBanner(null), []);

  const meetings = useMeetingsList();
  const { resetKey } = useSSEReset(selectedMeeting);
  const embeddingStatus = useEmbeddingStatus();
  const {
    state,
    participants,
    contributions,
    turnRequests,
    orchestratorMessages,
    roundSummaries,
    agentErrors,
    artifact,
    embeddingModel,
    embeddingDim,
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
      window.dispatchEvent(new CustomEvent("loom-orchestrator-messages", { detail: data.data }));
    }
  }, []);

  const { connected, reconnectAttempt, lastError } = useSSE(selectedMeeting, handleSSEEvent);

  useEffect(() => {
    if (meetings.length > 0 && !selectedMeeting) {
      setSelectedMeeting(meetings[0].meeting_id);
    }
  }, [meetings, selectedMeeting]);

  // Sync lastPollIdRef for SSE fallback from initial contributions
  useEffect(() => {
    if (contributions.length > 0) {
      window.dispatchEvent(new CustomEvent("loom-initial-contributions", { detail: contributions }));
    }
  }, [contributions]);

  useEffect(() => {
    if (!state?.fabric) return;
    const fabric = state.fabric;
    if (!fabric.includes("**Original Question:**")) return;
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

  const participantNameMap = useMemo(() => {
    const map = new Map();
    for (const p of participants) map.set(p.id, p.name);
    return map;
  }, [participants]);

  const participantName = useCallback((id) => participantNameMap.get(id) ?? id, [participantNameMap]);

  const groupedContributions = useMemo(() => {
    const groups = new Map();
    for (const c of contributions) {
      if (!groups.has(c.round)) groups.set(c.round, []);
      groups.get(c.round).push(c);
    }
    return Array.from(groups.entries())
      .map(([round, contribs]) => [
        round,
        contribs.slice().sort((a, b) =>
          (a.created_at || "").localeCompare(b.created_at || "") ||
          ((a.id ?? 0) - (b.id ?? 0))
        ),
      ])
      .sort((a, b) => a[0] - b[0]);
  }, [contributions]);

   const thinkingParticipants = useMemo(() => {
    return participants.filter((p) => p.status === "speaking");
  }, [participants]);

  const reflectingParticipants = useMemo(() => {
    const ids = state?.reflecting_participants ?? [];
    return participants.filter((p) => ids.includes(p.id));
  }, [participants, state?.reflecting_participants]);

  const queryingParticipants = useMemo(() => {
    const ids = state?.querying_participants ?? [];
    return participants.filter((p) => ids.includes(p.id));
  }, [participants, state?.querying_participants]);

  const evidenceParticipants = useMemo(() => {
    const ids = state?.evidence_participants ?? [];
    return participants.filter((p) => ids.includes(p.id));
  }, [participants, state?.evidence_participants]);

  const summoningParticipants = useMemo(() => {
    const ids = state?.summoning_participants ?? [];
    return participants.filter((p) => ids.includes(p.id));
  }, [participants, state?.summoning_participants]);

  const contributionsByParticipant = useMemo(() => {
    const map = {};
    for (const c of contributions) {
      const pid = c.participant_id;
      if (!map[pid]) map[pid] = {};
      map[pid][c.round] = (map[pid][c.round] ?? 0) + 1;
    }
    return map;
  }, [contributions]);

  const contributionCountsByParticipant = useMemo(() => {
    const map = {};
    for (const c of contributions) {
      const pid = c.participant_id;
      if (!map[pid]) map[pid] = { contributions: 0, reflections: 0 };
      if (c.type === "reflection") {
        map[pid].reflections++;
      } else {
        map[pid].contributions++;
      }
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
            contributionCountsByParticipant={contributionCountsByParticipant}
            selectedMeeting={selectedMeeting}
            embeddingStatus={embeddingStatus}
            connected={connected}
            reconnectAttempt={reconnectAttempt}
            reflectingParticipants={reflectingParticipants}
            orchestratorMessages={orchestratorMessages}
          />
         </ErrorBoundary>

        <main className="loom-main">
          {state && (
            <ErrorBoundary fallbackMessage="Failed to render meeting header">
              <MeetingHeader
                state={state}
                activeAgentCount={activeAgentCount}
                errorCount={errorCount}
              />
            </ErrorBoundary>
          )}

          <ErrorBoundary fallbackMessage="Failed to render extension banner">
            <ExtensionBanner
              banner={extensionBanner}
              onDismiss={dismissExtensionBanner}
            />
          </ErrorBoundary>

          <div className="pure-menu pure-menu-horizontal loom-tabs" role="tablist" aria-label="Meeting views">
            <ul className="pure-menu-list">
              {["overview", "timeline", "output"].map((tab) => (
                <li key={tab} className={cn("pure-menu-item", activeTab === tab && "pure-menu-selected")} role="presentation">
                  <button
                    className="pure-menu-link"
                    role="tab"
                    aria-selected={activeTab === tab}
                    aria-controls={`panel-${tab}`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <ErrorBoundary fallbackMessage="Failed to render the overview tab">
            {activeTab === "overview" && state && (
              <div id="panel-overview" role="tabpanel" aria-label="Overview">
                <OverviewTab
                  state={state}
                  contributions={contributions}
                  turnRequests={turnRequests}
                  participants={participants}
                  agentErrors={agentErrors}
                  orchestratorMessages={orchestratorMessages}
                  participantName={participantName}
                  totalRounds={totalRounds}
                  activeRound={activeRound}
                />
              </div>
            )}
          </ErrorBoundary>

           <ErrorBoundary fallbackMessage="Failed to render the timeline tab">
            {activeTab === "timeline" && (
              <div id="panel-timeline" role="tabpanel" aria-label="Timeline">
                <TimelineTab
                  contributions={contributions}
                  groupedContributions={groupedContributions}
                  isWeaving={isWeaving}
                  thinkingParticipants={thinkingParticipants}
                  reflectingParticipants={reflectingParticipants}
                  queryingParticipants={queryingParticipants}
                  evidenceParticipants={evidenceParticipants}
                  summoningParticipants={summoningParticipants}
                  collapsedRounds={collapsedRounds}
                  onToggleCollapse={toggleRoundCollapse}
                  agentErrors={agentErrors}
                  participantName={participantName}
                 turnRequests={turnRequests}
                   extensions={extensions}
                   activeRound={activeRound}
                   maxRounds={state?.max_rounds}
                   orchestratorMessages={orchestratorMessages}
                   roundSummaries={roundSummaries}
                   selectedMeeting={selectedMeeting}
                 />
              </div>
            )}
          </ErrorBoundary>

          <ErrorBoundary fallbackMessage="Failed to render the output tab">
            {activeTab === "output" && (
              <div id="panel-output" role="tabpanel" aria-label="Output">
                <OutputTab artifact={artifact} participants={participants} />
              </div>
            )}
          </ErrorBoundary>
        </main>
      </div>
    </ThemeProvider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary fallbackMessage="The Loom dashboard encountered a fatal error" label="Root">
      <App />
    </ErrorBoundary>
  );
}
