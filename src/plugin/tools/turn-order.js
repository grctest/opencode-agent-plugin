import { tool } from "@opencode-ai/plugin";
import { recordMeetingCall, recordMeetingLatency } from "../../metrics.js";

/**
 * Orchestrator-only turn-order override.
 *
 * Offered exclusively on the orchestrator's end-of-round summary call — never
 * in any agent-facing tool map (see buildToolsMap). The summary is the
 * orchestrator's single LLM call per round; when this round's evidence
 * warrants a different speaking order next round, the orchestrator calls this
 * tool once. No call means the default order stands.
 */
export function createTurnOrderTool({ resolveMeeting, activeLooms }) {
  return {
    loom_set_turn_order: tool({
      description: "ORCHESTRATOR ONLY — override next round's speaking order. Call at most once per summary, and only when this round's evidence warrants a different order; omit to keep the default rotation. Takes the FULL ordered list of participant ids (use the ## Participants ids from the summary prompt). Unknown ids are dropped; missing seats are appended in rotation order.",
      args: {
        order: tool.schema.array(tool.schema.string().min(1).max(120)).min(1).max(50)
          .describe("Full ordered list of participant ids for next round"),
        reason: tool.schema.string().max(300).optional()
          .describe("Optional: why the default order should change (e.g. 'evidence-first: B's finding needs immediate scrutiny')"),
      },
      async execute(args, context) {
        const started = Date.now();
        const fail = (error) => ({ output: JSON.stringify({ error }), metadata: { error: true }, title: "loom_set_turn_order error" });
        try {
          if (!resolveMeeting || !activeLooms || !context?.sessionID) {
            return fail("loom_set_turn_order unavailable: no meeting context");
          }
          const meeting = await resolveMeeting(context.sessionID);
          const engine = meeting ? activeLooms.get(meeting.meetingId) : null;
          const stateManager = engine?.getStateManager?.() ?? null;
          if (!engine || !stateManager) {
            return fail("loom_set_turn_order unavailable: meeting engine not ready");
          }
          const meetingId = stateManager.getMeetingId?.() ?? meeting.meetingId;
          const participants = stateManager.getParticipants?.() ?? [];
          const eligible = participants.filter((p) => p?.status !== "failed");
          const eligibleIds = eligible.map((p) => p.config.id);
          const seen = new Set();
          const ordered = [];
          const dropped = [];
          for (const id of args.order ?? []) {
            if (typeof id !== "string" || seen.has(id)) continue;
            seen.add(id);
            if (eligibleIds.includes(id)) ordered.push(id);
            else dropped.push(id);
          }
          const appended = [];
          for (const id of eligibleIds) {
            if (!ordered.includes(id)) { ordered.push(id); appended.push(id); }
          }
          if (ordered.length === 0) {
            return fail("loom_set_turn_order rejected: no known participant ids");
          }
          stateManager.setPlannedTurnOrder(ordered);
          stateManager.setNextSpeakerId(ordered[0]);
          try {
            if (meetingId) {
              recordMeetingCall(meetingId, "turn_order");
              recordMeetingLatency(meetingId, "turn_order_ms", Date.now() - started);
            }
          } catch {}
          return {
            output: JSON.stringify({ ok: true, order: ordered, dropped, appended, reason: args.reason ?? null }),
            metadata: { order: ordered },
            title: "loom_set_turn_order",
          };
        } catch (err) {
          return fail(`loom_set_turn_order failed: ${err?.message ?? String(err)}`);
        }
      },
    }),
  };
}
