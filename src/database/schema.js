/**
 * Final schema. No migration machinery — the DB is wiped whenever a session is
 * deleted, so we ship exactly one latest schema (see docs/database-and-migration-plan.md).
 */

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      context TEXT,
      status TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      persona TEXT NOT NULL,
      agenda TEXT NOT NULL,
      tier TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      session_id TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'listening',
      reflection TEXT NOT NULL DEFAULT '',
      known_biases TEXT,
      communication_style TEXT,
      preferred_contribution_types TEXT,
      UNIQUE(meeting_id, name)
    );

    CREATE TABLE IF NOT EXISTS contributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      target_which TEXT,
      tool_calls TEXT,
      prompt_context TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      target_participant_id TEXT,
      round INTEGER,
      content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      error_type TEXT NOT NULL,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
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
      created_at TEXT NOT NULL,
      PRIMARY KEY (meeting_id, round)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      decisions TEXT,
      action_items TEXT,
      dissent TEXT,
      open_questions TEXT,
      confidence TEXT,
      refusals TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contributions_meeting_round ON contributions(meeting_id, round);
    CREATE INDEX IF NOT EXISTS idx_contributions_meeting ON contributions(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_contributions_participant ON contributions(participant_id);
    CREATE INDEX IF NOT EXISTS idx_turn_requests_meeting ON turn_requests(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_turn_requests_participant ON turn_requests(participant_id);
    CREATE INDEX IF NOT EXISTS idx_agent_errors_meeting ON agent_errors(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_participants_meeting ON participants(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_error_log_meeting ON error_log(meeting_id);
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

    CREATE TABLE IF NOT EXISTS fabric_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      round INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'round_summary',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fabric_chunks_meeting ON fabric_chunks(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_fabric_chunks_meeting_round ON fabric_chunks(meeting_id, round);

    CREATE TABLE IF NOT EXISTS persona_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      persona_name TEXT NOT NULL,
      tier TEXT NOT NULL,
      tags TEXT NOT NULL,
      embedding_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_persona_embeddings_meeting ON persona_embeddings(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_persona_embeddings_tier ON persona_embeddings(meeting_id, tier);
  `);
}