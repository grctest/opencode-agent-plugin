export { TERMINAL_STATUSES } from "../../constants.js";

export function resolveCaller(participants, weave, sessionId) {
  let caller = participants.find((p) => p.session_id === sessionId) || null;
  if (caller) return caller;
  caller = participants.find((p) => p?.status === "speaking") || null;
  if (caller) return caller;
  try {
    const roundWeave = weave.filter((c) => c.round != null);
    if (roundWeave.length > 0) {
      const lastId = roundWeave[roundWeave.length - 1].participant_id;
      caller = participants.find((p) => p.config.id === lastId) || null;
      if (caller) return caller;
    }
  } catch {}
  return participants.find((p) => p?.status !== "failed" && p?.status !== "passed" && p?.status !== "muted") || null;
}

export function resolveModel(engine, target, stateManager) {
  let model = null;
  try { model = engine.getParticipantModel ? engine.getParticipantModel(target) : null; } catch {}
  if (model) return model;
  try {
    for (const p of stateManager.getParticipants()) {
      if (!p || p.status === "failed") continue;
      const m = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(p) : null; } catch { return null; }})();
      if (m) return m;
    }
  } catch {}
  return null;
}

export function buildBatchId(meetingId, round, callerId) {
  return `inline-${meetingId}-${round}-${callerId ?? "unknown"}`;
}
