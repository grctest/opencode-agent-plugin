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

export function useDebouncedCallback(callback, delay) {
  const timeoutRef = useRef(null);
  return useCallback((...args) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => callback(...args), delay);
  }, [callback, delay]);
}

export function useMeetingApi(meetingId, sseEvents) {
  const [state, setState] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [interjections, setInterjections] = useState([]);
  const [agentErrors, setAgentErrors] = useState([]);
  const [artifact, setArtifact] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMeetingData = useCallback(async (id) => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/meeting?meeting=${id}`);
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
      setContributions(data.contributions);
      setInterjections(data.interjections);
      setAgentErrors(data.agent_errors);
      setArtifact(data.artifact ?? null);
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
  }, [meetingId, fetchMeetingData]);

  useEffect(() => {
    if (!meetingId || !sseEvents) return;

    const handleContributions = (e) => {
      const newContribs = e.detail;
      if (newContribs && newContribs.length > 0) {
        setContributions((prev) => [...prev, ...newContribs]);
      }
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
        setAgentErrors((prev) => [...prev, errData]);
      }
    };

    const handleArtifact = (e) => {
      const artifactData = e.detail;
      if (artifactData) {
        setArtifact(artifactData);
      }
    };

    window.addEventListener("loom-new-contributions", handleContributions);
    window.addEventListener("loom-state-update", handleState);
    window.addEventListener("loom-participants-update", handleParticipants);
    window.addEventListener("loom-agent-error", handleAgentError);
    window.addEventListener("loom-artifact", handleArtifact);

    const handleReset = () => {
      if (meetingId) {
        fetchMeetingData(meetingId);
      }
    };
    window.addEventListener("loom-sse-reset", handleReset);

    return () => {
      window.removeEventListener("loom-new-contributions", handleContributions);
      window.removeEventListener("loom-state-update", handleState);
      window.removeEventListener("loom-participants-update", handleParticipants);
      window.removeEventListener("loom-agent-error", handleAgentError);
      window.removeEventListener("loom-artifact", handleArtifact);
      window.removeEventListener("loom-sse-reset", handleReset);
    };
  }, [meetingId, sseEvents]);

  return {
    state,
    participants,
    contributions,
    interjections,
    agentErrors,
    artifact,
    loading,
    error,
    refetch: () => fetchMeetingData(meetingId),
  };
}
