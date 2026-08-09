import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Contribution, Interjection, LoomStatus, ParticipantConfig, TranscriptData, TranscriptRound } from "./types.js";

interface Statement {
  run(...params: any[]): any;
  get(...params: any[]): any;
  all(...params: any[]): any;
}

interface DBHandle {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
  readonly filename: string;
}

let DatabaseClass: any = null;
let dbReady: Promise<void> | null = null;

function importBunSqlite(): Promise<any> {
  // @ts-expect-error bun:sqlite is a Bun-only module, resolved at runtime
  return import("bun:sqlite");
}

function importBetterSqlite3(): Promise<any> {
  return import("better-sqlite3");
}

function ensureDb(): Promise<void> {
  if (DatabaseClass) return Promise.resolve();
  if (dbReady) return dbReady;
  dbReady = (async () => {
    try {
      const mod = await importBunSqlite();
      DatabaseClass = mod.Database;
    } catch {
      const mod = await importBetterSqlite3();
      DatabaseClass = mod.default;
    }
  })();
  return dbReady;
}

function isoNow(): string {
  return new Date().toISOString();
}

function deserializeStatus(s: string): LoomStatus {
  return s as LoomStatus;
}

export class MeetingDatabase {
  private db: DBHandle;
  private meetingId: string;

  static async create(dbPath: string, meetingId: string): Promise<MeetingDatabase> {
    await ensureDb();
    return new MeetingDatabase(dbPath, meetingId);
  }

  private constructor(dbPath: string, meetingId: string) {
    this.meetingId = meetingId;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseClass(dbPath);
    this.db = db as unknown as DBHandle;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        warp TEXT,
        max_rounds INTEGER NOT NULL,
        convergence TEXT NOT NULL,
        parent_session_id TEXT,
        opencode_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        agenda TEXT NOT NULL,
        tier TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        participant_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interjections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        participant_id TEXT NOT NULL,
        target_participant_id TEXT,
        content TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        granted INTEGER NOT NULL DEFAULT 0,
        pushback TEXT,
        resolved TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        participant_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contributions_meeting ON contributions(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_interjections_meeting ON interjections(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_agent_responses_meeting ON agent_responses(meeting_id, participant_id);
    `);
  }

  initializeMeeting(input: {
    question: string;
    context: string;
    maxRounds: number;
    convergence: "consensus" | "majority" | "moderator_forces";
    parentSessionId: string;
    participants: ParticipantConfig[];
    opencodeSessionId: string;
  }): void {
    const now = isoNow();
    this.db
      .prepare(
        `INSERT INTO meetings (id, question, context, status, round, warp, max_rounds, convergence, parent_session_id, opencode_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.meetingId,
        input.question,
        input.context ?? "",
        "initializing",
        input.context ?? "",
        input.maxRounds,
        input.convergence,
        input.parentSessionId,
        input.opencodeSessionId,
        now,
        now,
      );

    this.db
      .prepare(
        `INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`,
      )
      .run("opencode_session_id", input.opencodeSessionId);

    const insertParticipant = this.db.prepare(
      `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of input.participants) {
      insertParticipant.run(
        p.id,
        this.meetingId,
        p.name,
        p.persona,
        p.agenda,
        p.tier,
        p.model?.providerID ?? null,
        p.model?.modelID ?? null,
        null,
      );
    }
  }

  getWarp(): string {
    const row = this.db
      .prepare("SELECT warp FROM meetings WHERE id = ?")
      .get(this.meetingId) as { warp: string | null } | null;
    return row?.warp ?? "";
  }

  setWarp(warp: string): void {
    this.db
      .prepare("UPDATE meetings SET warp = ?, updated_at = ? WHERE id = ?")
      .run(warp, isoNow(), this.meetingId);
  }

  getRound(): number {
    const row = this.db
      .prepare("SELECT round FROM meetings WHERE id = ?")
      .get(this.meetingId) as { round: number } | null;
    return row?.round ?? 0;
  }

  setRound(round: number): void {
    this.db
      .prepare("UPDATE meetings SET round = ?, updated_at = ? WHERE id = ?")
      .run(round, isoNow(), this.meetingId);
  }

  getStatus(): LoomStatus {
    const row = this.db
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(this.meetingId) as { status: string } | null;
    return row ? deserializeStatus(row.status) : "initializing";
  }

  setStatus(status: LoomStatus): void {
    this.db
      .prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, isoNow(), this.meetingId);
  }

  addContribution(meetingId: string, contribution: Contribution & { round?: number; confidence?: number }): void {
    this.db
      .prepare(
        `INSERT INTO contributions (meeting_id, participant_id, round, type, content, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        contribution.participant_id,
        contribution.round ?? this.getRound(),
        contribution.type,
        contribution.content,
        contribution.confidence ?? null,
        new Date(contribution.timestamp).toISOString(),
      );
  }

  getContributions(meetingId: string): Contribution[] {
    const rows = this.db
      .prepare(
        `SELECT participant_id, content, type, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId) as Array<{
      participant_id: string;
      content: string;
      type: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      participant_id: r.participant_id,
      content: r.content,
      type: r.type as Contribution["type"],
      targets_which: null,
      timestamp: new Date(r.created_at).getTime(),
    }));
  }

  addInterjection(meetingId: string, interjection: Interjection): void {
    this.db
      .prepare(
        `INSERT INTO interjections (meeting_id, participant_id, content, priority, granted, pushback, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        interjection.participant_id,
        interjection.reason,
        interjection.priority,
        interjection.granted ? 1 : 0,
        interjection.pushback ?? null,
        interjection.resolved,
        isoNow(),
      );
  }

  getInterjections(meetingId: string): Interjection[] {
    const rows = this.db
      .prepare(
        `SELECT participant_id, content as reason, priority, granted, pushback, resolved
         FROM interjections WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId) as Array<{
      participant_id: string;
      reason: string;
      priority: number;
      granted: number;
      pushback: string | null;
      resolved: string;
    }>;
    return rows.map((r) => ({
      participant_id: r.participant_id,
      priority: r.priority,
      reason: r.reason,
      granted: r.granted === 1,
      pushback: r.pushback,
      resolved: r.resolved as Interjection["resolved"],
    }));
  }

  setParticipantSessionId(participantId: string, sessionId: string): void {
    this.db
      .prepare("UPDATE participants SET session_id = ? WHERE id = ? AND meeting_id = ?")
      .run(sessionId, participantId, this.meetingId);
  }

  getTranscriptData(meetingId: string): TranscriptData {
    const meeting = this.db
      .prepare("SELECT question, warp FROM meetings WHERE id = ?")
      .get(meetingId) as { question: string; warp: string } | null;

    const contributions = this.db
      .prepare(
        `SELECT participant_id, round, type, content, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY created_at ASC`,
      )
      .all(meetingId) as Array<{
      participant_id: string;
      round: number;
      type: string;
      content: string;
      created_at: string;
    }>;

    const interjections = this.db
      .prepare(
        `SELECT participant_id, content as reason, priority, granted, pushback, resolved, created_at
         FROM interjections WHERE meeting_id = ? ORDER BY created_at ASC`,
      )
      .all(meetingId) as Array<{
      participant_id: string;
      reason: string;
      priority: number;
      granted: number;
      pushback: string | null;
      resolved: string;
      created_at: string;
    }>;

    const roundMap = new Map<number, TranscriptRound>();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, { number: c.round, contributions: [], interjections: [], summary: "" });
      }
      roundMap.get(c.round)!.contributions.push({
        participant_id: c.participant_id,
        content: c.content,
        type: c.type as Contribution["type"],
        targets_which: null,
        timestamp: new Date(c.created_at).getTime(),
      });
    }

    for (const ij of interjections) {
      const roundNum = contributions.find((c) => c.participant_id === ij.participant_id)?.round ?? 1;
      if (!roundMap.has(roundNum)) {
        roundMap.set(roundNum, { number: roundNum, contributions: [], interjections: [], summary: "" });
      }
      roundMap.get(roundNum)!.interjections.push({
        participant_id: ij.participant_id,
        priority: ij.priority,
        reason: ij.reason,
        granted: ij.granted === 1,
        pushback: ij.pushback,
        resolved: ij.resolved as Interjection["resolved"],
      });
    }

    const rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

    return {
      question: meeting?.question ?? "",
      warp: meeting?.warp ?? "",
      rounds,
    };
  }

  writeAgentResponse(meetingId: string, participantId: string, round: number, response: string): void {
    this.clearAgentResponse(meetingId, participantId);
    this.db
      .prepare(
        `INSERT INTO agent_responses (meeting_id, participant_id, round, response, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(meetingId, participantId, round, response, isoNow());
  }

  readAgentResponse(meetingId: string, participantId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT response FROM agent_responses WHERE meeting_id = ? AND participant_id = ?`,
      )
      .get(meetingId, participantId) as { response: string } | null;
    return row?.response ?? null;
  }

  hasAgentResponded(meetingId: string, participantId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM agent_responses WHERE meeting_id = ? AND participant_id = ?`,
      )
      .get(meetingId, participantId);
    return row != null;
  }

  clearAgentResponse(meetingId: string, participantId: string): void {
    this.db
      .prepare(`DELETE FROM agent_responses WHERE meeting_id = ? AND participant_id = ?`)
      .run(meetingId, participantId);
  }

  getParticipantModel(participantId: string): { providerID: string; modelID: string } | null {
    const row = this.db
      .prepare(`SELECT provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
      .get(participantId, this.meetingId) as {
      provider_id: string | null;
      model_id: string | null;
    } | null;
    if (!row || !row.provider_id || !row.model_id) return null;
    return { providerID: row.provider_id, modelID: row.model_id };
  }

  close(): void {
    this.db.close();
  }

  getDatabasePath(): string {
    const handle = this.db as any;
    return handle.filename ?? handle.name ?? "unknown";
  }

  getOpencodeSessionId(): string | null {
    try {
      const row = this.db
        .prepare("SELECT value FROM metadata WHERE key = ?")
        .get("opencode_session_id") as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      return null;
    }
  }
}

// ─── Static cleanup utilities ─────────────────────────────────────────────────

import { unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function deleteMeetingFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
}

export function listMeetingFiles(directory: string): string[] {
  const dir = join(directory, ".opencode", "loom", "meetings");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".db"));
}

export async function readSessionIdFromDb(dbPath: string): Promise<string | null> {
  try {
    let DBClass: any = null;
    try {
      // @ts-expect-error bun:sqlite is a Bun-only module
      DBClass = (await import("bun:sqlite")).Database;
    } catch {
      DBClass = (await import("better-sqlite3")).default;
    }
    const db = new DBClass(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get("opencode_session_id") as any;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function cleanupOrphanDatabases(directory: string, activeSessionIds: Set<string>): number {
  const meetingsDir = join(directory, ".opencode", "loom", "meetings");
  if (!existsSync(meetingsDir)) return 0;

  let cleaned = 0;
  for (const file of readdirSync(meetingsDir)) {
    if (!file.endsWith(".db")) continue;
    const dbPath = join(meetingsDir, file);
    const sessionId = readSessionIdFromDbSync(dbPath);
    if (sessionId && !activeSessionIds.has(sessionId)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
      }
      cleaned++;
    }
  }
  return cleaned;
}

function readSessionIdFromDbSync(dbPath: string): string | null {
  let DBClass: any = null;
  try {
    DBClass = (globalThis as any).Bun ? (require("bun:sqlite") as any).Database : null;
  } catch {
    try {
      DBClass = require("better-sqlite3");
    } catch {
      return null;
    }
  }
  if (!DBClass) return null;
  try {
    const db = new DBClass(dbPath, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get("opencode_session_id") as any;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
