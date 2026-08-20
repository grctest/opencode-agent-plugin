import { useState, useEffect, useCallback, useRef } from "react";

export function usePersistedState(key, defaultValue) {
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

/**
 * Subscribes to SSE reset events for a meeting and returns a resetKey
 * that increments on reconnection (useful for triggering refetch).
 */
export function useSSEReset(meetingId) {
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (!meetingId) return;

    const handleReset = () => setResetKey((k) => k + 1);
    window.addEventListener("loom-sse-reset", handleReset);
    return () => window.removeEventListener("loom-sse-reset", handleReset);
  }, [meetingId]);

  return { resetKey };
}

/**
 * Applies incremental SSE updates to meeting data state.
 * Returns event handlers to attach to window.
 */
export function useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages }) {
  useEffect(() => {
    const handleContributions = (e) => {
      const newContribs = e.detail;
      if (!newContribs || newContribs.length === 0) return;
      setContributions((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        const fresh = newContribs.filter((c) => c && c.id != null && !seen.has(c.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    };

    const handleTurnRequests = (e) => {
      const newTrs = e.detail;
      if (!newTrs || newTrs.length === 0) return;
      setTurnRequests((prev) => {
        const seen = new Set(prev.map((tr) => `${tr.participant_id}:${tr.target}`));
        const fresh = newTrs.filter((tr) => tr && !seen.has(`${tr.participant_id}:${tr.target}`));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    };

    const handleState = (e) => {
      const stateData = e.detail;
      if (stateData) {
        setState((prev) => prev ? { ...prev, ...stateData } : stateData);
      }
    };

    const handleParticipants = (e) => {
      const partsData = e.detail;
      if (partsData) {
        setParticipants(partsData);
      }
    };

    const handleAgentError = (e) => {
      const errData = e.detail;
      if (errData) {
        setAgentErrors((prev) => {
          const key = `${errData.participant_id}:${errData.round}:${errData.error_type}`;
          const exists = prev.some((x) => `${x.participant_id}:${x.round}:${x.error_type}` === key);
          return exists ? prev : [...prev, errData];
        });
      }
    };

    const handleArtifact = (e) => {
      const artifactData = e.detail;
      if (artifactData) {
        setArtifact(artifactData);
      }
    };

    const handleOrchestratorMessages = (e) => {
      const newMsgs = e.detail;
      if (!newMsgs || newMsgs.length === 0) return;
      setOrchestratorMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = newMsgs.filter((m) => m && m.id != null && !seen.has(m.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    };

    window.addEventListener("loom-new-contributions", handleContributions);
    window.addEventListener("loom-new-turn-requests", handleTurnRequests);
    window.addEventListener("loom-state-update", handleState);
    window.addEventListener("loom-participants-update", handleParticipants);
    window.addEventListener("loom-agent-error", handleAgentError);
    window.addEventListener("loom-artifact", handleArtifact);
    window.addEventListener("loom-orchestrator-messages", handleOrchestratorMessages);

    return () => {
      window.removeEventListener("loom-new-contributions", handleContributions);
      window.removeEventListener("loom-new-turn-requests", handleTurnRequests);
      window.removeEventListener("loom-state-update", handleState);
      window.removeEventListener("loom-participants-update", handleParticipants);
      window.removeEventListener("loom-agent-error", handleAgentError);
      window.removeEventListener("loom-artifact", handleArtifact);
      window.removeEventListener("loom-orchestrator-messages", handleOrchestratorMessages);
    };
  }, []);
}

const POLLING_FALLBACK_INTERVAL = 3000;

export function useSSE(meetingId, onEvent) {
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
        try {
          const timestamp = new Date().toISOString();
          const cRes = await fetch(`/api/contributions?meeting=${meetingId}&since=${lastPollIdRef.current}&include_context=0`);
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
          window.dispatchEvent(new CustomEvent("loom-sse-error", { detail: { message: err.message, phase: "polling" } }));
        }
        if (!cancelled && fallbackPoll) {
          pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
        }
      };
      pollingRef.current = setTimeout(poll, POLLING_FALLBACK_INTERVAL);
    }

    const handleSSEError = (e) => {
      if (e?.detail?.message) setLastError(e.detail.message);
    };
    window.addEventListener("loom-sse-error", handleSSEError);

    function connect() {
      if (cancelled) return;
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      const es = new EventSource(`/api/stream?meeting=${meetingId}`);
      esRef.current = es;
      es.onopen = () => {
        if (cancelled) return;
        fetch(`/api/contributions?meeting=${meetingId}&since=${lastPollIdRef.current}&include_context=0`).then(async (r) => {
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
        window.dispatchEvent(new CustomEvent("loom-sse-reset"));
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
          if (data.type === "contributions" && Array.isArray(data.data)) {
            lastPollIdRef.current = Math.max(...data.data.map((c) => c.id ?? 0), lastPollIdRef.current);
          }
          onEventRef.current(data);
        } catch (err) {
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

  return { connected, reconnectAttempt, lastError, lastPollIdRef };
}

export function useEmbeddingStatus() {
  const [status, setStatus] = useState({ state: "idle", models: [] });

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/models");
      if (res.ok) {
        const data = await res.json();
        setStatus({
          state: data.status?.state ?? "idle",
          model: data.status?.model ?? null,
          dims: data.status?.dims ?? null,
          maxTokens: data.status?.maxTokens ?? null,
          message: data.status?.message ?? null,
          models: data.models ?? [],
        });
      }
    } catch {
      // Ignore transient fetch errors — keep last known status
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  return status;
}

export function useMeetingApi(meetingId, resetKey) {
  const [state, setState] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [turnRequests, setTurnRequests] = useState([]);
  const [orchestratorMessages, setOrchestratorMessages] = useState([]);
  const [roundSummaries, setRoundSummaries] = useState({});
  const [agentErrors, setAgentErrors] = useState([]);
  const [artifact, setArtifact] = useState(null);
  const [embeddingModel, setEmbeddingModel] = useState(null);
  const [embeddingDim, setEmbeddingDim] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const lastPollIdRef = useRef(0);

  const fetchMeetingData = useCallback(async (id) => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/meeting?meeting=${id}&include_context=0&limit=100`);
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("Meeting not found. It may have been deleted or is still initializing.");
        }
        throw new Error(`Failed to load meeting (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (data.error) {
        throw new Error(data.error);
      }
      setState(data.state);
      setParticipants(data.participants);
      setTurnRequests(data.turn_requests ?? []);
      setOrchestratorMessages(data.orchestrator_messages ?? []);
      setRoundSummaries(data.round_summaries ?? {});
      setAgentErrors(data.agent_errors);
      setArtifact(data.artifact ?? null);
      setEmbeddingModel(data.embedding_model ?? null);
      setEmbeddingDim(data.embedding_dim ?? null);
      const { total, limit, offset } = data.contributionsPagination ?? {};
      let all = [...(data.contributions ?? [])];
      if (typeof total === "number" && all.length < total) {
        let nextOffset = (offset ?? 0) + (limit ?? all.length);
        while (all.length < total && nextOffset < total) {
          try {
            const pres = await fetch(`/api/contributions?meeting=${id}&limit=${limit ?? 500}&offset=${nextOffset}&include_context=0`);
            if (!pres.ok) break;
            const pdata = await pres.json();
            const batch = pdata.contributions ?? [];
            all = all.concat(batch);
            nextOffset += batch.length || (limit ?? 500);
          } catch {
            break;
          }
        }
      }
      setContributions(all);
      lastPollIdRef.current = Math.max(...all.map((c) => c.id ?? 0), 0);
      window.dispatchEvent(new CustomEvent("loom-initial-contributions", { detail: all }));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meetingId) {
      fetchMeetingData(meetingId);
    }
  }, [meetingId, fetchMeetingData, resetKey]);

  useEffect(() => {
    if (contributions.length > 0) {
      lastPollIdRef.current = Math.max(...contributions.map(c=>c.id), 0);
    }
  }, [contributions]);

  useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages });

  return {
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
    loading,
    error,
    refetch: () => fetchMeetingData(meetingId),
  };
}
