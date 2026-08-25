import { tool } from "@opencode-ai/plugin";

export function createMetaTools({ config }) {
  return {
    loom_request_next: tool({
      description: "Request to speak next round with priority and reason.",
      args: {
        priority: tool.schema.number().int().min(1).max(10).describe("Priority 1-10 (capped by tier)"),
        reason: tool.schema.string().min(1).max(200).describe("Reason for turn request (quoted)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_request_next) return { output: JSON.stringify({ error: "loom_request_next not enabled" }), metadata: { error: true }, title: "loom_request_next error" };
        const payload = { queued: true, priority: Math.min(10, Math.max(1, args.priority)), reason: args.reason, note: "Turn request queued — will be considered for next round order." };
        return { output: JSON.stringify(payload), metadata: { queued: true, priority: payload.priority }, title: "loom_request_next queued" };
      },
    }),
  };
}
