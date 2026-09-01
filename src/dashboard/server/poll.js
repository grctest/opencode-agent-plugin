import { DashboardApi } from "../api.js";
import { TUNING } from "../../config/defaults.js";
import { getConfig } from "../../config.js";
import { TERMINAL_STATUSES } from "../../constants.js";
import { getMeetingDbPath } from "../api/free.js";
import { sendSSE } from "./helpers.js";
import { onDatabaseWrite } from "../../services/write-notifier.js";

export function createPollSystem(directory) {
  const sseClients = new Map();
  const lastContributionId = new Map();
  const lastOrchestratorMsgId = new Map();
  const lastInterjectionId = new Map();
  const lastErrorId = new Map();
  const participantStatusCache = new Map();
  const lastRoundSummariesHash = new Map();
  const lastArtifactCreatedAt = new Map();
  const lastForumTopicId = new Map();
  const lastForumCommentId = new Map();

  const SLOW_CONSUMER_TIMEOUT_MS = 30000;
  const pendingQueues = new Map(); // meetingId -> Array<event>
  const pushUnsubscribes = new Map(); // meetingId -> unsubscribe fn

  const broadcast = (meetingId, event) => {
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    // Drain pending queue first if any
    const queue = pendingQueues.get(meetingId);
    if (queue && queue.length > 0) {
      for (const q of queue) {
        for (const entry of clients) {
          try {
            if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) continue;
            sendSSE(entry.controller, q);
          } catch { clients.delete(entry); }
        }
      }
      queue.length = 0;
    }
    for (const entry of clients) {
      try {
        if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) {
          if (!entry.slowSince) entry.slowSince = Date.now();
          else if (Date.now() - entry.slowSince > SLOW_CONSUMER_TIMEOUT_MS) clients.delete(entry);
          else {
            // Backpressure: queue instead of drop, cap 100
            if (!pendingQueues.has(meetingId)) pendingQueues.set(meetingId, []);
            const q = pendingQueues.get(meetingId);
            if (q.length < 100) q.push(event);
          }
          continue;
        }
        sendSSE(entry.controller, event);
        entry.slowSince = null;
      } catch {
        clients.delete(entry);
      }
    }
  };

  const pollSingleMeeting = (meetingId) => {
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    try {
      const dbPath = getMeetingDbPath(directory, meetingId);
      if (!dbPath) return;
      const api = DashboardApi.get(dbPath);
      const currentState = api.getState();
      if (currentState && TERMINAL_STATUSES.has(currentState.status)) {
        const wasTerminal = participantStatusCache.get(`terminal:${meetingId}`);
        if (!wasTerminal) participantStatusCache.set(`terminal:${meetingId}`, "true");
      }
      try {
        const summaries = api.getRoundSummaries(meetingId);
        const hash = JSON.stringify(summaries);
        const prevHash = lastRoundSummariesHash.get(meetingId);
        if (hash !== prevHash) {
          lastRoundSummariesHash.set(meetingId, hash);
          if (prevHash !== undefined) broadcast(meetingId, { type: "round_summaries", data: summaries, timestamp: new Date().toISOString() });
        }
      } catch {}
      try {
        const liveArtifact = api.getArtifact();
        if (liveArtifact && lastArtifactCreatedAt.get(meetingId) !== liveArtifact.created_at) {
          lastArtifactCreatedAt.set(meetingId, liveArtifact.created_at);
          broadcast(meetingId, { type: "artifact", data: liveArtifact, timestamp: new Date().toISOString() });
        }
      } catch {}
      const maxId = api.getMaxContributionId();
      const prevId = lastContributionId.get(meetingId) ?? 0;
      if (maxId > prevId) {
        lastContributionId.set(meetingId, maxId);
        const newContributions = api.getContributionsSince(prevId).map(c => ({ ...c, prompt_context: null }));
        broadcast(meetingId, { type: "contributions", data: newContributions, timestamp: new Date().toISOString() });
      }
      const maxMsgId = api.getMaxOrchestratorMessageId();
      const prevMsgId = lastOrchestratorMsgId.get(meetingId) ?? 0;
      if (maxMsgId > prevMsgId) {
        lastOrchestratorMsgId.set(meetingId, maxMsgId);
        const newMessages = api.getOrchestratorMessagesSince(prevMsgId, meetingId);
        if (newMessages.length > 0) broadcast(meetingId, { type: "orchestrator_messages", data: newMessages, timestamp: new Date().toISOString() });
      }
      const maxIjId = api.getMaxTurnRequestId();
      const prevIjId = lastInterjectionId.get(meetingId) ?? 0;
      if (maxIjId > prevIjId) {
        lastInterjectionId.set(meetingId, maxIjId);
        const newTurnRequests = api.getTurnRequestsSince(prevIjId);
        if (newTurnRequests.length > 0) broadcast(meetingId, { type: "turn_requests", data: newTurnRequests, timestamp: new Date().toISOString() });
      }
      const state = currentState;
      if (state) {
        const prevState = participantStatusCache.get(`state:${meetingId}`);
        const stateStr = JSON.stringify({
          status: state.status, round: state.round, stats: state.stats, fabric: state.fabric,
          reflecting_participants: state.reflecting_participants, querying_participants: state.querying_participants,
          evidence_participants: state.evidence_participants, summoning_participants: state.summoning_participants,
          max_rounds: state.max_rounds, convergence: state.convergence,
        });
        if (prevState !== stateStr) {
          participantStatusCache.set(`state:${meetingId}`, stateStr);
          broadcast(meetingId, { type: "state", data: state, timestamp: new Date().toISOString() });
        }
      }
      const participants = api.getParticipants();
      const prevStatus = participantStatusCache.get(meetingId);
      const newStatus = JSON.stringify(participants.map((p) => ({ id: p.id, status: p.status, tier: p.tier, model_id: p.model_id })));
      if (prevStatus !== newStatus) {
        participantStatusCache.set(meetingId, newStatus);
        broadcast(meetingId, { type: "participants", data: participants, timestamp: new Date().toISOString() });
      }
      const maxErrorId = api.getMaxErrorId();
      const prevErrorId = lastErrorId.get(meetingId) ?? 0;
      if (maxErrorId > prevErrorId) {
        lastErrorId.set(meetingId, maxErrorId);
        const newErrors = api.getAgentErrorsAfter(prevErrorId);
        for (const err of newErrors) broadcast(meetingId, { type: "agent_error", data: err, timestamp: new Date().toISOString() });
      } else if ((maxErrorId ?? 0) < prevErrorId) {
        lastErrorId.set(meetingId, 0);
        broadcast(meetingId, { type: "agent_errors_cleared", meeting_id: meetingId, timestamp: new Date().toISOString() });
      }
      // Forum updates
      try {
        const maxTopicId = api.getMaxForumTopicId();
        const prevTopicId = lastForumTopicId.get(meetingId) ?? 0;
        const maxCommentId = api.getMaxForumCommentId();
        const prevCommentId = lastForumCommentId.get(meetingId) ?? 0;
        if (maxTopicId > prevTopicId || maxCommentId > prevCommentId) {
          lastForumTopicId.set(meetingId, maxTopicId);
          lastForumCommentId.set(meetingId, maxCommentId);
          broadcast(meetingId, { type: "forum_update", meeting_id: meetingId, timestamp: new Date().toISOString() });
        }
      } catch {}
      // Drain pending backpressure queue
      const pendingQ = pendingQueues.get(meetingId);
      if (pendingQ && pendingQ.length > 0 && clients.size > 0) {
        for (let qi = pendingQ.length - 1; qi >= 0; qi--) {
          const evt = pendingQ[qi];
          let allDelivered = true;
          for (const entry of clients) {
            try {
              if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) { allDelivered = false; continue; }
              sendSSE(entry.controller, evt);
            } catch { clients.delete(entry); }
          }
          if (allDelivered) pendingQ.splice(qi, 1);
        }
        if (pendingQ.length === 0) pendingQueues.delete(meetingId);
      }
    } catch {}
  };

  const subscribeToWrites = (meetingId) => {
    if (pushUnsubscribes.has(meetingId)) return;
    pushUnsubscribes.set(meetingId, onDatabaseWrite(meetingId, () => pollSingleMeeting(meetingId)));
  };

  const unsubscribeFromWrites = (meetingId) => {
    const unsub = pushUnsubscribes.get(meetingId);
    if (unsub) { unsub(); pushUnsubscribes.delete(meetingId); }
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
  const getIdleInterval = () => { try { const v = getConfig()?.tuning?.DASHBOARD_IDLE_TIMEOUT_MS ?? TUNING.DASHBOARD_IDLE_TIMEOUT_MS; return Math.max(1000, Math.floor(v/12)); } catch { return 5000; }};
  const IDLE_POLL_INTERVAL = getIdleInterval();
  let currentPollInterval = ACTIVE_POLL_INTERVAL;
  let pollTimer = null;
  let consecutiveIdlePolls = 0;

  const pollMeetings = () => {
    // Per-meeting throttle: only throttle meetings with >3 clients, not globally
    let maxClientsForAnyMeeting = 0;
    for (const clients of sseClients.values()) maxClientsForAnyMeeting = Math.max(maxClientsForAnyMeeting, clients.size);
    if (maxClientsForAnyMeeting > 3 && currentPollInterval !== IDLE_POLL_INTERVAL) {
      currentPollInterval = IDLE_POLL_INTERVAL;
      restartPollTimer();
    } else if (maxClientsForAnyMeeting <= 3 && sseClients.size <= 10 && currentPollInterval !== ACTIVE_POLL_INTERVAL && consecutiveIdlePolls === 0) {
      // Restore active interval when load drops
      currentPollInterval = ACTIVE_POLL_INTERVAL;
      restartPollTimer();
    }
    let hadActivity = false;
    for (const [meetingId, clients] of sseClients) {
      if (clients.size === 0) continue;
      try {
        const dbPath = getMeetingDbPath(directory, meetingId);
        if (!dbPath) continue;
        const api = DashboardApi.get(dbPath);

        const currentState = api.getState();
        if (currentState && TERMINAL_STATUSES.has(currentState.status)) {
          const wasTerminal = participantStatusCache.get(`terminal:${meetingId}`);
          if (!wasTerminal) {
            participantStatusCache.set(`terminal:${meetingId}`, "true");
            // State broadcast unified below via stateStr diff; don't double-emit here
          }
          // Artifact broadcast unified via liveArtifact block below; don't double-emit
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
        // Live artifact for non-terminal synthesis (weaving) — seed on connect, broadcast first time too
        try {
          const liveArtifact = api.getArtifact();
          if (liveArtifact && lastArtifactCreatedAt.get(meetingId) !== liveArtifact.created_at) {
            lastArtifactCreatedAt.set(meetingId, liveArtifact.created_at);
            broadcast(meetingId, { type: "artifact", data: liveArtifact, timestamp: new Date().toISOString() });
            hadActivity = true;
          }
        } catch {}

        const maxId = api.getMaxContributionId();
        const prevId = lastContributionId.get(meetingId) ?? 0;
        if (maxId > prevId) {
          lastContributionId.set(meetingId, maxId);
          const newContributions = api.getContributionsSince(prevId).map(c => ({ ...c, prompt_context: null }));
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
        } else if ((maxErrorId ?? 0) < prevErrorId) {
          lastErrorId.set(meetingId, 0);
          broadcast(meetingId, {
            type: "agent_errors_cleared",
            meeting_id: meetingId,
            timestamp: new Date().toISOString(),
          });
          hadActivity = true;
        }

        // Drain any pending backpressure queue for this meeting
        const pendingQ = pendingQueues.get(meetingId);
        if (pendingQ && pendingQ.length > 0 && clients.size > 0) {
          for (let qi = pendingQ.length - 1; qi >= 0; qi--) {
            const evt = pendingQ[qi];
            let allDelivered = true;
            for (const entry of clients) {
              try {
                if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) {
                  allDelivered = false;
                  continue;
                }
                sendSSE(entry.controller, evt);
              } catch { clients.delete(entry); }
            }
            if (allDelivered) pendingQ.splice(qi, 1);
          }
          if (pendingQ.length === 0) pendingQueues.delete(meetingId);
        }
      } catch (err) {
        console.error(`[Loom dashboard] Poll error for meeting ${meetingId}:`, err instanceof Error ? err.message : String(err));
        broadcast(meetingId, {
          type: "error",
          data: { message: "internal error", meetingId, phase: "poll" },
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

  const stop = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); }
  };

  return {
    sseClients,
    lastContributionId,
    lastOrchestratorMsgId,
    lastInterjectionId,
    lastErrorId,
    participantStatusCache,
    broadcast,
    subscribeToWrites,
    unsubscribeFromWrites,
    pingTimer,
    pollMeetings,
    restartPollTimer,
    stop,
    getPollTimer: () => pollTimer,
    setPollTimer: (t) => { pollTimer = t; },
    getCurrentPollInterval: () => currentPollInterval,
    setCurrentPollInterval: (v) => { currentPollInterval = v; },
  };
}
