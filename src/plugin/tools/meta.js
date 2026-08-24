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

    loom_type: tool({
      description:
        "Declare the type of your primary contribution for this turn. " +
        "You MUST call this exactly once per turn to indicate whether your contribution is a proposal, challenge, question, etc. " +
        "This is fire-and-forget — call it and then write your contribution text; you don't need to wait for anything.",
      args: {
        type: tool.schema
          .enum(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question", "refuse"])
          .describe("Contribution type for this turn"),
        reason: tool.schema
          .string()
          .max(300)
          .optional()
          .describe("If type is refuse, brief reason (e.g. 'Missing budget approval')"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_type) return { output: JSON.stringify({ error: "loom_type not enabled" }), metadata: { error: true }, title: "loom_type error" };
        // Fire-and-forget: just acknowledge. The authoritative type is read from toolResults
        // by RoundExecutor, so no meeting lookup is needed here.
        const valid = new Set(["propose","challenge","refine","support","dissent","synthesize","question","refuse"]);
        const t = String(args.type ?? "").toLowerCase();
        if (!valid.has(t)) return { output: JSON.stringify({ error: `Invalid type "${args.type}" — must be one of ${[...valid].join(", ")}` }), metadata: { error: true }, title: "loom_type error" };
        const payload = { ok: true, type: t, reason: args.reason ?? null, note: `Type "${t}" recorded for this turn.` };
        return { output: JSON.stringify(payload), metadata: { type: t }, title: `loom_type:${t}` };
      },
    }),
  };
}
