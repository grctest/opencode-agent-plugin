import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { buildQueryPrompt, buildEvidencePrompt } from "../../prompts/interaction-prompts.js";
import { QUERY_MODES, QUERY_MODE_NAMES, researchTools } from "../../prompts/query-modes.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { degrade } from "../../utils/degrade.js";
import { Logger } from "../../logger.js";
import { resolveCaller, resolveModel, buildBatchId, findExistingQueryResponse } from "./shared.js";
const logger = new Logger();

function normalizeQueries(args) {
  if (!Array.isArray(args.queries)) return [];
  return args.queries
    .filter((q) => q && typeof q.target === "string" && q.target.trim().length > 0 && typeof q.question === "string" && q.question.trim().length > 0)
    .map((q) => ({
      targetId: q.target.trim(),
      question: q.question.trim(),
      mode: QUERY_MODES[q.mode] ? q.mode : "clarify",
    }));
}

export function createQueryEvidenceTools({ config, resolveMeeting, activeLooms }) {
  return {
    loom_query: tool({
      description:
        "Query one or more peers — pass `queries: [{target, question, mode}]`, one item per peer. Modes: " +
        "'clarify' (default; factual answer), 'perspective' (solicit their stance on your statement — Position-tagged opinion), " +
        "'evidence' (they MUST use a research tool; Finding + Source + Strength), 'critique' (adversarially stress-test your statement — most damaging objection), " +
        "'risks' (failure modes + severity + mitigation), 'assumptions' (unstated premises + how to test them), 'alternatives' (genuinely different approaches). " +
        "Answers are returned inline for same-turn synthesis.",
      args: {
        queries: tool.schema
          .array(
            tool.schema.object({
              target: tool.schema.string().min(1).describe("Participant ID to query (e.g. 'junior_0')"),
              question: tool.schema.string().min(1).max(500).describe("Your question for this target (1-500 chars)"),
              mode: tool.schema.enum(QUERY_MODE_NAMES).optional().describe("Query kind — default 'clarify'"),
            }),
          )
          .min(1)
          .describe("One query object per target peer"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_query) return { output: JSON.stringify({ error: "loom_query not enabled" }), metadata: { error: true }, title: "loom_query error" };
        const queries = normalizeQueries(args);
        if (queries.length === 0) return { output: JSON.stringify({ error: "queries required — at least one {target, question} item" }), metadata: { error: true }, title: "loom_query error" };
        if (!context?.sessionID) return { output: JSON.stringify({ error: "loom_query: session context unavailable" }), metadata: { error: true }, title: "loom_query error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) {
            const p = { queued: true, note: "Query queued — meeting not yet resolved, will be handled post-store.", queries };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_query queued" };
          }
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) {
            const p = { queued: true, queries, note: "Query queued — engine not ready." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_query queued" };
          }
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const db = engine.getDatabase();
          if (!stateManager || !sessionManager || !db) {
            const p = { queued: true, queries, note: "Query queued — state not ready." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_query queued" };
          }
          const allParticipants = stateManager.getParticipants();
          if (!Array.isArray(allParticipants)) return { output: JSON.stringify({ error: "loom_query: participant list unavailable" }), metadata: { error: true }, title: "loom_query error" };

          let caller = resolveCaller(allParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          const activeCountQ = (() => { try { return stateManager.getActiveParticipants().length; } catch { return allParticipants.filter(p=>p.status!=="failed"&&p.status!=="passed").length; }})();
          if (activeCountQ <= 1) return { output: JSON.stringify({ error: "loom_query unavailable with 1 active participant — use loom_vector_search or loom_summon instead", activeCount: activeCountQ }), metadata: { error: true }, title: "loom_query error" };
          // Resolve each query to an eligible target participant (exclude self)
          const resolved = queries
            .map((q) => ({ ...q, participant: allParticipants.find((p) => p?.config?.id === q.targetId) }))
            .filter((q) => q.participant && q.participant.status !== "failed" && q.participant.status !== "passed" && q.targetId !== caller?.config?.id);
          const skipped = queries.filter((q) => !resolved.some((r) => r.targetId === q.targetId)).map((q) => ({ target: q.targetId, error: "ineligible target (unknown/self/failed/passed)" }));
          const sourceName = caller?.config?.name ?? "Unknown";

          const results = [...skipped];
          const currentRound = stateManager.getCurrentRound?.() ?? 0;
          const meetingIdForBatch = stateManager.getState?.()?.id ?? meetingInfo.meetingId;
          const fallbackForCheck = buildBatchId(meetingIdForBatch, currentRound, caller?.config?.id);
          const batchIdForCheck = (() => {
            try {
              const cfb = resolveCaller(allParticipants, stateManager.getWeave?.() ?? [], context.sessionID) || caller;
              return cfb?.currentBatchId ?? fallbackForCheck;
            } catch { return fallbackForCheck; }
          })();
          // All plausible batchIds across retry drift (caller resolution may change after status reset)
          const allBatchCandidates = (() => {
            const s = new Set();
            if (batchIdForCheck) s.add(batchIdForCheck);
            if (fallbackForCheck) s.add(fallbackForCheck);
            for (const p of allParticipants) if (p?.currentBatchId) s.add(p.currentBatchId);
            // deterministic fallback for every participant (covers mis-identified caller)
            for (const p of allParticipants) s.add(buildBatchId(meetingIdForBatch, currentRound, p?.config?.id));
            return [...s];
          })();
           for (const { participant: target, question, mode } of resolved) {
            if (context.abort?.aborted || context.signal?.aborted) break;
            const meta = QUERY_MODES[mode];
            // Idempotent retry guard: reuse existing response instead of re-prompting peer.
            // Uses normalized question + broad fallback (batch drift / status reset) per shared helper.
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              const existing = findExistingQueryResponse(weave, {
                batchId: batchIdForCheck,
                fallbackBatchIds: allBatchCandidates,
                targetId: target.config.id,
                contributionType: meta.contributionType,
                question,
                sourceId: caller?.config?.id ?? null,
                round: currentRound,
              });
              if (existing) {
                const raw = (existing.content ?? "").replace(/^\[.+?\]\s*/m, "").trim();
                results.push({ target: target.config.id, name: target.config.name, mode, content: raw.slice(0,800), contributionId: existing.id, reused: true });
                continue;
              }
            } catch {}
            try {
              let model = resolveModel(engine, target, stateManager);
              if (!model) {
                logger.warn("participant_model_missing", `No model resolvable for ${target.config.id} — ${meta.contributionType} skipped`, { participant: target.config.id });
                results.push({ target: target.config.id, mode, error: "peer model unavailable — could not respond (no model assignment); treat their claim as unverified" });
                continue;
              }

              const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
              const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];

              const callerForPrompt = caller ?? { config: { name: sourceName, tier: "mid", id: "unknown" } };
              let prompt;
              if (mode === "evidence") {
                prompt = buildEvidencePrompt(
                  callerForPrompt,
                  target,
                  question,
                  question,
                  roundContribs,
                  stateManager.getCurrentRound(),
                  stateManager.getMaxRounds()
                );
              } else {
                prompt = buildQueryPrompt(
                  callerForPrompt,
                  target,
                  question,
                  question,
                  roundContribs,
                  stateManager.getCurrentRound(),
                  stateManager.getMaxRounds(),
                  stateOfPlay,
                  mode
                );
              }

              const systemPrompt = meta.systemPrompt(target);
              const res = await sessionManager.runEphemeralPrompt(target, {
                system: systemPrompt,
                model,
                parts: [{ type: "text", text: prompt }],
                tools: researchTools(),
                timeoutMs: meta.timeoutMs,
                signal: context.abort,
                abort: context.abort,
              }, meetingInfo.meetingId);
              if (!res || !res.ok) { results.push({ target: target.config.id, mode, error: res?.error?.message ?? "prompt failed" }); continue; }

              const { text, toolResults } = extractAgentResponse(res.data);
              const content = (text ?? "").slice(0,2000);

              // Persist as a typed contribution grouped under the invoker's batch
              try {
                const callerForBatch = resolveCaller(allParticipants, stateManager.getWeave?.() ?? [], context.sessionID) || caller;
                // Deterministic fallback keeps batch linkable: meetingId-round-callerId
                const fallbackBatch = buildBatchId(stateManager.getState?.()?.id ?? meetingInfo.meetingId, stateManager.getCurrentRound?.() ?? 0, caller?.config?.id);
                const batchId = callerForBatch?.currentBatchId ?? caller?.currentBatchId ?? fallbackBatch;
                const currentRound = stateManager.getCurrentRound();
                let roundObj = null;
                try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
                const contributionTools = mapToolResults(toolResults);
                const contrib = {
                  id: stateManager.nextContributionId(),
                  round: currentRound,
                  participant_id: target.config.id,
                  content: `${meta.contentPrefix(target.config.name, sourceName)}\n\n${content}`,
                  type: meta.contributionType,
                  targets_which: null,
                  batch_id: batchId,
                  tool_calls: contributionTools ?? [],
                  prompt_context: {
                    type: meta.contributionType,
                    mode,
                    question,
                    round: currentRound,
                    source_participant_id: caller?.config?.id ?? null,
                    source_participant_name: sourceName,
                    source_batch_id: batchId,
                    system_prompt: systemPrompt,
                    user_prompt: prompt,
                    state_of_play: stateOfPlay,
                    round_contributions_used: roundContribs.slice(-4).map(c => ({ id: c.id, participant_id: c.participant_id, type: c.type, content: (c.content ?? "").slice(0,300) })),
                  },
                  created_at: new Date().toISOString(),
                };
                stateManager.addContribution(contrib);
                if (roundObj) roundObj.contributions.push(contrib);
                degrade("contribution_db_failed", "Failed to persist contribution — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, contrib, null), null);

                // Perspective answers update the responder's stored reflection — this path
                // is replacing automatic challenge/dissent reflections long-term.
                if (mode === "perspective" && text && text.trim()) {
                  try {
                    const trimmed = text.trim();
                    target.reflection = trimmed;
                    if (!Array.isArray(target.reflectionHistory)) target.reflectionHistory = [];
                    target.reflectionHistory.push({ round: currentRound, text: trimmed, at: Date.now() });
                    if (target.reflectionHistory.length > 5) target.reflectionHistory.shift();
                    db.setParticipantReflection(target.config.id, trimmed);
                  } catch {}
                }

                results.push({ target: target.config.id, name: target.config.name, mode, content: content.slice(0,800), contributionId: contrib.id });
              } catch {
                results.push({ target: target.config.id, name: target.config.name, mode, content: content.slice(0,800) });
              }
            } catch (e) {
              results.push({ target: target.config.id, mode, error: e.message });
            }
          }
          const inlinePayload = { inline: true, queries, responses: results, note: "Inline query — peer answers returned for synthesis and stored as indented rows." };
          return { output: JSON.stringify(inlinePayload), metadata: { inline: true, responseCount: results.length - skipped.length }, title: `loom_query:${results.length - skipped.length} responses` };
        } catch (e) {
          const p = { error: `loom_query inline failed: ${e.message}`, queued: true, queries };
          return { output: JSON.stringify(p), metadata: { error: true, queued: true }, title: "loom_query error" };
        }
      },
    }),
  };
}
