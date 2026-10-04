import { tool } from "@opencode-ai/plugin";
import { loomToolRefusal } from "./audit.js";

export function createStatePatchTool({ config, resolveMeeting, activeLooms }) {
  return {
    loom_state_patch: tool({
      description:
        "Maintain your private notes for your next turn. Call ONCE per turn with your stance " +
        "and any new established/contested/open/facts/files bullets, plus exact-text " +
        "`remove` entries for your own outdated bullets. Your contribution prose is what the room reads — " +
        "this tool only updates your own notes. At least one field required. " +
        "Write as much as your reasoning needs: there is no length limit and nothing you send is " +
        "refused for shape. Calling twice in one turn merges the two rather than failing.",
      args: {
        // Intentionally permissive: a list field also accepts a bare string, and
        // a nested object is flattened to its text. Nothing here can reject.
        stance: tool.schema.union([tool.schema.string(), tool.schema.array(tool.schema.string())]).optional()
          .describe("Where you stand now (overwrites previous stance)"),
        established_add: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("Points you consider settled"),
        contested_add: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("Points still disputed"),
        open_add: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("Unresolved questions"),
        facts_add: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("Tool-backed or cited facts with Source/[#id]. These are evidence and survive FIFO eviction longer than other bullets, but only the newest few are protected — re-assert anything critical each turn you still rely on."),
        files_add: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("File paths touched (e.g. src/auth/jwt.ts)"),
        remove: tool.schema.union([tool.schema.array(tool.schema.string()), tool.schema.string()]).optional()
          .describe("Text of YOUR outdated bullets to delete. Matched case-insensitively after whitespace collapsing — copy the bullet text closely."),
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
          // Ephemeral sub-agent branch (loom_query/loom_vote/summon targets):
          // patching is primary-tail-only by design. A peer answer runs
          // inside the asker's primary turn with no activeTurn of its own,
          // so allowing it here would bypass atomic commit (contribution +
          // state in one txn) and let a sub-agent write outside the tail's
          // full-turn context. Refuse with guidance; the asker's tail will
          // project anything worth keeping.
          let ephemeralOwnerId = null;
          try { ephemeralOwnerId = sessionManager?.resolveEphemeralOwner?.(context.sessionID) ?? null; } catch {}
          if (ephemeralOwnerId) {
            const ownerParticipant = sm.getParticipant?.(ephemeralOwnerId) ?? { config: { id: ephemeralOwnerId, name: ephemeralOwnerId } };
            return loomToolRefusal({
              db, stateManager: sm, caller: ownerParticipant, meetingId: meetingInfo.meetingId,
              tool: "loom_state_patch", input: args,
              error: "loom_state_patch runs only in the primary turn's patch tail — peer answers cannot patch directly; the asker's tail projects what survives",
              reason: "state_patch_ephemeral_refused", metadata: { validationFailed: true },
              title: "loom_state_patch error",
            });
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
           if (!activeTurn || activeTurn.participantId !== caller.config.id) {
             return refuse("state patch requires the caller's active primary turn", args, caller);
           }

           // Shape is never a rejection reason. coerceStatePatch normalizes
           // whatever arrived — bare string where a list was expected, a nested
           // object mirroring the `_add` suffix, more bullets than any cap, text
           // longer than the old maxima, unknown keys — and applyStatePatch trims
           // to STATE_PATCH_CAPS at storage time. What is left is only notes.
           const { StatePatchSchema } = await import("../../schemas.js");
           const { coerceStatePatch, applyStatePatch, mergeStatePatches } = await import("../../state-patch.js");
           const parsed = StatePatchSchema.safeParse(args);
           const coerced = coerceStatePatch(parsed.success ? parsed.data : args);

           if (coerced.empty) {
             // Nothing readable arrived. That is a no-op, not a failure: report
             // success so a patch can never be the reason a turn dies.
             try {
               const { auditLoomTool } = await import("./audit.js");
               auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
                 tool: "loom_state_patch", input: args,
                 output: JSON.stringify({ applied: false, reason: "no readable fields", notes: coerced.notes }),
                 status: "completed", title: "loom_state_patch:no-op" });
             } catch {}
             return {
               output: JSON.stringify({ applied: false, notes: coerced.notes,
                 note: "No readable fields arrived, so nothing changed. Send `stance` or at least one bullet." }),
               metadata: { applied: false, noop: true },
               title: "loom_state_patch:no-op",
             };
           }

           // A second patch in the same turn merges with the first rather than
           // being refused: the pending patch already holds the earlier call, so
           // fold them and re-queue. Two calls is a habit, not a rule violation.
           const pendingState = sm.getActiveTurn?.()?.pendingPatch?.state;
           if (pendingState) {
             const merged = mergeStatePatches(
               {
                 stance: pendingState.stance,
                 established_add: pendingState.established,
                 contested_add: pendingState.contested,
                 open_add: pendingState.open,
                 facts_add: pendingState.facts,
                 files_add: pendingState.files,
               },
               coerced.patch);
             const { next, applied: appliedM, evicted: evictedM, overCap: overCapM, skipped: skippedM } =
               applyStatePatch(sm.getParticipantState(caller.config.id), merged);
             next.updated_round = sm.getCurrentRound?.() ?? 0;
             const requeued = sm.queueTurnPatch?.(caller.config.id, {
               participantId: caller.config.id,
               state: next,
               input: args,
               output: { applied: true, version: next.version, added: appliedM.added, removed: appliedM.removed, evicted: evictedM, overCap: overCapM, skipped: skippedM, merged: true },
             }, { force: true }) === true;             try {
               const { auditLoomTool } = await import("./audit.js");
               auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
                 tool: "loom_state_patch", input: args,
                 output: JSON.stringify({ applied: requeued, version: next.version, merged: true, notes: coerced.notes }),
                 status: "completed", title: `loom_state_patch:v${next.version} (merged)` });
             } catch {}
             return {
               output: JSON.stringify({ applied: requeued, version: next.version, merged: true,
                 added: appliedM.added, notes: coerced.notes,
                 note: "Merged with the patch you already sent this turn. Your prose contribution is still required." }),
               metadata: { applied: requeued, version: next.version, merged: true },
               title: `loom_state_patch:v${next.version} (merged)`,
             };
           }

           const prev = sm.getParticipantState(caller.config.id);
           const { next, applied, unmatched, evicted, overCap, skipped } = applyStatePatch(prev, coerced.patch);
            next.updated_round = sm.getCurrentRound?.() ?? 0;

            const pending = sm.queueTurnPatch?.(caller.config.id, {
              participantId: caller.config.id,
              state: next,
              input: args,
              output: { applied: true, version: next.version, added: applied.added, removed: applied.removed, evicted, overCap, skipped },
            }) === true;
            if (!pending) {
              // Queueing failed for an infrastructure reason, not a caller error.
              // Fall back to applying in place so the agent's reasoning survives
              // even when the atomic-commit path is unavailable.
              try { sm.setParticipantState(caller.config.id, next); } catch {}
              try { sm.markStateDirty?.(caller.config.id); } catch {}
              try {
                if (typeof db.setParticipantState === "function") db.setParticipantState(caller.config.id, next);
              } catch {}
              try {
                const { auditLoomTool } = await import("./audit.js");
                auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
                  tool: "loom_state_patch", input: args,
                  output: JSON.stringify({ applied: true, version: next.version, pending: false, dequeued: true, notes: coerced.notes }),
                  status: "completed", title: `loom_state_patch:v${next.version} (applied direct)` });
              } catch {}
              return {
                output: JSON.stringify({ applied: true, version: next.version, pending: false,
                  added: applied.added, removed: applied.removed, evicted, overCap, skipped, notes: coerced.notes,
                  note: "Applied to YOUR state immediately (atomic commit unavailable this turn). Your prose contribution is still required." }),
                metadata: { applied: true, version: next.version, pending: false, persisted: true },
                title: `loom_state_patch:v${next.version} (applied direct)`,
              };
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
