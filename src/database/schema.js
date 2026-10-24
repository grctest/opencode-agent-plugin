/**
 * Schema v1.
 *
 * No userbase yet, so there are no migrations and no back-compat shims:
 * every database is created fresh at version 1 by initSchema() below.
 * runMigrations() is a version guard only — it stamps unmarked databases
 * and rejects anything that is not v1 (delete the file and let it be
 * recreated).
 *
 * When a userbase exists and the DDL must change, reintroduce an ordered
 * migration list here (v1 → v2 first) and bump SCHEMA_VERSION alongside it.
 */

export const SCHEMA_VERSION = 1;

/** Alias kept so existing imports keep working; prefer SCHEMA_VERSION. */
export const LATEST_SCHEMA_VERSION = SCHEMA_VERSION;

export function initSchema(db) {
  // Only a brand-new DB (no meetings table yet) gets stamped. Pre-existing
  // tables keep their user_version so the guard in runMigrations() sees them.
  const isNewDb = !db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='meetings'",
  ).get();

  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL CHECK(status IN ('initializing','weaving','converged','timeout','cancelled','aborted','max_rounds_reached','rate_limited')),
      round INTEGER NOT NULL DEFAULT 0,
      fabric TEXT,
      max_rounds INTEGER NOT NULL,
      convergence TEXT NOT NULL,
      tags TEXT,
      parent_session_id TEXT,
      opencode_session_id TEXT,
      next_speaker_id TEXT,
      state_of_play TEXT,
      stats TEXT,
       embedding_model TEXT,
       embedding_dim INTEGER,
       reflecting_participants TEXT,
       querying_participants TEXT,
       evidence_participants TEXT,
       summoning_participants TEXT,
       semantic_degraded INTEGER NOT NULL DEFAULT 0,
       persistence_degraded INTEGER NOT NULL DEFAULT 0,
       orchestrator_provider_id TEXT,
       orchestrator_model_id TEXT,
       orchestrator_model_variant TEXT,
      feature_toggles_json TEXT,
      orchestrator_config_json TEXT,
      rate_limit_state TEXT,
      settled_items TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      persona TEXT NOT NULL,
      agenda TEXT NOT NULL,
      category TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      model_variant TEXT,
      session_id TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'listening' CHECK(status IN ('listening','speaking','passed','failed','summoned')),
      reflection TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL DEFAULT '{"stance":"","established":[],"contested":[],"open":[],"facts":[],"files":[],"version":0,"updated_round":0,"updated_contribution_id":null}',
      known_biases TEXT,
      communication_style TEXT,
      preferred_contribution_types TEXT,
      anti_patterns TEXT,
      category_guidance TEXT,
      reflection_guidance TEXT,
      tags TEXT,
      expertise TEXT,
      UNIQUE(meeting_id, name)
    );

    CREATE TABLE IF NOT EXISTS contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      round INTEGER NOT NULL CHECK(round >= 0),
      type TEXT NOT NULL CHECK(type IN ('contribution','pass','query_response','perspective_response','critique_response','evidence_response','summoned_response','vote_response')),
      content TEXT NOT NULL,
      target_which TEXT,
      batch_id TEXT,
      tool_calls TEXT,
      prompt_context TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      round INTEGER NOT NULL CHECK(round >= 0),
      error_type TEXT NOT NULL,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
      severity TEXT NOT NULL DEFAULT 'error',
      context TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orchestrator_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      msg_type TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      round INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounds (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      orchestrator_config_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (meeting_id, round)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      decisions TEXT,
      action_items TEXT,
      open_questions TEXT,
      confidence TEXT,
      confidence_name TEXT,
      confidence_number TEXT,
      refusals TEXT,
      orchestrator_config TEXT,
      engagement_json TEXT,
      detector_report_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contributions_meeting_round ON contributions(meeting_id, round);
    CREATE INDEX IF NOT EXISTS idx_contributions_meeting ON contributions(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_participant ON contributions(participant_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_batch ON contributions(batch_id);
    CREATE INDEX IF NOT EXISTS idx_agent_errors_meeting ON agent_errors(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_agent_errors_created ON agent_errors(created_at);
    CREATE INDEX IF NOT EXISTS idx_participants_meeting ON participants(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_error_log_meeting ON error_log(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_meeting ON orchestrator_messages(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_meetings_opencode_session_id ON meetings(opencode_session_id);

    CREATE TABLE IF NOT EXISTS meeting_metrics (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      counters TEXT NOT NULL DEFAULT '{}',
      latencies TEXT NOT NULL DEFAULT '{}',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      rounds INTEGER NOT NULL DEFAULT 0,
      contributions INTEGER NOT NULL DEFAULT 0,
      turn_requests INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meeting_metrics_created ON meeting_metrics(created_at);

    CREATE TABLE IF NOT EXISTS tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      batch_id TEXT,
      tool TEXT NOT NULL,
      input TEXT,
      output TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      title TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_audit_meeting ON tool_audit(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_participant_round ON tool_audit(meeting_id, participant_id, round);
    CREATE INDEX IF NOT EXISTS idx_tool_audit_batch ON tool_audit(batch_id);

    CREATE TABLE IF NOT EXISTS state_patches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      contribution_id INTEGER,
      version INTEGER NOT NULL,
      patch_json TEXT NOT NULL,
      applied_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(meeting_id, participant_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_state_patches_meeting ON state_patches(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_state_patches_participant ON state_patches(meeting_id, participant_id);
  `);

  // Best-effort column additions for pre-existing DBs (no migration framework
  // yet): ensure the artifacts table carries the engagement/detector columns
  // even on databases created before they existed. Idempotent — ignored if
  // already present.
  try {
    const cols = db.prepare("PRAGMA table_info(artifacts)").all().map((r) => r.name);
    if (!cols.includes("engagement_json")) db.exec("ALTER TABLE artifacts ADD COLUMN engagement_json TEXT");
    if (!cols.includes("detector_report_json")) db.exec("ALTER TABLE artifacts ADD COLUMN detector_report_json TEXT");
  } catch {}

  if (isNewDb) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * Version guard (no migrations pre-userbase). Safe to call on brand-new DBs
 * (schema init + version stamp) and existing v1 ones (no-op validation).
 * Anything else throws: delete the database file and let it be recreated.
 * @param {import("bun:sqlite").Database} rawDb
 * @param {{ logger?: { info?: Function, warn?: Function } }} [opts]
 */
export function runMigrations(rawDb, opts = {}) {
  const row = rawDb.prepare("PRAGMA user_version").get();
  const current = Number(row?.user_version ?? 0);

  if (current === SCHEMA_VERSION) return current;

  if (current === 0) {
    rawDb.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return SCHEMA_VERSION;
  }

  throw new Error(
    `Database schema version ${current} is not supported (current: ${SCHEMA_VERSION}) — delete the database file and let it be recreated. No migrations are provided pre-userbase.`
  );
}

/**
 * A normalized `{ table: [column, ...] }` map of a database's shape, plus
 * its user_version. Tests assert a fresh DB reports v1 with the v1 shape.
 * @param {any} rawDb
 * @returns {{ user_version: number, tables: Record<string, string[]> }}
 */
export function schemaParityReport(rawDb) {
  const tables = new Set(
    rawDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name),
  );
  const report = { user_version: Number(rawDb.prepare("PRAGMA user_version").get()?.user_version ?? 0), tables: {} };
  for (const table of [...tables].sort()) {
    report.tables[table] = rawDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).sort();
  }
  return report;
}
