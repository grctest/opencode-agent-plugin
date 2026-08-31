const listeners = new Map();
const pendingTimers = new Map();

export function onDatabaseWrite(meetingId, callback) {
  if (!listeners.has(meetingId)) listeners.set(meetingId, new Set());
  listeners.get(meetingId).add(callback);
  return () => {
    const s = listeners.get(meetingId);
    if (s) { s.delete(callback); if (s.size === 0) listeners.delete(meetingId); }
  };
}

export function notifyDatabaseWrite(meetingId, _table) {
  const cbs = listeners.get(meetingId);
  if (!cbs || cbs.size === 0) return;
  if (pendingTimers.has(meetingId)) return;
  const timer = setTimeout(() => {
    pendingTimers.delete(meetingId);
    for (const cb of listeners.get(meetingId) ?? []) {
      try { cb(meetingId); } catch {}
    }
  }, 50);
  pendingTimers.set(meetingId, timer);
  if (timer.unref) timer.unref();
}
