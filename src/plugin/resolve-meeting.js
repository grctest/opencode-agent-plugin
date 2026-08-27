import { findMeetingBySessionId } from "../database.js";

export function createResolveMeeting(directory, meetingResolveCache) {
  const RESOLVE_CACHE_TTL_MS = 30000;
  const RESOLVE_CACHE_MAX = 100;

  return async function resolveMeeting(sessionID, client) {
    const cached = meetingResolveCache.get(sessionID);
    if (cached && (Date.now() - cached.at) < RESOLVE_CACHE_TTL_MS) {
      return cached.meeting;
    }
    if (cached && (Date.now() - cached.at) < 1000) {
      return cached.meeting;
    }
    const meeting = await findMeetingBySessionId(directory, sessionID);
    if (meeting) {
      if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
        const oldest = meetingResolveCache.keys().next().value;
        meetingResolveCache.delete(oldest);
      }
      meetingResolveCache.set(sessionID, { meeting, at: Date.now() });
      return meeting;
    }

    try {
      const sessionResult = await client.session.get({
        path: { id: sessionID },
        query: { directory },
      });
      const parentID = sessionResult?.data?.parentID;
      if (parentID && parentID !== sessionID) {
        const parentMeeting = await findMeetingBySessionId(directory, parentID);
        if (parentMeeting) {
          if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
            const oldest = meetingResolveCache.keys().next().value;
            meetingResolveCache.delete(oldest);
          }
          meetingResolveCache.set(sessionID, { meeting: parentMeeting, at: Date.now() });
          return parentMeeting;
        }
      }
    } catch {
    }
    return null;
  };
}
