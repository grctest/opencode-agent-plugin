import { tool } from "@opencode-ai/plugin";

export function createPassTool({ config, resolveMeeting, activeLooms }) {
  return {
    loom_pass: tool({
      description: "Pass on your current turn. Use when you have nothing new to contribute. The deliberation ends when all participants pass.",
      args: {
        reason: tool.schema.string().max(200).optional()
          .describe("Optional: why you're passing (e.g., 'covered by #3', 'not my expertise')"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
         if (!cfg?.enabled || !cfg?.loom?.loom_pass)
           return { output: JSON.stringify({ error: "loom_pass not enabled" }), metadata: { error: true }, title: "loom_pass error" };
         if (resolveMeeting && activeLooms && context?.sessionID) {
           try {
             const meeting = await resolveMeeting(context.sessionID);
             const engine = meeting ? activeLooms.get(meeting.meetingId) : null;
             const turn = engine?.getStateManager?.().getActiveTurn?.();
             if (turn?.patchApplied) {
               return { output: JSON.stringify({ error: "loom_pass cannot follow loom_state_patch in the same turn" }), metadata: { error: true }, title: "loom_pass error" };
             }
             engine?.getStateManager?.().markTurnPassRequested?.();
           } catch {}
         }

         const reason = args.reason ?? "no new contribution";
        return {
          output: JSON.stringify({ passed: true, reason }),
          metadata: { passed: true, reason },
          title: "loom_pass",
        };
      },
    }),
  };
}
