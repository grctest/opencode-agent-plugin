import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { buildQueryPrompt, buildEvidencePrompt } from "../../prompts/interaction-prompts.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { degrade } from "../../utils/degrade.js";

export function createQueryEvidenceTools({ config, resolveMeeting, activeLooms }) {
  return {
    loom_query: tool({
      description:
        "Ask 1-2 peers a focused question. Their answers will be returned inline and recorded as query_response contributions. Use for clarifying assumptions or asking 'what was said'.",
      args: {
        targets: tool.schema.array(tool.schema.string()).min(1).max(2).describe("Participant IDs to query (max 2, e.g. ['junior_0'])"),
        question: tool.schema.string().min(1).max(500).describe("Your question (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_query) return { error: "loom_query not enabled" };
        if (!args.targets || args.targets.length === 0) return { error: "targets required" };
        if (!context?.sessionID) return { error: "loom_query: session context unavailable" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, note: "Query queued — meeting not yet resolved, will be handled post-store." , targets: args.targets, question: args.question };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) return { queued: true, targets: args.targets, question: args.question, note: "Query queued — engine not ready." };
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const db = engine.getDatabase();
          if (!stateManager || !sessionManager || !db) return { queued: true, targets: args.targets, question: args.question, note: "Query queued — state not ready." };
          // For inline execution, we need to prompt targets now and return their answers.
          // We use the same logic as RoundExecutor.executeQueries but inline, and return results for the invoker to synthesize.
          // To avoid double-creation, we set a flag that post-store handling should skip if inline succeeded.
          // For now, return queued and let RoundExecutor handle post-store creation; the inline result will be the peer answers returned as tool output.
          // We perform the actual peer prompting here to provide inline results.
          const allParticipants = stateManager.getParticipants();
          if (!Array.isArray(allParticipants)) return { error: "loom_query: participant list unavailable" };
          const targets = args.targets.map(id => allParticipants.find(p => p?.config?.id === id)).filter(p => p && p.status !== "failed" && p.status !== "passed" && p.status !== "muted");
          if (targets.length === 0) return { error: `No eligible targets among [${args.targets.join(", ")}] — all filtered (self/failed/passed).` };
          const caller = allParticipants.find(p => p.session_id === context.sessionID) || allParticipants.find(p => p?.config?.id && args.targets.includes(p.config.id) === false) || null;
          // Use a lightweight inline prompt for each target (without creating DB rows yet — let RoundExecutor create them post-store, but return preview)
          // For true inline, we prompt here and return the answers directly.
          const results = [];
          for (const target of targets) {
            try {
              const model = (() => {
                try { return engine.getParticipantModel ? engine.getParticipantModel(target) : null; } catch { return null; }
              })();
              if (!model) { results.push({ participantId: target.config.id, error: "no model" }); continue; }
              // Shared ephemeral-prompt primitive (audit 10 MA1)
              const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
              const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];
              const prompt = buildQueryPrompt(
                { config: { name: "Caller", tier: "mid", id: "caller" } },
                target,
                args.question,
                args.question,
                roundContribs,
                stateManager.getCurrentRound(),
                stateManager.getMaxRounds(),
                stateOfPlay
              );
              const systemPrompt = `You are ${target.config.name} (${target.config.tier}) — answering a directed query in Loom. Be concise (2-4 sentences), grounded, and in character. Answer the specific question, not the whole deliberation. Cite Source: [#id] or URL if you use evidence. Never emit <<< or >>>.`;
              const res = await sessionManager.runEphemeralPrompt(target, {
                system: systemPrompt,
                model,
                temperature: target.tier_config?.temperature ?? 0.7,
                parts: [{ type: "text", text: prompt }],
                tools: (() => {
                  const t = config.getValue("agentTools");
                  const m = {};
                  if (t?.builtIn?.webfetch || t?.builtIn?.web_fetch) m.webfetch = true;
                  if (t?.builtIn?.websearch || t?.builtIn?.web_search) m.websearch = true;
                  if (t?.builtIn?.read) m.read = true;
                  if (t?.loom?.loom_vector_search) m.loom_vector_search = true;
                  return m;
                })(),
                toolChoice: "auto",
                timeoutMs: 60000,
              }, meetingInfo.meetingId);
              if (!res || !res.ok) { results.push({ participantId: target.config.id, error: res?.error?.message ?? "prompt failed" }); continue; }
                            const { text, toolResults } = extractAgentResponse(res.data);
              const content = (text ?? "").slice(0,2000);
              // Store as query_response for timeline aesthetic (so it appears as indented row even though inline)
              try {
                const allParts = stateManager.getParticipants();
                const callerForBatch = allParts.find(p => p.session_id === context.sessionID) || null;
                const batchId = callerForBatch?.currentBatchId ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
                const currentRound = stateManager.getCurrentRound();
                let roundObj = null;
                try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
                const contributionTools = mapToolResults(toolResults);
                const contrib = {
                  id: stateManager.nextContributionId(),
                  round: currentRound,
                  participant_id: target.config.id,
                  content: `[Response to query from ${callerForBatch?.config?.name ?? "caller"}]\n\n${content}`,
                  type: "query_response",
                  targets_which: null,
                  batch_id: batchId,
                  tool_calls: contributionTools ?? [],
                  prompt_context: { type: "query_response", question: args.question, round: currentRound },
                  created_at: new Date().toISOString(),
                };
                stateManager.addContribution(contrib);
                if (roundObj) roundObj.contributions.push(contrib);
                degrade("contribution_db_failed", "Failed to persist contribution — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, contrib, null), null);
                results.push({ participantId: target.config.id, name: target.config.name, content: content.slice(0,800), contributionId: contrib.id });
              } catch {
                results.push({ participantId: target.config.id, name: target.config.name, content: content.slice(0,800) });
              }
            } catch (e) {
              results.push({ participantId: target.config.id, error: e.message });
            }
          }
          return { inline: true, targets: args.targets, question: args.question, responses: results, note: "Inline query — peer answers returned for synthesis and stored as indented query_response rows." };
        } catch (e) {
          return { error: `loom_query inline failed: ${e.message}`, queued: true, targets: args.targets, question: args.question };
        }
      },
    }),

    loom_evidence: tool({
      description:
        "Request evidence from 1-2 peers. They MUST use a research tool (websearch/webfetch/read/loom_vector_search) and report Finding + Source + Strength.",
      args: {
        targets: tool.schema.array(tool.schema.string()).min(1).max(2).describe("Participant IDs to request evidence from (max 2)"),
        question: tool.schema.string().min(1).max(500).describe("Evidence question (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_evidence) return { error: "loom_evidence not enabled" };
        if (!context?.sessionID) return { error: "loom_evidence: session context unavailable" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, targets: args.targets, question: args.question, note: "Evidence queued — meeting not resolved." };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) return { queued: true, targets: args.targets, question: args.question, note: "Evidence queued — engine not ready." };
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const allParticipants = stateManager.getParticipants();
          if (!Array.isArray(allParticipants)) return { error: "loom_evidence: participant list unavailable" };
          const targets = args.targets.map(id => allParticipants.find(p => p?.config?.id === id)).filter(p => p && p.status !== "failed" && p.status !== "passed" && p.status !== "muted");
          if (targets.length === 0) return { error: `No eligible targets among [${args.targets.join(", ")}]` };
          const results = [];
          for (const target of targets) {
            try {
              const model = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(target) : null; } catch { return null; } })();
              if (!model) { results.push({ participantId: target.config.id, error: "no model" }); continue; }
              // Shared ephemeral-prompt primitive (audit 10 MA1)
              const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
              const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];
              const prompt = buildEvidencePrompt(
                { config: { name: "Caller", tier: "mid", id: "caller" } },
                target,
                args.question,
                args.question,
                roundContribs,
                stateManager.getCurrentRound(),
                stateManager.getMaxRounds()
              );
              const systemPrompt = `You are ${target.config.name} (${target.config.tier}) — providing evidence in Loom. You MUST use at least one research tool. No speculation. Structure: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong|weak|inconclusive. If inconclusive, state why and what would resolve it. 100-180 words, in character, never emit <<< or >>>.`;
              const res = await sessionManager.runEphemeralPrompt(target, {
                system: systemPrompt,
                model,
                temperature: target.tier_config?.temperature ?? 0.7,
                parts: [{ type: "text", text: prompt }],
                tools: (() => {
                  const t = config.getValue("agentTools");
                  const m = {};
                  if (t?.builtIn?.webfetch || t?.builtIn?.web_fetch) m.webfetch = true;
                  if (t?.builtIn?.websearch || t?.builtIn?.web_search) m.websearch = true;
                  if (t?.builtIn?.read) m.read = true;
                  if (t?.loom?.loom_vector_search) m.loom_vector_search = true;
                  return m;
                })(),
                toolChoice: "required",
                timeoutMs: 90000,
              }, meetingInfo.meetingId);
              if (!res || !res.ok) { results.push({ participantId: target.config.id, error: res?.error?.message ?? "prompt failed" }); continue; }
                            const { text, toolResults } = extractAgentResponse(res.data);
              const content = (text ?? "").slice(0,2000);
              try {
                const allParts = stateManager.getParticipants();
                const callerForBatch = allParts.find(p => p.session_id === context.sessionID) || null;
                const batchId = callerForBatch?.currentBatchId ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
                const currentRound = stateManager.getCurrentRound();
                let roundObj = null;
                try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
                const contributionTools = mapToolResults(toolResults);
                const contrib = {
                  id: stateManager.nextContributionId(),
                  round: currentRound,
                  participant_id: target.config.id,
                  content: `[Evidence from ${target.config.name}]\n\n${content}`,
                  type: "evidence_response",
                  targets_which: null,
                  batch_id: batchId,
                  tool_calls: contributionTools ?? [],
                  prompt_context: { type: "evidence_response", question: args.question, round: currentRound },
                  created_at: new Date().toISOString(),
                };
                stateManager.addContribution(contrib);
                if (roundObj) roundObj.contributions.push(contrib);
                try { const db2 = stateManager.getState ? engine.getDatabase() : null; if (db2) db2.addContributionWithTurnRequest(stateManager.getState().id, contrib, null); } catch (dbErr) { logger.warn('contribution_db_failed', `Failed to persist ${contrib.type} for ${target.config.id} — visible in memory only this session`, { error: dbErr?.message }); }
                results.push({ participantId: target.config.id, name: target.config.name, content: content.slice(0,800), contributionId: contrib.id });
              } catch {
                results.push({ participantId: target.config.id, name: target.config.name, content: content.slice(0,800) });
              }
            } catch (e) { results.push({ participantId: target.config.id, error: e.message }); }
          }
          return { inline: true, targets: args.targets, question: args.question, responses: results, note: "Inline evidence — peer findings returned for synthesis and stored as indented evidence_response rows." };
        } catch (e) {
          return { error: `loom_evidence inline failed: ${e.message}`, queued: true, targets: args.targets, question: args.question };
        }
      },
    }),

  };
}
