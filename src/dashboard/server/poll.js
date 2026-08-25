import { DashboardApi } from "../api.js";
import { getMeetingDbPath } from "../api/free.js";
import { sendSSE } from "./helpers.js";

export function createPollSystem(directory) {
  const sseClients = new Map();
  const lastContributionId = new Map();
  const lastOrchestratorMsgId = new Map();
  const lastInterjectionId = new Map();
  const lastErrorId = new Map();
  const participantStatusCache = new Map();
  const lastMtime = new Map();
  const lastRoundSummariesHash = new Map();
  const lastArtifactCreatedAt = new Map();

  const SLOW_CONSUMER_TIMEOUT_MS = 30000;

  const broadcast = (meetingId, event) => {
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    for (const entry of clients) {
      try {
        sendSSE(entry.controller, event);
        entry.slowSince = null;
      } catch {
        clients.delete(entry);
      }
    }
  };

  const pingTimer = setInterval(() => {
    for (const [meetingId, clients] of sseClients) {
      if (clients.size === 0) continue;
      const now = Date.now();
      for (const entry of clients) {
        try {
          if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) {
            if (!entry.slowSince) entry.slowSince = now;
            else if (now - entry.slowSince > SLOW_CONSUMER_TIMEOUT_MS) clients.delete(entry);
            continue;
          }
          entry.controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          entry.slowSince = null;
        } catch {
          clients.delete(entry);
        }
      }
    }
  }, 15000);
  if (pingTimer.unref) pingTimer.unref();

  const ACTIVE_POLL_INTERVAL = 1000;
  const IDLE_POLL_INTERVAL = 5000;
  let currentPollInterval = ACTIVE_POLL_INTERVAL;
  let pollTimer = null;
  let consecutiveIdlePolls = 0;

  const TERMINAL_STATUSES = new Set(["converged", "cancelled", "timeout", "max_rounds_reached", "aborted", "deadlocked"]);

  const pollMeetings = () => {
    let hadActivity = false;
    for (const [meetingId, clients] of sseClients) {
      if (clients.size === 0) continue;
      try {
        const dbPath = getMeetingDbPath(directory, meetingId);
        if (!dbPath) continue;
        const api = DashboardApi.get(dbPath);
        const currentMtime = api.refreshIfStale();
        lastMtime.set(meetingId, currentMtime);

        const currentState = api.getState();
        if (currentState && TERMINAL_STATUSES.has(currentState.status)) {
          const wasTerminal = participantStatusCache.get(`terminal:${meetingId}`);
          if (!wasTerminal) {
            participantStatusCache.set(`terminal:${meetingId}`, "true");
            broadcast(meetingId, { type: "state", data: currentState, timestamp: new Date().toISOString() });
          }
          const artifact = api.getArtifact();
          if (artifact && participantStatusCache.get(`artifact:${meetingId}`) !== artifact.created_at) {
            participantStatusCache.set(`artifact:${meetingId}`, artifact.created_at);
            broadcast(meetingId, { type: "artifact", data: artifact, timestamp: new Date().toISOString() });
          }
          // Still poll round_summaries and other data even in terminal to ensure final summaries stream
        }
        // Always poll round_summaries (even in terminal) for live overview/timeline summaries
        try {
          const summaries = api.getRoundSummaries(meetingId);
          const hash = JSON.stringify(summaries);
          const prevHash = lastRoundSummariesHash.get(meetingId);
          if (hash !== prevHash) {
            lastRoundSummariesHash.set(meetingId, hash);
            if (prevHash !== undefined) {
              broadcast(meetingId, { type: "round_summaries", data: summaries, timestamp: new Date().toISOString() });
              hadActivity = true;
            } else {
              // Don't broadcast initial load — client already has it via /api/meeting, but store hash
              // Store without broadcast to avoid duplicate on first poll
            }
          }
        } catch {}
        // Live artifact for non-terminal synthesis (weaving)
        try {
          const liveArtifact = api.getArtifact();
          if (liveArtifact && lastArtifactCreatedAt.get(meetingId) !== liveArtifact.created_at) {
            const prevAt = lastArtifactCreatedAt.get(meetingId);
            lastArtifactCreatedAt.set(meetingId, liveArtifact.created_at);
            if (prevAt !== undefined) {
              broadcast(meetingId, { type: "artifact", data: liveArtifact, timestamp: new Date().toISOString() });
              hadActivity = true;
            }
          } else if (!liveArtifact) {
            // No artifact yet, keep cache empty
          }
        } catch {}

        const maxId = api.getMaxContributionId();
        const prevId = lastContributionId.get(meetingId) ?? 0;
        if (maxId > prevId) {
          lastContributionId.set(meetingId, maxId);
          const newContributions = api.getContributionsSince(prevId);
          broadcast(meetingId, {
            type: "contributions",
            data: newContributions,
            timestamp: new Date().toISOString(),
          });
          hadActivity = true;
        }

        const maxMsgId = api.getMaxOrchestratorMessageId();
        const prevMsgId = lastOrchestratorMsgId.get(meetingId) ?? 0;
        if (maxMsgId > prevMsgId) {
          lastOrchestratorMsgId.set(meetingId, maxMsgId);
          const newMessages = api.getOrchestratorMessagesSince(prevMsgId, meetingId);
          if (newMessages.length > 0) {
            broadcast(meetingId, {
              type: "orchestrator_messages",
              data: newMessages,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }

        const maxIjId = api.getMaxTurnRequestId();
        const prevIjId = lastInterjectionId.get(meetingId) ?? 0;
        if (maxIjId > prevIjId) {
          lastInterjectionId.set(meetingId, maxIjId);
          const newTurnRequests = api.getTurnRequestsSince(prevIjId);
          if (newTurnRequests.length > 0) {
            broadcast(meetingId, {
              type: "turn_requests",
              data: newTurnRequests,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }

        const state = currentState;
        if (state) {
          const prevState = participantStatusCache.get(`state:${meetingId}`);
          // Widen diff to include fields that drive Timeline thinking placeholders and Overview
          const stateStr = JSON.stringify({
            status: state.status,
            round: state.round,
            stats: state.stats,
            fabric: state.fabric,
            reflecting_participants: state.reflecting_participants,
            querying_participants: state.querying_participants,
            evidence_participants: state.evidence_participants,
            summoning_participants: state.summoning_participants,
            max_rounds: state.max_rounds,
            convergence: state.convergence,
          });
          if (prevState !== stateStr) {
            participantStatusCache.set(`state:${meetingId}`, stateStr);
            broadcast(meetingId, {
              type: "state",
              data: state,
              timestamp: new Date().toISOString(),
            });
            hadActivity = true;
          }
        }

        const participants = api.getParticipants();
        const statusKey = meetingId;
        const prevStatus = participantStatusCache.get(statusKey);
        const newStatus = JSON.stringify(participants.map((p) => ({ id: p.id, status: p.status, tier: p.tier, model_id: p.model_id })));
        if (prevStatus !== newStatus) {
          participantStatusCache.set(statusKey, newStatus);
          broadcast(meetingId, {
            type: "participants",
            data: participants,
            timestamp: new Date().toISOString(),
          });
          hadActivity = true;
        }

        const maxErrorId = api.getMaxErrorId();
        const prevErrorId = lastErrorId.get(meetingId) ?? 0;
        if (maxErrorId > prevErrorId) {
          lastErrorId.set(meetingId, maxErrorId);
          const newErrors = api.getAgentErrorsAfter(prevErrorId);
          for (const err of newErrors) {
            broadcast(meetingId, {
              type: "agent_error",
              data: err,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Loom dashboard] Poll error for meeting ${meetingId}:`, message);
        broadcast(meetingId, {
          type: "error",
          data: { message, meetingId, phase: "poll" },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (hadActivity) {
      consecutiveIdlePolls = 0;
      if (currentPollInterval !== ACTIVE_POLL_INTERVAL) {
        currentPollInterval = ACTIVE_POLL_INTERVAL;
        restartPollTimer();
      }
    } else {
      consecutiveIdlePolls++;
      if (consecutiveIdlePolls > 5 && currentPollInterval !== IDLE_POLL_INTERVAL) {
        currentPollInterval = IDLE_POLL_INTERVAL;
        restartPollTimer();
      }
    }

    for (const meetingId of [...lastContributionId.keys()]) {
      const clients = sseClients.get(meetingId);
      if (!clients || clients.size === 0) {
        if (clients) sseClients.delete(meetingId);
        lastContributionId.delete(meetingId);
        lastOrchestratorMsgId.delete(meetingId);
        lastInterjectionId.delete(meetingId);
        lastErrorId.delete(meetingId);
        lastMtime.delete(meetingId);
        participantStatusCache.delete(meetingId);
        participantStatusCache.delete(`state:${meetingId}`);
        participantStatusCache.delete(`terminal:${meetingId}`);
        participantStatusCache.delete(`artifact:${meetingId}`);
        lastRoundSummariesHash.delete(meetingId);
        lastArtifactCreatedAt.delete(meetingId);
      }
    }
  };

  const restartPollTimer = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollMeetings, currentPollInterval);
  };

  pollTimer = setInterval(pollMeetings, currentPollInterval);

  return {
    sseClients,
    lastContributionId,
    lastOrchestratorMsgId,
    lastInterjectionId,
    lastErrorId,
    participantStatusCache,
    lastMtime,
    broadcast,
    pingTimer,
    pollMeetings,
    restartPollTimer,
    getPollTimer: () => pollTimer,
    setPollTimer: (t) => { pollTimer = t; },
    getCurrentPollInterval: () => currentPollInterval,
    setCurrentPollInterval: (v) => { currentPollInterval = v; },
  };
}
