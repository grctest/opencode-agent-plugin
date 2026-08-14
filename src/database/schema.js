export const SCHEMA_VERSION = 13;

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
      domain TEXT,
      parent_session_id TEXT,
      opencode_session_id TEXT,
      next_speaker_id TEXT,
      stats TEXT,
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
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interjections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL,
      target_participant_id TEXT,
      round INTEGER,
      content TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      granted INTEGER NOT NULL DEFAULT 0,
      pushback TEXT,
      resolved TEXT NOT NULL DEFAULT 'pending',
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
    CREATE INDEX IF NOT EXISTS idx_interjections_meeting ON interjections(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_interjections_participant ON interjections(participant_id);
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
      interjections INTEGER NOT NULL DEFAULT 0,
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
  `);
}

export function migrateSchema(db) {
  const currentVersion = getSchemaVersion(db);
  if (currentVersion >= SCHEMA_VERSION) return;

  db.exec("BEGIN TRANSACTION");
  try {
    if (currentVersion < 1) {
      db.exec(`CREATE TABLE IF NOT EXISTS _loom_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '1')`);
      try { db.exec(`ALTER TABLE participants ADD COLUMN reflection TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE meetings ADD COLUMN opencode_session_id TEXT`); } catch { /* exists */ }
      try { db.exec(`ALTER TABLE interjections ADD COLUMN round INTEGER`); } catch { /* exists */ }
    }

  if (currentVersion < 2) {
    try { db.exec(`DROP TABLE IF EXISTS agent_responses`); } catch { /* ignore */ }
    try {
      db.exec(`DROP TABLE IF EXISTS metadata`);
      db.exec(`CREATE TABLE IF NOT EXISTS _loom_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    } catch { /* ignore */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '2')`);
  }

  if (currentVersion < 3) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS error_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
          severity TEXT NOT NULL DEFAULT 'error',
          context TEXT NOT NULL,
          message TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_meeting ON error_log(meeting_id)`);
    } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '3')`);
  }

  if (currentVersion < 4) {
    try { db.exec(`ALTER TABLE meetings ADD COLUMN domain TEXT`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '4')`);
  }

  if (currentVersion < 5) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS orchestrator_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          msg_type TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_meeting ON orchestrator_messages(meeting_id)`);
    } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '5')`);
  }

  if (currentVersion < 6) {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rounds (
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          round INTEGER NOT NULL,
          summary TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          PRIMARY KEY (meeting_id, round)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          meeting_id PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          decisions TEXT,
          action_items TEXT,
          dissent TEXT,
          open_questions TEXT,
          confidence TEXT,
          created_at TEXT NOT NULL
        )
      `);
    } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '6')`);
  }

  if (currentVersion < 7) {
    try { db.exec(`ALTER TABLE contributions ADD COLUMN target_which TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE contributions ADD COLUMN round INTEGER`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE interjections ADD COLUMN target_participant_id TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE meetings ADD COLUMN next_speaker_id TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE meetings ADD COLUMN stats TEXT`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '7')`);
  }

  if (currentVersion < 8) {
    try { db.exec(`ALTER TABLE participants ADD COLUMN known_biases TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE participants ADD COLUMN communication_style TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE participants ADD COLUMN preferred_contribution_types TEXT`); } catch { /* exists */ }
     db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '8')`);
  }

  if (currentVersion < 9) {
    try { db.exec(`ALTER TABLE participants ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '9')`);
  }

  if (currentVersion < 10) {
    try { db.exec(`ALTER TABLE artifacts ADD COLUMN refusals TEXT`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '10')`);
  }

  if (currentVersion < 11) {
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_interjections_participant ON interjections(participant_id)`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '11')`);
  }

  if (currentVersion < 12) {
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_metrics (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        counters TEXT NOT NULL DEFAULT '{}',
        latencies TEXT NOT NULL DEFAULT '{}',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        rounds INTEGER NOT NULL DEFAULT 0,
        contributions INTEGER NOT NULL DEFAULT 0,
        interjections INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `); } catch { /* exists */ }
    try { db.exec(`
      CREATE TABLE IF NOT EXISTS warp_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        round INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'round_summary',
        created_at TEXT NOT NULL
      )
    `); } catch { /* exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_warp_chunks_meeting ON warp_chunks(meeting_id)`); } catch { /* exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_warp_chunks_meeting_round ON warp_chunks(meeting_id, round)`); } catch { /* exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_meeting_metrics_created ON meeting_metrics(created_at)`); } catch { /* exists */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '12')`);
  }

  if (currentVersion < 13) {
    try { db.exec(`ALTER TABLE meetings RENAME COLUMN warp TO fabric`); } catch { /* exists or already renamed */ }
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fabric_chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
          round INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'round_summary',
          created_at TEXT NOT NULL
        )
      `);
      db.exec(`INSERT OR IGNORE INTO fabric_chunks SELECT * FROM warp_chunks`);
    } catch { /* exists */ }
    try { db.exec(`DROP TABLE IF EXISTS warp_chunks`); } catch { /* already dropped */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_fabric_chunks_meeting ON fabric_chunks(meeting_id)`); } catch { /* exists */ }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_fabric_chunks_meeting_round ON fabric_chunks(meeting_id, round)`); } catch { /* exists */ }
    try { db.exec(`DROP TABLE IF EXISTS vec_warp_chunks`); } catch { /* already dropped */ }
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_fabric_chunks USING vec0(
        id INTEGER PRIMARY KEY,
        embedding float[384]
      )`);
    } catch { /* sqlite-vec not loaded */ }
    db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '13')`);
  }
  db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function getSchemaVersion(db) {
  try {
    const hasMeta = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_loom_meta'"
    ).get();
    if (!hasMeta) return 0;
    const row = db.prepare("SELECT value FROM _loom_meta WHERE key = ?").get("schema_version");
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}
