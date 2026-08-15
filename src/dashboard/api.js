import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolveLoomBaseDir } from "../paths.js";

const DB_CACHE_MAX = 10;

const DB_REFRESH_INTERVAL_MS = 2000;

const DB_TTL_MS = 5 * 60 * 1000;

function parseReflections(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string");
  } catch { /* legacy plain text */ }
  return [raw];
}

export class DashboardApi {
  /** @type {Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {number} */
  #lastModified = 0;
  /** @type {number} */
  #openedAt = 0;
  /** @type {number} */
  #fileMtimeMs = 0;

  /** @type {Map<string, DashboardApi>} */
  static cache = new Map();

  static get(dbPath) {
    const existing = DashboardApi.cache.get(dbPath);
    if (existing) {
      existing.#touch();
      existing.#maybeRefresh();
      return existing;
    }
    DashboardApi.#evictExpired();
    if (DashboardApi.cache.size >= DB_CACHE_MAX) {
      let oldest = null;
      for (const [path, api] of DashboardApi.cache) {
        if (!oldest || api.#lastModified < oldest.api.#lastModified) {
          oldest = { path, api };
        }
      }
      if (oldest) {
        oldest.api.#db.close();
        DashboardApi.cache.delete(oldest.path);
      }
    }
    const api = new DashboardApi(dbPath);
    DashboardApi.cache.set(dbPath, api);
    return api;
  }

  static #evictExpired() {
    const now = Date.now();
    for (const [path, api] of DashboardApi.cache) {
      if (now - api.#lastModified > DB_TTL_MS) {
        api.#db.close();
        DashboardApi.cache.delete(path);
      }
    }
  }

  static closeAll() {
    for (const api of DashboardApi.cache.values()) {
      api.#db.close();
    }
    DashboardApi.cache.clear();
  }

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath, { readonly: true });
    this.#lastModified = Date.now();
    this.#openedAt = Date.now();
    try {
      const stat = statSync(this.#dbPath);
      this.#fileMtimeMs = stat.mtimeMs;
    } catch {
      // DB file may have been deleted between cache check and stat — not fatal
    }
  }

  #touch() {
    this.#lastModified = Date.now();
  }

  #maybeRefresh() {
    const now = Date.now();
    if (now - this.#openedAt <= DB_REFRESH_INTERVAL_MS) return;

    try {
      const stat = statSync(this.#dbPath);
      const mtimeMs = stat.mtimeMs;
      if (mtimeMs !== this.#fileMtimeMs) {
        this.#db.close();
        this.#db = new Database(this.#dbPath, { readonly: true });
        this.#fileMtimeMs = mtimeMs;
      }
    } catch {
      // DB file may have been deleted or locked — will retry on next access
    }
    this.#openedAt = now;
  }

  getState() {
    const row = this.#db
      .prepare(
        `SELECT id as meeting_id, question, context, status, round, max_rounds, convergence, fabric, domain, stats, created_at
         FROM meetings LIMIT 1`,
      )
      .get();
    if (!row) return null;
    if (row.stats) {
      try {
        row.stats = JSON.parse(row.stats);
      } catch {
        row.stats = {};
      }
    }
    return row;
  }

  getStateWithStats() {
    return this.getState();
  }

  getArtifact() {
    const row = this.#db
      .prepare(
        `SELECT content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at
         FROM artifacts LIMIT 1`,
      )
      .get();
    if (!row) return null;
    const parse = (json) => {
      if (!json) return [];
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return {
      content: row.content,
      decisions: parse(row.decisions),
      action_items: parse(row.action_items),
      dissent: parse(row.dissent),
      refusals: parse(row.refusals),
      open_questions: parse(row.open_questions),
      confidence: row.confidence,
      created_at: row.created_at,
    };
  }

  getParticipants() {
    const rows = this.#db
      .prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, status, reflection
         FROM participants ORDER BY tier ASC`,
      )
      .all();
    return rows.map((r) => ({
      ...r,
      reflection: parseReflections(r.reflection),
    }));
  }

  getAgentErrors() {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors ORDER BY id ASC`,
      )
      .all();
  }

  getMaxOrchestratorMessageId() {
    const row = this.#db.prepare(`SELECT MAX(id) as max_id FROM orchestrator_messages`).get();
    return row?.max_id ?? 0;
  }

  getContributions(limit = 100, offset = 0) {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, created_at
         FROM contributions ORDER BY round ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  getContributionsCount() {
    const row = this.#db.prepare(`SELECT COUNT(*) as count FROM contributions`).get();
    return row?.count ?? 0;
  }

  getContributionsSince(sinceId) {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC`,
      )
      .all(sinceId);
  }

  getInterjections() {
    return this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content, priority, granted, pushback, resolved, created_at
         FROM interjections ORDER BY id ASC`,
      )
      .all();
  }

  getTurnRequests() {
    return this.#db
      .prepare(
        `SELECT participant_id, target_participant_id, round, content as reason, priority
         FROM interjections ORDER BY id ASC`,
      )
      .all()
      .map((r) => ({
        participant_id: r.participant_id,
        target: r.target_participant_id ?? "",
        priority: r.priority,
        reason: r.reason,
      }));
  }

  getMaxTurnRequestId() {
    const row = this.#db.prepare(`SELECT MAX(id) as max_id FROM interjections`).get();
    return row?.max_id ?? 0;
  }

  getTurnRequestsSince(sinceId) {
    return this.#db
      .prepare(
        `SELECT participant_id, target_participant_id, content as reason, priority
         FROM interjections WHERE id > ? ORDER BY id ASC`,
      )
      .all(sinceId);
  }

  getOrchestratorMessagesSince(sinceId, meetingId) {
    return this.#db
      .prepare(
        `SELECT id, msg_type, role, content, created_at
         FROM orchestrator_messages WHERE id > ? AND meeting_id = ? ORDER BY id ASC`,
      )
      .all(sinceId, meetingId)
      .map((r) => ({
        id: r.id,
        type: r.msg_type,
        role: r.role,
        content: r.content,
        created_at: r.created_at,
      }));
  }

  getOrchestratorMessages(meetingId) {
    return this.#db
      .prepare(
        `SELECT id, msg_type, role, content, created_at
         FROM orchestrator_messages WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId)
      .map((r) => ({
        id: r.id,
        type: r.msg_type,
        role: r.role,
        content: r.content,
        created_at: r.created_at,
      }));
  }

  getMaxContributionId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM contributions`)
      .get();
    return row.maxId ?? 0;
  }

  getMaxErrorId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM agent_errors`)
      .get();
    return row.maxId ?? 0;
  }

  getAgentContext(meetingId, participantId) {
    const meeting = this.#db
      .prepare(`SELECT fabric, question FROM meetings WHERE id = ?`)
      .get(meetingId);
    const participant = this.#db
      .prepare(`SELECT name, persona, agenda, tier, provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
      .get(participantId, meetingId);
    return { meeting, participant };
  }

  exportMarkdown(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const contributions = this.getContributions(500, 0);
    const interjections = this.getInterjections();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();

    const lines = [];
    lines.push(`# Loom Deliberation Output`);
    lines.push("");
    lines.push(`**Question:** ${meeting?.question ?? "Unknown"}`);
    lines.push(`**Status:** ${meeting?.status ?? "Unknown"}`);
    lines.push(`**Rounds:** ${meeting?.round ?? 0}/${meeting?.max_rounds ?? 0}`);
    lines.push(`**Convergence:** ${meeting?.convergence ?? "Unknown"}`);
    lines.push(`**Meeting ID:** ${meetingId}`);
    lines.push("");

    if (artifact?.content) {
      lines.push(`## Final Artifact`);
      lines.push("");
      lines.push(artifact.content);
      lines.push("");
    }
    lines.push(`## Participants`);
    lines.push("");
    for (const p of participants) {
      lines.push(`- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}`);
    }
    lines.push("");

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) roundMap.set(c.round, []);
      roundMap.get(c.round).push(c);
    }

    for (const [roundNum, contribs] of [...roundMap.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`## Round ${roundNum}`);
      lines.push("");
      for (const c of contribs) {
        const participant = participants.find((p) => p.id === c.participant_id);
        const name = participant?.name ?? c.participant_id;
        lines.push(`- **[${name}]** (${c.type}): ${c.content}`);
      }
      lines.push("");
    }

    if (interjections.length > 0) {
      lines.push(`## Interjections`);
      lines.push("");
      for (const ij of interjections) {
        const participant = participants.find((p) => p.id === ij.participant_id);
        const name = participant?.name ?? ij.participant_id;
        lines.push(`- **[${name}]** P${ij.priority}: ${ij.content} → ${ij.granted ? "granted" : "denied"}`);
      }
      lines.push("");
    }

    if (errors.length > 0) {
      lines.push(`## Errors`);
      lines.push("");
      for (const e of errors) {
        const participant = participants.find((p) => p.id === e.participant_id);
        const name = participant?.name ?? e.participant_id;
        lines.push(`- **[${name}]** Round ${e.round}: ${e.error_type} — ${e.error_message}`);
      }
      lines.push("");
    }

    if (meeting?.fabric) {
      lines.push(`## Final Fabric Context`);
      lines.push("");
      lines.push(meeting.fabric);
      lines.push("");
    }

    return lines.join("\n");
  }

  exportJSON(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const contributions = this.getContributions(500, 0);
    const interjections = this.getInterjections();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();
    const orchestratorMessages = this.getOrchestratorMessages(meetingId);

    const exportData = {
      meeting: {
        id: meetingId,
        question: meeting?.question ?? "Unknown",
        status: meeting?.status ?? "Unknown",
        round: meeting?.round ?? 0,
        maxRounds: meeting?.max_rounds ?? 0,
        convergence: meeting?.convergence ?? "Unknown",
        domain: meeting?.domain ?? null,
        fabric: meeting?.fabric ?? "",
        createdAt: meeting?.created_at ?? null,
      },
      participants: participants.map(p => ({
        id: p.id,
        name: p.name,
        tier: p.tier,
        persona: p.persona,
        agenda: p.agenda,
        model: p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null,
        status: p.status,
      })),
      contributions: contributions.map(c => ({
        id: c.id,
        round: c.round,
        participantId: c.participant_id,
        type: c.type,
        content: c.content,
        targetsWhich: c.targets_which,
        createdAt: c.created_at,
      })),
      interjections: interjections.map(ij => ({
        id: ij.id,
        participantId: ij.participant_id,
        targetParticipantId: ij.target_participant_id,
        round: ij.round,
        priority: ij.priority,
        content: ij.content,
        granted: ij.granted,
        pushback: ij.pushback,
        resolved: ij.resolved,
        createdAt: ij.created_at,
      })),
      errors: errors.map(e => ({
        id: e.id,
        participantId: e.participant_id,
        round: e.round,
        errorType: e.error_type,
        errorMessage: e.error_message,
        attempts: e.attempts,
        createdAt: e.created_at,
      })),
      artifact: artifact ? {
        content: artifact.content,
        decisions: artifact.decisions,
        actionItems: artifact.action_items,
        dissent: artifact.dissent,
        openQuestions: artifact.open_questions,
        confidence: artifact.confidence,
        createdAt: artifact.created_at,
      } : null,
      orchestratorMessages,
      exportedAt: new Date().toISOString(),
    };

    return JSON.stringify(exportData, null, 2);
  }

  /**
   * Generates a streaming markdown export for large meetings.
   * Yields chunks in order so the response starts immediately.
   */
  *exportMarkdownStream(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const interjections = this.getInterjections();
    const errors = this.getAgentErrors();
    const artifact = this.getArtifact();

    yield `# Loom Deliberation Output\n\n`;
    yield `**Question:** ${meeting?.question ?? "Unknown"}\n`;
    yield `**Status:** ${meeting?.status ?? "Unknown"}\n`;
    yield `**Rounds:** ${meeting?.round ?? 0}/${meeting?.max_rounds ?? 0}\n`;
    yield `**Convergence:** ${meeting?.convergence ?? "Unknown"}\n`;
    yield `**Meeting ID:** ${meetingId}\n\n`;

    if (artifact?.content) {
      yield `## Final Artifact\n\n${artifact.content}\n\n`;
    }

    yield `## Participants\n\n`;
    for (const p of participants) {
      yield `- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}\n`;
    }
    yield `\n`;

    // Stream contributions by round
    const allContributions = this.getContributions(500, 0);
    const roundMap = new Map();
    const roundNumbers = [];
    for (const c of allContributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, []);
        roundNumbers.push(c.round);
      }
      roundMap.get(c.round).push(c);
    }

    for (const roundNum of roundNumbers.sort((a, b) => a - b)) {
      yield `## Round ${roundNum}\n\n`;
      for (const c of roundMap.get(roundNum)) {
        const participant = participants.find((p) => p.id === c.participant_id);
        const name = participant?.name ?? c.participant_id;
        yield `- **[${name}]** (${c.type}): ${c.content}\n`;
      }
      yield `\n`;
    }

    if (interjections.length > 0) {
      yield `## Interjections\n\n`;
      for (const ij of interjections) {
        const participant = participants.find((p) => p.id === ij.participant_id);
        const name = participant?.name ?? ij.participant_id;
        yield `- **[${name}]** P${ij.priority}: ${ij.content} → ${ij.granted ? "granted" : "denied"}\n`;
      }
      yield `\n`;
    }

    if (errors.length > 0) {
      yield `## Errors\n\n`;
      for (const e of errors) {
        const participant = participants.find((p) => p.id === e.participant_id);
        const name = participant?.name ?? e.participant_id;
        yield `- **[${name}]** Round ${e.round}: ${e.error_type} — ${e.error_message}\n`;
      }
      yield `\n`;
    }

    if (meeting?.fabric) {
      yield `## Final Fabric Context\n\n${meeting.fabric}\n`;
    }
  }

  close() {
    this.#db.close();
    DashboardApi.cache.delete(this.#dbPath);
  }

  /**
   * Get the embedding model information for this meeting.
   */
  getEmbeddingModel(meetingId) {
    const meeting = this.#db
      .prepare(`SELECT embedding_model, embedding_dim FROM meetings WHERE id = ?`)
      .get(meetingId);
    return meeting ?? null;
  }
}

/**
 * List all downloaded embedding models.
 */
export function listDownloadedModels() {
  const { homedir } = require("os");
  const { join } = require("path");
  const modelDir = join(homedir(), ".config", "opencode", "loom", "models");
  
  if (!existsSync(modelDir)) return [];
  
  const models = [];
  try {
    const entries = readdirSync(modelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const modelJsonPath = join(modelDir, entry.name, "model.json");
        if (existsSync(modelJsonPath)) {
          try {
            const stat = statSync(modelJsonPath);
            if (stat.size > 0) {
              const content = require("fs").readFileSync(modelJsonPath, "utf-8");
              const modelJson = JSON.parse(content);
              models.push(modelJson);
            }
          } catch {
            // Skip invalid model.json
          }
        }
      }
    }
  } catch {
    // Skip on error
  }
  
  return models;
}

export function listMeetings(directory) {
  const meetingsDir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(meetingsDir)) return [];

  const files = [];
  try {
    const entries = readdirSync(meetingsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        files.push(join(meetingsDir, entry.name));
      }
    }
  } catch {
    return [];
  }

  const meetings = [];
  for (const file of files) {
    try {
      const db = new Database(file, { readonly: true });
      const state = db
        .prepare(
          `SELECT id as meeting_id, question, status, round, max_rounds, convergence, created_at FROM meetings LIMIT 1`,
        )
        .get();
      const participantCount = (
        db.prepare(`SELECT COUNT(*) as count FROM participants`).get()
      )?.count ?? 0;
      db.close();

      if (state) {
        meetings.push({
          meeting_id: state.meeting_id,
          question: state.question,
          status: state.status,
          round: state.round,
          max_rounds: state.max_rounds,
          convergence: state.convergence,
          created_at: state.created_at,
          participant_count: participantCount,
        });
      }
    } catch {
      // Corrupted or locked DB — skip this meeting file
    }
  }

  meetings.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return meetings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMeetingId(id) {
  return UUID_RE.test(id);
}

export function getMeetingDbPath(directory, meetingId) {
  if (!isValidMeetingId(meetingId)) return null;
  const path = join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.db`);
  return existsSync(path) ? path : null;
}
