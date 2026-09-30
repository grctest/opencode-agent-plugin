import { recordMeetingDegradedReason } from "../../metrics.js";

function safeAuditValue(value) {
  if (value == null) return null;
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  // Secret redaction only — no length cap: tool_audit rows are lossless so the
  // Tool use tab and audit consumers see complete tool inputs/outputs.
  return serialized
    .replace(/(authorization|api[_-]?key|bearer|token|password|secret|client[_-]?secret|private[_-]?key)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, "$1$2[REDACTED]");
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

/**
 * N6 — a refusal is a fact, not a non-event. tool_audit recorded what was
 * invoked, never what succeeded, so four rejected state patches and a failed
 * forum read left a database reporting a flawless run. Every refusal now
 * writes an audit row with a non-completed status AND a named degraded reason,
 * so a monitor built on these tables is measuring something.
 *
 * @param {Object} params
 * @param {string} params.reason stable degraded-reason key, e.g. "state_patch_rejected"
 * @param {string} [params.status="rejected"] audit status for the row
 * @param {Object} [params.extra] extra fields to keep in the agent-facing payload
 * @returns {Object} the tool result payload to return to the agent
 */
export function loomToolRefusal({ db, stateManager, caller, meetingId, tool, input = null, error, extra = {}, reason, status = "rejected", title = null, metadata = {} }) {
  const output = JSON.stringify({ error, ...extra, degraded: true, reason });
  try {
    auditLoomTool({ db, stateManager, caller, meetingId, tool, input, output, status, title: title ?? `${tool}:refused` });
  } catch {}
  try {
    recordMeetingDegradedReason(meetingId, reason);
  } catch {}
  return { output, metadata: { error: true, degraded: true, reason, ...metadata }, title: title ?? `${tool} refused` };
}
