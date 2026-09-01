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
  return participants.find((p) => p?.status !== "failed" && p?.status !== "passed") || null;
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

export function normalizeQuestionForMatch(q) {
  if (typeof q !== "string") return "";
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export function findExistingQueryResponse(weave, { batchId, fallbackBatchIds = [], targetId, contributionType, question, sourceId, round }) {
  if (!Array.isArray(weave) || !targetId || !contributionType) return null;
  const norm = normalizeQuestionForMatch(question);
  // 1) Exact batch match (strict)
  if (batchId) {
    const exact = weave.find((c) => c.batch_id === batchId && c.participant_id === targetId && c.type === contributionType && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === norm);
    if (exact) return exact;
  }
  for (const fb of fallbackBatchIds) {
    if (!fb || fb === batchId) continue;
    const exactFb = weave.find((c) => c.batch_id === fb && c.participant_id === targetId && c.type === contributionType && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === norm);
    if (exactFb) return exactFb;
  }
  // 2) Broader: same round + source + target + type + normalized question (handles batchId drift after retry/status reset)
  if (round != null && sourceId) {
    const broad = weave.find((c) => c.round === round && c.participant_id === targetId && c.type === contributionType && c.prompt_context?.source_participant_id === sourceId && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === norm);
    if (broad) return broad;
  }
  // 3) Last fallback: any matching target+type+question in last 20 contributions (very lenient)
  const lenient = weave.find((c) => c.participant_id === targetId && c.type === contributionType && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === norm);
  if (lenient) return lenient;
  return null;
}
