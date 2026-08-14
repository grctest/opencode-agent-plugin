import { getTierConfig } from "./shared.js";
import { parseReflections, parseStats } from "./shared.js";
import { indexMeeting } from "./database.js";
import { Logger, LoomError } from "./logger.js";

const restorerLogger = new Logger();

/**
 * Restores in-memory meeting state from the database.
 * Used when extending a previously completed meeting.
 *
 * @param {Object} params
 * @param {import("./database.js").MeetingDatabase} params.db - Database instance
 * @param {import("./services/state-manager.js").StateManager} params.stateManager - State manager to populate
 * @param {string} params.meetingId - Meeting ID
 * @param {Object} params.options - Original meeting options
 * @returns {{ nextSpeakerId: string|null, callStats: Object }}
 */
export function restoreStateFromDb({ db, stateManager, meetingId, options }) {
  const meeting = db.getMeeting();
  if (!meeting) {
    throw new LoomError("Cannot resume: meeting not found in database", { phase: "resume", recoverable: false });
  }

  const nextSpeakerId = meeting.next_speaker_id ?? null;
  const callStats = parseStats(meeting.stats);

  const dbParts = db.getAllParticipantsWithStatus();
  const participants = dbParts.map((r) => ({
    config: {
      id: r.id,
      name: r.name,
      persona: r.persona,
      agenda: r.agenda,
      tier: r.tier,
      model: r.provider_id && r.model_id ? { providerID: r.provider_id, modelID: r.model_id } : undefined,
      domain: "general",
      domains: ["general"],
      known_biases: r.known_biases,
      communication_style: r.communication_style,
      preferred_contribution_types: r.preferred_contribution_types,
    },
    tier_config: getTierConfig(r.tier),
    session_id: r.session_id,
    session_version: r.session_version ?? 1,
    status: r.status,
    reflections: parseReflections(r.reflection),
    contributions_count: 0,
  }));

  const contributions = db.getContributions(meetingId);
  stateManager.restore({
    participants,
    question: meeting.question,
    context: meeting.context ?? "",
    fabric: meeting.fabric ?? "",
    max_rounds: meeting.max_rounds,
    convergence_mode: meeting.convergence,
    domain: meeting.domain,
    current_round: meeting.round,
    status: "weaving",
    weave: contributions.map((c) => ({
      id: c.id,
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      round: c.round,
      targets_which: c.targets_which ?? null,
      created_at: c.created_at,
    })),
    next_contribution_id: db.getMaxContributionId(),
  });

  const summaries = db.getRoundSummaries(meetingId);
  const roundMap = new Map();
  for (const c of contributions) {
    if (!roundMap.has(c.round)) {
      roundMap.set(c.round, { number: c.round, contributions: [], interjections: [], summary: summaries[c.round] ?? "" });
    }
    roundMap.get(c.round).contributions.push({
      id: c.id,
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      round: c.round,
      targets_which: c.targets_which ?? null,
      created_at: c.created_at,
    });
  }

  const interjections = db.getInterjections(meetingId);
  for (const ij of interjections) {
    const roundNum = ij.round ?? 1;
    if (!roundMap.has(roundNum)) {
      roundMap.set(roundNum, { number: roundNum, contributions: [], interjections: [], summary: summaries[roundNum] ?? "" });
    }
    roundMap.get(roundNum).interjections.push({
      participant_id: ij.participant_id,
      target_participant_id: ij.target_participant_id,
      priority: ij.priority,
      reason: ij.reason,
      granted: ij.granted,
      pushback: ij.pushback,
      resolved: ij.resolved,
    });
  }

  stateManager.setRounds(Array.from(roundMap.values()).sort((a, b) => a.number - b.number));

  const countByParticipant = {};
  for (const c of contributions) {
    countByParticipant[c.participant_id] = (countByParticipant[c.participant_id] ?? 0) + 1;
  }
  stateManager.setParticipantContributionCounts(countByParticipant);

  indexMeeting(db.getDatabasePath(), meetingId, options.opencodeSessionId ?? options.parentSessionId);

  restorerLogger.info("state_restored", "Meeting state restored from database", {
    meetingId: meetingId.slice(0, 8),
    participants: participants.length,
    rounds: roundMap.size,
    contributions: contributions.length,
  });

  return { nextSpeakerId, callStats };
}
