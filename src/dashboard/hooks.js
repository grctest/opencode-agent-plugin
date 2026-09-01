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
function hasToolCalls(arr) { return Array.isArray(arr) && arr.length > 0; }
function mergeToolCalls(prev, next) {
  // Prefer next if it has tool_calls and prev is empty/null — repairs stale empty snapshot
  // Otherwise keep prev to avoid overwriting with empty update
  if (hasToolCalls(next.tool_calls) && !hasToolCalls(prev.tool_calls)) return next;
  if (hasToolCalls(next.tool_calls) && hasToolCalls(prev.tool_calls) && next.tool_calls.length > prev.tool_calls.length) return next;
  // Also merge if next has tool_calls string vs array mismatch — normalize already done server-side, but keep latest
  return prev;
}

export function useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages, setRoundSummaries, setForumUpdateTrigger }) {
  useEffect(() => {
    const handleContributions = (e) => {
      const newContribs = e.detail;
      if (!newContribs || newContribs.length === 0) return;
      setContributions((prev) => {
        const byId = new Map(prev.map((c) => [c.id, c]));
        let changed = false;
        for (const nc of newContribs) {
          if (!nc || nc.id == null) continue;
          const existing = byId.get(nc.id);
          if (!existing) {
            byId.set(nc.id, nc);
            changed = true;
          } else {
            const merged = mergeToolCalls(existing, nc);
            if (merged !== existing) {
              byId.set(nc.id, merged);
              changed = true;
            } else if (JSON.stringify(existing) !== JSON.stringify(nc)) {
              // Content changed but tool_calls not the decider — update to latest to keep content fresh
              // Only replace if next has at least as much tool evidence
              const preferNext = hasToolCalls(nc.tool_calls) || !hasToolCalls(existing.tool_calls);
              if (preferNext) {
                byId.set(nc.id, nc);
                changed = true;
              }
            }
          }
        }
        if (!changed) {
          // Fast path: no new ids and no repairs
          const seen = new Set(prev.map((c) => c.id));
          const fresh = newContribs.filter((c) => c && c.id != null && !seen.has(c.id));
          if (fresh.length === 0) return prev;
        }
        return Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
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

    const handleAgentErrorsCleared = () => {
      setAgentErrors([]);
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

    const handleForumUpdate = () => {
      setForumUpdateTrigger((t) => t + 1);
    };

    window.addEventListener("loom-new-contributions", handleContributions);
    window.addEventListener("loom-new-turn-requests", handleTurnRequests);
    window.addEventListener("loom-state-update", handleState);
    window.addEventListener("loom-participants-update", handleParticipants);
    window.addEventListener("loom-agent-error", handleAgentError);
    window.addEventListener("loom-agent-errors-cleared", handleAgentErrorsCleared);
    window.addEventListener("loom-artifact", handleArtifact);
    window.addEventListener("loom-orchestrator-messages", handleOrchestratorMessages);
    window.addEventListener("loom-round-summaries", handleRoundSummaries);
    window.addEventListener("loom-forum-update", handleForumUpdate);

    return () => {
      window.removeEventListener("loom-new-contributions", handleContributions);
      window.removeEventListener("loom-new-turn-requests", handleTurnRequests);
      window.removeEventListener("loom-state-update", handleState);
      window.removeEventListener("loom-participants-update", handleParticipants);
      window.removeEventListener("loom-agent-error", handleAgentError);
      window.removeEventListener("loom-agent-errors-cleared", handleAgentErrorsCleared);
      window.removeEventListener("loom-artifact", handleArtifact);
      window.removeEventListener("loom-orchestrator-messages", handleOrchestratorMessages);
      window.removeEventListener("loom-round-summaries", handleRoundSummaries);
      window.removeEventListener("loom-forum-update", handleForumUpdate);
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
  const [forumTopics, setForumTopics] = useState([]);
  const [forumUpdateTrigger, setForumUpdateTrigger] = useState(0);
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
        let afterId = all.length > 0 ? Math.max(...all.map((c) => c.id ?? 0)) : 0;
        let guard = 0;
        while (all.length < total && guard < 100) {
          if (signal.aborted) break;
          guard++;
          try {
            const pres = await fetch(`/api/contributions?meeting=${id}&limit=${limit ?? 100}&after=${afterId}&include_context=1`, { signal });
            if (!pres.ok) {
              pageFailure = `Failed to load contributions page after ${afterId} (HTTP ${pres.status})`;
              break;
            }
            const pdata = await pres.json();
            const batch = pdata.contributions ?? [];
            if (batch.length === 0) break;
            all = all.concat(batch);
            afterId = Math.max(...batch.map((c) => c.id ?? 0), afterId);
            if (batch.length < (limit ?? 100)) break;
          } catch (err) {
            if (err.name === "AbortError") break;
            pageFailure = `Failed to load contributions page after ${afterId}: ${err.message}`;
            break;
          }
        }
      }
      // Merge with any SSE-delivered rows that arrived during/after the snapshot
      // so a reconnect refetch cannot silently drop freshly broadcast contributions.
      // Also repair stale empty tool_calls snapshots (P1): prefer the copy that has tool_calls.
      setContributions((prev) => {
        if (prev.length === 0) return all;
        const byId = new Map(all.map((c) => [c.id, c]));
        for (const p of prev) {
          const existing = byId.get(p.id);
          if (!existing) {
            byId.set(p.id, p);
          } else if (hasToolCalls(p.tool_calls) && !hasToolCalls(existing.tool_calls)) {
            byId.set(p.id, p);
          } else if (hasToolCalls(p.tool_calls) && hasToolCalls(existing.tool_calls) && p.tool_calls.length > existing.tool_calls.length) {
            byId.set(p.id, p);
          }
        }
        return Array.from(byId.values()).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      });
      if (pageFailure) {
        setError(`Partial load: ${pageFailure} — some rounds may be missing. Reconnecting will retry.`);
      } else {
        setError(null);
      }
      lastPollIdRef.current = Math.max(...all.map((c) => c.id ?? 0), 0);
      window.dispatchEvent(new CustomEvent("loom-initial-contributions", { detail: all }));
      // Fetch forum topics
      try {
        const forumRes = await fetch(`/api/forum/topics?meeting=${id}`, { signal });
        if (forumRes.ok) {
          const forumData = await forumRes.json();
          setForumTopics(forumData.topics ?? []);
        }
      } catch {}
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

  // Refresh forum topics when update trigger fires
  useEffect(() => {
    if (!meetingId || forumUpdateTrigger === 0) return;
    const controller = new AbortController();
    fetch(`/api/forum/topics?meeting=${meetingId}`, { signal: controller.signal })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => { if (data?.topics) setForumTopics(data.topics); })
      .catch(() => {});
    return () => controller.abort();
  }, [meetingId, forumUpdateTrigger]);

  useSSEHandlers({ setContributions, setTurnRequests, setState, setParticipants, setAgentErrors, setArtifact, setOrchestratorMessages, setRoundSummaries, setForumUpdateTrigger });

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
    forumTopics,
    loading,
    error,
    refetch: () => fetchMeetingData(meetingId),
  };
}
