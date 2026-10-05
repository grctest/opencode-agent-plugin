/**
 * Poll cursor registry — lets the control plane force a fresh snapshot
 * broadcast for a meeting without importing the dashboard server.
 *
 * Background: the poll loop only broadcasts `state`/`participants` when its
 * diff-cache changes. If a server restart + resume lands between the client's
 * SSE connect and the next diff, the watcher can sit pinned on the pre-resume
 * round until the next state change. Resetting the snapshot-gated caches
 * before a resumed run starts makes the next poll rebroadcast unconditionally.
 *
 * Delta cursors (contributions, orchestrator messages, turn requests, errors)
 * are deliberately NOT reset: replaying them would rebroadcast up to 500 rows
 * per stream and risk skipping rows past the replay cap on large meetings.
 */

const systems = new Set();

export function registerPollSystem(system) {
  systems.add(system);
  return () => systems.delete(system);
}

export function resetMeetingCursorsIn(system, meetingId) {
  if (!system || !meetingId) return;
  try { system.participantStatusCache?.delete(meetingId); } catch {}
  try { system.participantStatusCache?.delete(`state:${meetingId}`); } catch {}
  try { system.lastRoundSummariesHash?.delete(meetingId); } catch {}
  try { system.lastArtifactCreatedAt?.delete(meetingId); } catch {}
  try { system.pendingQueues?.delete(meetingId); } catch {}
}

export function resetPollCursorsForMeeting(meetingId) {
  for (const system of systems) {
    try { resetMeetingCursorsIn(system, meetingId); } catch {}
  }
}
