import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { Sidebar } from "./components/Sidebar.jsx";
import { OverviewTab } from "./components/OverviewTab.jsx";
import { TimelineTab } from "./components/TimelineTab.jsx";
import { OutputTab } from "./components/OutputTab.jsx";
import { ErrorBoundary } from "./ErrorBoundary.jsx";
import { usePersistedState, useMeetingApi, useSSEReset, useEmbeddingStatus } from "./hooks.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs.tsx";
import { Card, CardContent } from "./components/ui/card.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import { Alert, AlertTitle, AlertDescription } from "./components/ui/alert.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { Toaster } from "./components/ui/toast.tsx";
import { TriangleAlertIcon } from "lucide-react";

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
          try {
            const mRes = await fetch(`/api/meeting?meeting=${meetingId}&include_context=1&limit=1`);
            if (mRes.ok) {
              const mData = await mRes.json();
              if (mData.round_summaries) onEventRef.current({ type: "round_summaries", data: mData.round_summaries, timestamp });
              if (mData.artifact) onEventRef.current({ type: "artifact", data: mData.artifact, timestamp });
              if (mData.orchestrator_messages) onEventRef.current({ type: "orchestrator_messages", data: mData.orchestrator_messages, timestamp });
              if (mData.turn_requests) onEventRef.current({ type: "turn_requests", data: mData.turn_requests, timestamp });
              if (mData.agent_errors) {
                for (const err of mData.agent_errors) onEventRef.current({ type: "agent_error", data: err, timestamp });
              }
            }
          } catch {}
        } catch (err) {
          setLastError(err.message);
          window.dispatchEvent(new CustomEvent("loom-sse-error", { detail: { message: err.message, phase: "polling" } }));
        }
        if (!cancelled && fallbackPoll) {
          pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
        }
      };
      pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
    }
    const handleSSEError = (e) => { if (e?.detail?.message) setLastError(e.detail.message); };
    window.addEventListener("loom-sse-error", handleSSEError);
    function connect() {
      if (cancelled) return;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      const es = new EventSource(`/api/stream?meeting=${meetingId}`);
      esRef.current = es;
      es.onopen = () => {
        if (cancelled) return;
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
      };
      es.onerror = () => {
        if (cancelled) return;
        setConnected(false);
        es.close();
        esRef.current = null;
        setReconnectAttempt((prev) => {
          if (prev >= maxReconnectAttempts) { startPolling(); return prev; }
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
          if (data.type === "error") {
            setLastError(data.data?.message ?? "poll error");
            window.dispatchEvent(new CustomEvent("loom-sse-error", { detail: { message: data.data?.message ?? "poll error", phase: data.data?.phase ?? "poll" } }));
            return;
          }
          onEventRef.current(data);
        } catch (err) {
          setLastError(`Failed to parse SSE message: ${err.message}`);
          window.dispatchEvent(new CustomEvent("loom-sse-error", { detail: { message: `Failed to parse SSE message: ${err.message}`, phase: "parse" } }));
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
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
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
    if (theme === "light") document.documentElement.setAttribute("data-theme", "light");
    else if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
    localStorage.setItem("loom-theme", theme);
  }, [theme]);
  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
    handler(mediaQuery);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [theme]);
  return children;
}

function MeetingHeader({ state, activeAgentCount, errorCount }) {
  return (
    <div className="border-b pb-4 mb-5">
      <h1 className="text-xl font-bold leading-tight mb-2">{state.question}</h1>
      <div className="flex flex-wrap gap-3 items-center">
        {activeAgentCount > 0 && (
          <Badge variant="secondary" className="gap-1"><span aria-hidden="true">⏳</span> {activeAgentCount} active</Badge>
        )}
        {errorCount > 0 && (
          <Badge variant="destructive" className="gap-1"><TriangleAlertIcon className="size-3" /> {errorCount} error{errorCount > 1 ? "s" : ""}</Badge>
        )}
      </div>
    </div>
  );
}

function ExtensionBanner({ banner, onDismiss }) {
  if (!banner) return null;
  return (
    <Alert className="mb-4 bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900 flex items-center gap-3">
      <span aria-hidden="true" className="text-lg">🧵</span>
      <div className="flex-1 min-w-0">
        <AlertTitle className="text-blue-700 dark:text-blue-300">Loom Extended</AlertTitle>
        <AlertDescription className="truncate text-xs">{banner.prompt}</AlertDescription>
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">✕</Button>
    </Alert>
  );
}

function useMeetingsList() {
  const [meetings, setMeetings] = useState([]);
  const fetchMeetings = useCallback(async () => {
    try {
      const params = new URLSearchParams(window.location.search);
      const session = params.get("session");
      const url = session ? `/api/meetings?session=${encodeURIComponent(session)}` : "/api/meetings";
      const res = await fetch(url);
      if (res.ok) {
        const newMeetings = await res.json();
        setMeetings((prev) => {
          if (prev.length !== newMeetings.length) return newMeetings;
          const same = prev.every((m, i) => m.meeting_id === newMeetings[i].meeting_id && m.status === newMeetings[i].status);
          return same ? prev : newMeetings;
        });
      }
    } catch (err) { console.error("[Loom dashboard] Failed to fetch meetings:", err); }
  }, []);
  useEffect(() => {
    fetchMeetings();
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
  const { state, participants, contributions, turnRequests, orchestratorMessages, roundSummaries, agentErrors, artifact, error } = useMeetingApi(selectedMeeting, resetKey);
  const handleSSEEvent = useCallback((data) => {
    if (data.type === "contributions") {
      const newContribs = data.data;
      if (newContribs && newContribs.length > 0) window.dispatchEvent(new CustomEvent("loom-new-contributions", { detail: newContribs }));
    } else if (data.type === "state") window.dispatchEvent(new CustomEvent("loom-state-update", { detail: data.data }));
    else if (data.type === "participants") window.dispatchEvent(new CustomEvent("loom-participants-update", { detail: data.data }));
    else if (data.type === "agent_error") window.dispatchEvent(new CustomEvent("loom-agent-error", { detail: data.data }));
    else if (data.type === "artifact") window.dispatchEvent(new CustomEvent("loom-artifact", { detail: data.data }));
    else if (data.type === "turn_requests") {
      const newTrs = data.data;
      if (newTrs && newTrs.length > 0) window.dispatchEvent(new CustomEvent("loom-new-turn-requests", { detail: newTrs }));
    } else if (data.type === "orchestrator_messages") window.dispatchEvent(new CustomEvent("loom-orchestrator-messages", { detail: data.data }));
    else if (data.type === "round_summaries") window.dispatchEvent(new CustomEvent("loom-round-summaries", { detail: data.data }));
  }, []);
  const { connected, reconnectAttempt } = useSSE(selectedMeeting, handleSSEEvent);
  useEffect(() => {
    if (meetings.length > 0 && !selectedMeeting) {
      const params = new URLSearchParams(window.location.search);
      const urlMeeting = params.get("meeting");
      const urlSession = params.get("session");
      if (urlMeeting && meetings.some((m) => m.meeting_id === urlMeeting)) { setSelectedMeeting(urlMeeting); return; }
      if (urlSession) { if (meetings.length > 0) setSelectedMeeting(meetings[0].meeting_id); return; }
      setSelectedMeeting(meetings[0].meeting_id);
    }
  }, [meetings, selectedMeeting]);
  useEffect(() => {
    if (!selectedMeeting) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("meeting") !== selectedMeeting) {
      params.set("meeting", selectedMeeting);
      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState(null, "", newUrl);
    }
  }, [selectedMeeting]);
  useEffect(() => {
    if (contributions.length > 0) window.dispatchEvent(new CustomEvent("loom-initial-contributions", { detail: contributions }));
  }, [contributions]);
  useEffect(() => {
    if (!state?.fabric) return;
    const fabric = state.fabric;
    if (!fabric.includes("**Original Question:**")) return;
    const extensionRegex = /\*\*User Input:\*\*\s*([^\n]+(?:\n(?!\*\*User Input:\*\*)[^\n]*)*)/g;
    const found = [];
    let match;
    while ((match = extensionRegex.exec(fabric)) !== null) found.push(match[1].trim());
    if (found.length > extensions.length) {
      const newExtension = found[found.length - 1];
      setExtensions(found);
      setExtensionBanner({ prompt: newExtension, timestamp: Date.now() });
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
      bannerTimeoutRef.current = setTimeout(() => setExtensionBanner(null), 8000);
    } else if (found.length !== extensions.length) setExtensions(found);
  }, [state?.fabric, extensions.length]);
  useEffect(() => () => { if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current); }, []);
  const participantNameMap = useMemo(() => { const map = new Map(); for (const p of participants) map.set(p.id, p.name); return map; }, [participants]);
  const participantName = useCallback((id) => participantNameMap.get(id) ?? id, [participantNameMap]);
  const groupedContributions = useMemo(() => {
    const groups = new Map();
    for (const c of contributions) {
      if (!groups.has(c.round)) groups.set(c.round, []);
      groups.get(c.round).push(c);
    }
    return Array.from(groups.entries()).map(([round, contribs]) => [round, contribs.slice().sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || ((a.id ?? 0) - (b.id ?? 0)))]).sort((a, b) => a[0] - b[0]);
  }, [contributions]);
  const thinkingParticipants = useMemo(() => participants.filter((p) => p.status === "speaking"), [participants]);
  const reflectingParticipants = useMemo(() => { const ids = state?.reflecting_participants ?? []; return participants.filter((p) => ids.includes(p.id)); }, [participants, state?.reflecting_participants]);
  const queryingParticipants = useMemo(() => { const ids = state?.querying_participants ?? []; return participants.filter((p) => ids.includes(p.id)); }, [participants, state?.querying_participants]);
  const evidenceParticipants = useMemo(() => { const ids = state?.evidence_participants ?? []; return participants.filter((p) => ids.includes(p.id)); }, [participants, state?.evidence_participants]);
  const summoningParticipants = useMemo(() => { const ids = state?.summoning_participants ?? []; return participants.filter((p) => ids.includes(p.id)); }, [participants, state?.summoning_participants]);
  const contributionsByParticipant = useMemo(() => { const map = {}; for (const c of contributions) { const pid = c.participant_id; if (!map[pid]) map[pid] = {}; map[pid][c.round] = (map[pid][c.round] ?? 0) + 1; } return map; }, [contributions]);
  const contributionCountsByParticipant = useMemo(() => { const map = {}; for (const c of contributions) { const pid = c.participant_id; if (!map[pid]) map[pid] = { contributions: 0, reflections: 0 }; if (c.type === "reflection") map[pid].reflections++; else map[pid].contributions++; } return map; }, [contributions]);
  const toggleRoundCollapse = useCallback((round) => { setCollapsedRounds((prev) => prev.includes(round) ? prev.filter((r) => r !== round) : [...prev, round]); }, [setCollapsedRounds]);
  const isWeaving = state?.status === "weaving";
  const activeRound = state?.round ?? 0;
  const totalRounds = state?.max_rounds ?? 0;
  const activeAgentCount = thinkingParticipants.length;
  const errorCount = agentErrors.length;
  return (
    <ThemeProvider theme={theme} setTheme={setTheme}>
      <TooltipProvider delayDuration={0}>
        <Toaster />
        <div className="flex h-[100dvh] overflow-hidden">
          {error && (
            <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-lg px-4">
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle>Failed to load</AlertTitle>
                <AlertDescription className="flex items-center justify-between gap-2">
                  <span>{error}</span>
                  <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Retry</Button>
                </AlertDescription>
              </Alert>
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
          <main className="flex-1 overflow-y-auto p-6">
            {state && (
              <ErrorBoundary fallbackMessage="Failed to render meeting header">
                <MeetingHeader state={state} activeAgentCount={activeAgentCount} errorCount={errorCount} />
              </ErrorBoundary>
            )}
            <ErrorBoundary fallbackMessage="Failed to render extension banner">
              <ExtensionBanner banner={extensionBanner} onDismiss={dismissExtensionBanner} />
            </ErrorBoundary>
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList variant="line" className="w-full justify-start">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="output">Output</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="pt-4">
                <ErrorBoundary fallbackMessage="Failed to render the overview tab">
                  {state && (
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
                  )}
                </ErrorBoundary>
              </TabsContent>
              <TabsContent value="timeline" className="pt-4">
                <ErrorBoundary fallbackMessage="Failed to render the timeline tab">
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
                </ErrorBoundary>
              </TabsContent>
              <TabsContent value="output" className="pt-4">
                <ErrorBoundary fallbackMessage="Failed to render the output tab">
                  <OutputTab artifact={artifact} participants={participants} />
                </ErrorBoundary>
              </TabsContent>
            </Tabs>
          </main>
        </div>
      </TooltipProvider>
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
