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
export function useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages, setRoundSummaries }) {
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
        // Dedup on stable row id when present; fall back to the normalized composite
        // key (participant_id + target_participant_id + round) — the old key used
        // `tr.target`, which is always undefined and collapsed every request from
        // the same participant (audit 11 UF2).
        const keyOf = (tr) =>
          tr.id != null ? `id:${tr.id}` : `${tr.participant_id}:${tr.target_participant_id}:${tr.round ?? ""}`;
        const seen = new Set(prev.map(keyOf));
        const fresh = newTrs.filter((tr) => tr && !seen.has(keyOf(tr)));
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

    const handleRoundSummaries = (e) => {
      const summaries = e.detail;
      if (summaries && typeof summaries === "object") {
        setRoundSummaries((prev) => {
          const prevStr = JSON.stringify(prev);
          const nextStr = JSON.stringify(summaries);
          return prevStr === nextStr ? prev : { ...summaries };
        });
      }
    };

    window.addEventListener("loom-new-contributions", handleContributions);
    window.addEventListener("loom-new-turn-requests", handleTurnRequests);
    window.addEventListener("loom-state-update", handleState);
    window.addEventListener("loom-participants-update", handleParticipants);
    window.addEventListener("loom-agent-error", handleAgentError);
    window.addEventListener("loom-artifact", handleArtifact);
    window.addEventListener("loom-orchestrator-messages", handleOrchestratorMessages);
    window.addEventListener("loom-round-summaries", handleRoundSummaries);

    return () => {
      window.removeEventListener("loom-new-contributions", handleContributions);
      window.removeEventListener("loom-new-turn-requests", handleTurnRequests);
      window.removeEventListener("loom-state-update", handleState);
      window.removeEventListener("loom-participants-update", handleParticipants);
      window.removeEventListener("loom-agent-error", handleAgentError);
      window.removeEventListener("loom-artifact", handleArtifact);
      window.removeEventListener("loom-orchestrator-messages", handleOrchestratorMessages);
      window.removeEventListener("loom-round-summaries", handleRoundSummaries);
    };
  }, []);
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
    // Visibility-aware (audit 17 PF3)
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      fetchStatus();
    }, 5000);
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
  const abortRef = useRef(null);

  const fetchMeetingData = useCallback(async (id) => {
    if (!id) {
      setLoading(false);
      return;
    }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const signal = controller.signal;
    setLoading(true);
    try {
      const res = await fetch(`/api/meeting?meeting=${id}&include_context=1&limit=100`, { signal });
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
      if (signal.aborted) return;
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
      let pageFailure = null;
      if (typeof total === "number" && all.length < total) {
        let nextOffset = (offset ?? 0) + (limit ?? all.length);
        while (all.length < total && nextOffset < total) {
          if (signal.aborted) break;
          try {
            const pres = await fetch(`/api/contributions?meeting=${id}&limit=${limit ?? 500}&offset=${nextOffset}&include_context=1`, { signal });
            if (!pres.ok) {
              pageFailure = `Failed to load contributions page at offset ${nextOffset} (HTTP ${pres.status})`;
              break;
            }
            const pdata = await pres.json();
            const batch = pdata.contributions ?? [];
            all = all.concat(batch);
            nextOffset += batch.length || (limit ?? 500);
          } catch (err) {
            if (err.name === "AbortError") break;
            pageFailure = `Failed to load contributions page at offset ${nextOffset}: ${err.message}`;
            break;
          }
        }
      }
      // Merge with any SSE-delivered rows that arrived during/after the snapshot
      // so a reconnect refetch cannot silently drop freshly broadcast contributions.
      setContributions((prev) => {
        if (prev.length === 0) return all;
        const byId = new Map(all.map((c) => [c.id, c]));
        for (const p of prev) if (!byId.has(p.id)) byId.set(p.id, p);
        return Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      });
      if (pageFailure) {
        setError(`Partial load: ${pageFailure} — some rounds may be missing. Reconnecting will retry.`);
      } else {
        setError(null);
      }
      lastPollIdRef.current = Math.max(...all.map((c) => c.id ?? 0), 0);
      window.dispatchEvent(new CustomEvent("loom-initial-contributions", { detail: all }));
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meetingId) {
      fetchMeetingData(meetingId);
    }
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [meetingId, fetchMeetingData, resetKey]);

  useEffect(() => {
    if (contributions.length > 0) {
      lastPollIdRef.current = Math.max(...contributions.map(c=>c.id), 0);
    }
  }, [contributions]);

  useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages, setRoundSummaries });

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
