import { tool } from "@opencode-ai/plugin";

export function createStatePatchTool({ config, resolveMeeting, activeLooms }) {
  return {
    loom_state_patch: tool({
      description:
        "Project what should survive to the next round. Call ONCE per turn with your stance " +
        "and any new established/contested/open/facts/files bullets (1-3 each), plus exact-text " +
        "`remove` entries for your own outdated bullets. Prose alone does not carry forward — " +
        "only what you patch here appears in your future State. At least one field required.",
      args: {
        stance: tool.schema.string().min(1).max(400).optional()
          .describe("Where you stand now in one sentence (overwrites previous stance)"),
        established_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Points you consider settled (up to 3, each ≤280 chars)"),
        contested_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Points still disputed (up to 3)"),
        open_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Unresolved questions (up to 3)"),
        facts_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Tool-backed or cited facts with Source/[#id] (up to 3)"),
        files_add: tool.schema.array(tool.schema.string().min(1).max(160)).max(3).optional()
          .describe("File paths touched (up to 3, e.g. src/auth/jwt.ts)"),
        remove: tool.schema.array(tool.schema.string().min(1).max(280)).max(5).optional()
          .describe("Exact text of YOUR outdated bullets to delete (up to 5)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_state_patch)
          return { output: JSON.stringify({ error: "loom_state_patch not enabled" }), metadata: { error: true }, title: "loom_state_patch error" };
        if (!context?.sessionID)
          return { output: JSON.stringify({ error: "session context unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo)
            return { output: JSON.stringify({ error: "meeting not resolved", queued: false }), metadata: { error: true }, title: "loom_state_patch error" };
          const engine = activeLooms.get(meetingInfo.meetingId);
          const sm = engine?.getStateManager?.();
          const db = engine?.getDatabase?.();
          if (!sm || !db || typeof sm.getParticipantState !== "function" || typeof sm.setParticipantState !== "function")
            return { output: JSON.stringify({ error: "state not ready" }), metadata: { error: true }, title: "loom_state_patch error" };

          // Resolve caller (same helper as query-evidence.js: resolveCaller)
          const { resolveCaller } = await import("./shared.js");
          const caller = resolveCaller(sm.getParticipants(), sm.getWeave?.() ?? [], context.sessionID);
          if (!caller?.config?.id)
            return { output: JSON.stringify({ error: "caller identity unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };

          // Validate via Zod (same StatePatchSchema as §5.2).
          // Unknown keys are rejected explicitly here: the parse object below
          // is constructed with known keys only, so Zod .strict() would never
          // see them (§9: unknown keys must reject, not silently drop).
          const ALLOWED_PATCH_KEYS = new Set(["stance", "established_add", "contested_add", "open_add", "facts_add", "files_add", "remove"]);
          const unknownKeys = Object.keys(args ?? {}).filter((k) => !ALLOWED_PATCH_KEYS.has(k));
          if (unknownKeys.length > 0)
            return { output: JSON.stringify({ error: "invalid patch", issues: [{ message: `unknown keys: ${unknownKeys.slice(0, 5).join(", ")}` }] }), metadata: { error: true, validationFailed: true }, title: "loom_state_patch error" };
          const { StatePatchSchema } = await import("../../schemas.js");
          const parsed = StatePatchSchema.safeParse({
            stance: args.stance, established_add: args.established_add ?? [],
            contested_add: args.contested_add ?? [], open_add: args.open_add ?? [],
            facts_add: args.facts_add ?? [], files_add: args.files_add ?? [],
            remove: args.remove ?? [],
          });
          if (!parsed.success)
            return { output: JSON.stringify({ error: "invalid patch", issues: parsed.error.issues.slice(0, 5) }), metadata: { error: true, validationFailed: true }, title: "loom_state_patch error" };

          const { applyStatePatch } = await import("../../state-patch.js");
          const prev = sm.getParticipantState(caller.config.id);
          const { next, applied, unmatched, evicted } = applyStatePatch(prev, parsed.data);
          next.updated_round = sm.getCurrentRound?.() ?? 0;
          // updated_contribution_id filled by executor post-store (§5.6); set provisional here
          sm.setParticipantState(caller.config.id, next);
          try {
            if (typeof db.setParticipantState === "function") db.setParticipantState(caller.config.id, next);
          } catch {}
          try {
            const { auditLoomTool } = await import("./audit.js");
            auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
              tool: "loom_state_patch", input: args,
              output: JSON.stringify({ applied: true, version: next.version, appliedCounts: applied }),
              status: "completed", title: `loom_state_patch:v${next.version}` });
          } catch {}

          return {
            output: JSON.stringify({ applied: true, version: next.version, added: applied.added,
              removed: applied.removed, unmatched: unmatched.slice(0, 5), evicted,
              note: "Patch applied to YOUR state only. Shared State of Play aggregates all agents." }),
            metadata: { applied: true, version: next.version },
            title: `loom_state_patch:v${next.version}`,
          };
        } catch (e) {
          return { output: JSON.stringify({ error: `loom_state_patch failed: ${e.message}` }), metadata: { error: true }, title: "loom_state_patch error" };
        }
      },
    }),
  };
}
