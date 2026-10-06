import { DashboardApi } from "../api.js";
import { TUNING } from "../../config/defaults.js";
import { getConfig } from "../../config.js";
import { TERMINAL_STATUSES } from "../../constants.js";
import { getMeetingDbPath } from "../api/free.js";
import { sendSSE } from "./helpers.js";
import { onDatabaseWrite } from "../../services/write-notifier.js";
import { registerPollSystem, resetMeetingCursorsIn } from "./poll-cursors.js";

export function createPollSystem(directory) {
  const sseClients = new Map();
  const lastContributionId = new Map();
  const lastOrchestratorMsgId = new Map();
  const lastErrorId = new Map();
  const participantStatusCache = new Map();
  const lastRoundSummariesHash = new Map();
  const lastArtifactCreatedAt = new Map();
  const lastForumTopicId = new Map();
  const lastForumCommentId = new Map();

  const SLOW_CONSUMER_TIMEOUT_MS = 30000;
  const PENDING_QUEUE_MAX = 100;
  const pendingQueues = new Map(); // meetingId -> Array<event>
  const pushUnsubscribes = new Map(); // meetingId -> unsubscribe fn

  // Events whose payload is a complete snapshot of the resource they describe.
  // A newer copy fully supersedes an older one, so a stalled client's backlog
  // can collapse to one entry per type instead of growing without bound — and
  // a stale `state` can never overwrite a newer one. Delta events
  // (contributions, orchestrator_messages, agent_error, …) are
  // NOT listed here: every row must be delivered, so they stay queued as-is.
  const SNAPSHOT_EVENT_TYPES = new Set([
    "state",
    "participants",
    "round_summaries",
    "artifact",
    "rate_limit",
    "rate_limit_cleared",
  ]);

  const enqueuePending = (meetingId, event) => {
    if (!pendingQueues.has(meetingId)) pendingQueues.set(meetingId, []);
    const q = pendingQueues.get(meetingId);
    if (SNAPSHOT_EVENT_TYPES.has(event.type)) {
      // Replace the superseded snapshot in place, preserving queue order.
      const existing = q.findIndex((e) => e.type === event.type);
      if (existing !== -1) { q[existing] = event; return; }
    }
    if (q.length < PENDING_QUEUE_MAX) q.push(event);
  };

  /**
   * Attempt delivery of everything queued for a meeting. Entries that no live
   * client could accept are RETAINED for the next drain.
   *
   * A ReadableStream with the default CountQueuingStrategy has
   * highWaterMark 1, so desiredSize is 0 after a single enqueue. Several
   * broadcast() calls fire in one synchronous poll pass; the first fills the
   * buffer and the rest queue. This drain runs in that same synchronous tick,
   * before the consumer has pulled, so it must not discard what it could not
   * deliver — doing so silently lost the `state` event, freezing the sidebar
   * round/status and the Overview LLM-call counter until a page refresh.
   */
  const flushPending = (meetingId) => {
    const queue = pendingQueues.get(meetingId);
    if (!queue || queue.length === 0) return;
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    const undelivered = [];
    for (const event of queue) {
      let accepted = false;
      for (const entry of clients) {
        try {
          if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) continue;
          sendSSE(entry.controller, event);
          accepted = true;
          entry.slowSince = null;
        } catch { clients.delete(entry); }
      }
      if (!accepted) undelivered.push(event);
    }
    queue.length = 0;
    queue.push(...undelivered);
    if (queue.length === 0) pendingQueues.delete(meetingId);
  };

  const broadcast = (meetingId, event) => {
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    flushPending(meetingId);
    for (const entry of clients) {
      try {
        if (entry.controller.desiredSize !== undefined && entry.controller.desiredSize <= 0) {
          // Track how long this client has been unable to accept, then queue
          // the event so it is replayed once the socket drains.
          //
          // The previous shape was `if (!slowSince) slowSince = now; else if
          // (too long) evict; else enqueue` — which meant the FIRST event to
          // hit a full buffer only set the timestamp and fell through to
          // `continue`, never queued. Since `state` is broadcast after
          // contributions/messages have already filled the buffer, it was
          // always that first event, so it was dropped and never replayed:
          // the sidebar round/status and the Overview LLM-call counter froze
          // until a page refresh. Eviction is now decided on its own, and
          // every undelivered event is queued.
          if (!entry.slowSince) entry.slowSince = Date.now();
          if (Date.now() - entry.slowSince > SLOW_CONSUMER_TIMEOUT_MS) {
            clients.delete(entry);
            continue;
          }
          enqueuePending(meetingId, event);
          continue;
        }
        sendSSE(entry.controller, event);
        entry.slowSince = null;
      } catch {
        clients.delete(entry);
      }
    }
  };

  const lastRateLimitState = new Map();

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
        const rateLimitState = state.rate_limit_state ?? null;
        const prevRateLimit = lastRateLimitState.get(meetingId) ?? null;
        const rateLimitStr = JSON.stringify(rateLimitState);
        if (JSON.stringify(prevRateLimit) !== rateLimitStr) {
          lastRateLimitState.set(meetingId, rateLimitState);
          if (rateLimitState) {
            broadcast(meetingId, { type: "rate_limit", data: rateLimitState, timestamp: new Date().toISOString() });
          } else {
            broadcast(meetingId, { type: "rate_limit_cleared", data: { meeting_id: meetingId }, timestamp: new Date().toISOString() });
          }
        }
      }
      const participants = api.getParticipants();
      const prevStatus = participantStatusCache.get(meetingId);
      const newStatus = JSON.stringify(participants.map((p) => ({ id: p.id, status: p.status, category: p.category, model_id: p.model_id })));
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
      flushPending(meetingId);
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
      const newStatus = JSON.stringify(participants.map((p) => ({ id: p.id, status: p.status, category: p.category, model_id: p.model_id })));
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
        flushPending(meetingId);
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

  const unregister = registerPollSystem({
    participantStatusCache,
    lastRoundSummariesHash,
    lastArtifactCreatedAt,
    pendingQueues,
  });

  const stop = () => {
    try { unregister(); } catch {}
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); }
  };

  return {
    sseClients,
    lastContributionId,
    lastOrchestratorMsgId,
    lastErrorId,
    participantStatusCache,
    broadcast,
    resetMeetingCursors: (meetingId) => resetMeetingCursorsIn({
      participantStatusCache,
      lastRoundSummariesHash,
      lastArtifactCreatedAt,
      pendingQueues,
    }, meetingId),
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
