import { tool } from "@opencode-ai/plugin";
import { loomToolRefusal } from "./audit.js";

export function createStatePatchTool({ config, resolveMeeting, activeLooms }) {
  return {
    loom_state_patch: tool({
      description:
        "Maintain your private notes for your next turn. Call ONCE per turn with your stance " +
        "and any new established/contested/open/facts/files bullets (1-3 each), plus exact-text " +
        "`remove` entries for your own outdated bullets. Your contribution prose is what the room reads — " +
        "this tool only updates your own notes. At least one field required.",
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
          .describe("Tool-backed or cited facts with Source/[#id] (up to 3). These are evidence and survive FIFO eviction longer than other bullets, but only the newest few are protected — re-assert anything critical each turn you still rely on."),
        files_add: tool.schema.array(tool.schema.string().min(1).max(160)).max(3).optional()
          .describe("File paths touched (up to 3, e.g. src/auth/jwt.ts)"),
        remove: tool.schema.array(tool.schema.string().min(1).max(280)).max(5).optional()
          .describe("Text of YOUR outdated bullets to delete (up to 5). Matched case-insensitively after whitespace collapsing — copy the bullet text closely."),
      },
       async execute(args, context) {
         if (!context?.sessionID)
          return { output: JSON.stringify({ error: "session context unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo)
            return { output: JSON.stringify({ error: "meeting not resolved", queued: false }), metadata: { error: true }, title: "loom_state_patch error" };
          const engine = activeLooms.get(meetingInfo.meetingId);
          const cfg = engine?.getRoundExecutor?.()?.getEffectiveAgentTools?.() ?? config.getValue("agentTools");
          if (!cfg?.enabled || !cfg?.loom?.loom_state_patch)
            return { output: JSON.stringify({ error: "loom_state_patch not enabled" }), metadata: { error: true }, title: "loom_state_patch error" };
          const sm = engine?.getStateManager?.();
          const db = engine?.getDatabase?.();
          if (!sm || !db || typeof sm.getParticipantState !== "function" || typeof sm.setParticipantState !== "function")
            return { output: JSON.stringify({ error: "state not ready" }), metadata: { error: true }, title: "loom_state_patch error" };

          // Resolve caller (same helper as query-evidence.js: resolveCaller)
          const { resolveCaller } = await import("./shared.js");
          const sessionManager = engine.getSessionManager?.();
          // Ephemeral sub-agent branch (loom_query/loom_vote targets): the
          // target answers inside the asker's primary turn, so there is no
          // activeTurn for it and resolveCaller would misattribute to the
          // asker. The owner was recorded at runEphemeralPrompt time.
          // Answer-first, patch-last is prompt-enforced; here we enforce
          // own-state-only + at-most-once per ephemeral session.
          let ephemeralOwnerId = null;
          try { ephemeralOwnerId = sessionManager?.resolveEphemeralOwner?.(context.sessionID) ?? null; } catch {}
          if (ephemeralOwnerId) {
            // N6 — the audit row needs a participant id; the ephemeral owner is
            // the participant the patch would have belonged to.
            const ownerParticipant = sm.getParticipant?.(ephemeralOwnerId) ?? { config: { id: ephemeralOwnerId, name: ephemeralOwnerId } };
            if (sessionManager?.hasEphemeralPatchApplied?.(context.sessionID)) {
              return loomToolRefusal({ db, stateManager: sm, caller: ownerParticipant, meetingId: meetingInfo.meetingId, tool: "loom_state_patch", input: args,
                error: "only one loom_state_patch call is allowed per query answer", reason: "state_patch_rejected",
                metadata: { validationFailed: true }, title: "loom_state_patch error" });
            }
            const { StatePatchSchema } = await import("../../schemas.js");
            const parsedEphemeral = StatePatchSchema.safeParse({
              stance: args.stance, established_add: args.established_add ?? [],
              contested_add: args.contested_add ?? [], open_add: args.open_add ?? [],
              facts_add: args.facts_add ?? [], files_add: args.files_add ?? [],
              remove: args.remove ?? [],
            });
            if (!parsedEphemeral.success)
              return loomToolRefusal({ db, stateManager: sm, caller: ownerParticipant, meetingId: meetingInfo.meetingId, tool: "loom_state_patch", input: args,
                error: "invalid patch", extra: { issues: parsedEphemeral.error.issues.slice(0, 5) },
                reason: "state_patch_rejected", metadata: { validationFailed: true }, title: "loom_state_patch error" });
            const { applyStatePatch } = await import("../../state-patch.js");
            const prevEphemeral = sm.getParticipantState(ephemeralOwnerId);
            const { next, applied, unmatched, evicted, overCap, skipped } = applyStatePatch(prevEphemeral, parsedEphemeral.data);
            next.updated_round = sm.getCurrentRound?.() ?? 0;
            try { sm.setParticipantState(ephemeralOwnerId, next); } catch {}
            try { sm.markStateDirty?.(ephemeralOwnerId); } catch {}
            try {
              if (typeof db.setParticipantState === "function") db.setParticipantState(ephemeralOwnerId, next);
            } catch {}
            try {
              if (typeof db.addStatePatch === "function") {
                db.addStatePatch({
                  participantId: ephemeralOwnerId,
                  round: sm.getCurrentRound?.() ?? 0,
                  contributionId: null,
                  version: next.version,
                  patchJson: args,
                  appliedJson: { applied: true, version: next.version },
                });
              }
            } catch {}
            try {
              const { auditLoomTool } = await import("./audit.js");
              auditLoomTool({ db, stateManager: sm, caller: ownerParticipant, meetingId: meetingInfo.meetingId,
                tool: "loom_state_patch", input: args,
                output: JSON.stringify({ applied: true, version: next.version, ephemeral: true }),
                status: "completed", title: `loom_state_patch:v${next.version} (query answer)` });
            } catch {}
            try { sessionManager?.markEphemeralPatchApplied?.(context.sessionID); } catch {}
            return {
              output: JSON.stringify({ applied: true, version: next.version, added: applied.added,
                removed: applied.removed, unmatched: unmatched.slice(0, 5), evicted, overCap, skipped,
                note: "Patch applied to YOUR state. Your prose answer is still required — a patch never substitutes for it." }),
              metadata: { applied: true, version: next.version, ephemeral: true },
              title: `loom_state_patch:v${next.version} (query answer)`,
            };
          }
          const caller = resolveCaller(sm.getParticipants(), sm.getWeave?.() ?? [], context.sessionID);
          // N6 — every refusal is audited with a non-completed status and a
          // named degraded reason. Before this, four rejected patches in one
          // meeting left a database reporting 100% of tool_audit rows
          // `completed` and zero errors: the failure existed only in prose.
          const refuse = (error, patchArgs, refCaller, extra) => loomToolRefusal({
            db, stateManager: sm, caller: refCaller, meetingId: meetingInfo.meetingId,
            tool: "loom_state_patch", input: patchArgs, error,
            ...(extra ? { extra: { issues: extra } } : {}),
            reason: "state_patch_rejected", metadata: { validationFailed: true },
            title: "loom_state_patch error",
          });
           if (!caller?.config?.id)
             return { output: JSON.stringify({ error: "caller identity unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };
           const activeTurn = sm.getActiveTurn?.();
           if (activeTurn?.participantId === caller.config.id && activeTurn.passRequested) {
             return refuse("state patch cannot follow loom_pass in the same turn", args, caller);
           }
           if (activeTurn?.participantId === caller.config.id && activeTurn.patchApplied) {
             return refuse("only one loom_state_patch call is allowed per turn", args, caller);
           }
           if (!activeTurn || activeTurn.participantId !== caller.config.id) {
             return refuse("state patch requires the caller's active primary turn", args, caller);
           }

           // Validate via Zod (same StatePatchSchema as §5.2).
          // Unknown keys are rejected explicitly here: the parse object below
          // is constructed with known keys only, so Zod .strict() would never
          // see them (§9: unknown keys must reject, not silently drop).
          const ALLOWED_PATCH_KEYS = new Set(["stance", "established_add", "contested_add", "open_add", "facts_add", "files_add", "remove"]);
          const unknownKeys = Object.keys(args ?? {}).filter((k) => !ALLOWED_PATCH_KEYS.has(k));
          if (unknownKeys.length > 0)
            return refuse("invalid patch", args, caller, [{ message: `unknown keys: ${unknownKeys.slice(0, 5).join(", ")}` }]);
          const { StatePatchSchema } = await import("../../schemas.js");
          const parsed = StatePatchSchema.safeParse({
            stance: args.stance, established_add: args.established_add ?? [],
            contested_add: args.contested_add ?? [], open_add: args.open_add ?? [],
            facts_add: args.facts_add ?? [], files_add: args.files_add ?? [],
            remove: args.remove ?? [],
          });
          if (!parsed.success)
            return refuse("invalid patch", args, caller, parsed.error.issues.slice(0, 5));

          const { applyStatePatch } = await import("../../state-patch.js");
          const prev = sm.getParticipantState(caller.config.id);
          const { next, applied, unmatched, evicted, overCap, skipped } = applyStatePatch(prev, parsed.data);
           next.updated_round = sm.getCurrentRound?.() ?? 0;

           const pending = sm.queueTurnPatch?.(caller.config.id, {
             participantId: caller.config.id,
             state: next,
             input: args,
             output: { applied: true, version: next.version, added: applied.added, removed: applied.removed, evicted, overCap, skipped },
           }) === true;
           if (!pending) {
             return refuse("could not queue state patch for this turn", args, caller);
           }
           const persisted = true;
           sm.markTurnPatchApplied?.();
           try {
             const { auditLoomTool } = await import("./audit.js");
             auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
               tool: "loom_state_patch", input: args,
               output: JSON.stringify({ applied: true, version: next.version, added: applied.added,
                 removed: applied.removed, evicted, overCap, skipped, pending }),
               status: "completed", title: `loom_state_patch:v${next.version}` });
           } catch {}

           return {
             output: JSON.stringify({ applied: true, version: next.version, added: applied.added,
               removed: applied.removed, unmatched: unmatched.slice(0, 5), evicted, overCap, skipped,
               note: pending ? "Patch queued for atomic commit with this turn's contribution." : "Patch applied to YOUR state only. Shared State of Play aggregates all agents." }),
             metadata: { applied: true, version: next.version, pending, persisted: persisted !== false },
             title: `loom_state_patch:v${next.version}`,
           };
        } catch (e) {
          return { output: JSON.stringify({ error: `loom_state_patch failed: ${e.message}` }), metadata: { error: true }, title: "loom_state_patch error" };
        }
      },
    }),
  };
}
