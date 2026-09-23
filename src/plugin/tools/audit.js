function safeAuditValue(value) {
  if (value == null) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return serialized
    .replace(/(authorization|api[_-]?key|bearer|token|password|secret|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, "$1$2[REDACTED]")
    .slice(0, 12000);
}

export function auditLoomTool({ db, stateManager, caller, meetingId, tool, input, output, status = "completed", title = null }) {
  if (!db || !stateManager) return;
  try {
    const participantId = caller?.config?.id ?? caller?.id ?? "unknown";
    if (!participantId || participantId === "unknown") return;
    const round = stateManager.getCurrentRound?.() ?? stateManager.getState?.()?.round ?? 0;
    const batchId = caller?.currentBatchId ?? null;
    // Durable audit — survives even if ToolPart extraction fails
    // Stored in tool_audit table and merged into contributions.tool_calls on fetch
    if (typeof db.addToolAudit === "function") {
      db.addToolAudit({
        participantId,
        round,
        batchId,
        tool,
        input: safeAuditValue(input),
        output: safeAuditValue(output),
        status,
        title,
      });
    } else {
      // Fallback direct SQL if MeetingDatabase wrapper not available (e.g., raw db handle)
      try {
        const now = new Date().toISOString();
        const inputStr = input != null ? safeAuditValue(input) : null;
        const outputStr = output != null ? safeAuditValue(output) : null;
        const run = db.prepare ? db.prepare.bind(db) : db.query?.bind(db);
        // Try tool_audit table if exists
        const stmt = run(`INSERT INTO tool_audit (meeting_id, participant_id, round, batch_id, tool, input, output, status, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        stmt.run(meetingId, participantId, round, batchId, tool, inputStr, outputStr, status, title, now);
      } catch {}
    }
  } catch {}
}
