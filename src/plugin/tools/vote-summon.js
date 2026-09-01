import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { buildVotePrompt, buildSummonPrompt } from "../../prompts/interaction-prompts.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
import { degrade } from "../../utils/degrade.js";
import * as sharedVoteTally from "../../utils/vote-tally.js";
import { TUNING } from "../../config/defaults.js";
import { getConfig } from "../../config.js";
import { resolveCaller, resolveModel, buildBatchId, normalizeQuestionForMatch } from "./shared.js";

export function createVoteSummonTools({ config, resolveMeeting, activeLooms }) {
  return {
    loom_vote: tool({
      description: "Call a vote with a lettered question (e.g. 'A) ... B) ...'). All other active participants will vote.",
      args: {
        question: tool.schema.string().min(1).max(500).describe("Vote question with lettered options, e.g. 'A) yes B) no'"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_vote) return { output: JSON.stringify({ error: "loom_vote not enabled" }), metadata: { error: true }, title: "loom_vote error" };
        if (!context?.sessionID) return { output: JSON.stringify({ error: "loom_vote: session context unavailable" }), metadata: { error: true }, title: "loom_vote error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) {
            const p = { queued: true, question: args.question, note: "Vote queued — meeting not resolved." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_vote queued" };
          }
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) {
            const p = { queued: true, question: args.question, note: "Vote queued — engine not ready." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_vote queued" };
          }
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const db = engine.getDatabase();
          if (!stateManager || !sessionManager || !db) {
            const p = { queued: true, question: args.question, note: "Vote queued — state not ready." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_vote queued" };
          }
          const allParticipants = stateManager.getParticipants();
          if (!Array.isArray(allParticipants)) return { output: JSON.stringify({ error: "loom_vote: participant list unavailable" }), metadata: { error: true }, title: "loom_vote error" };
          let caller = resolveCaller(allParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          const activeCountV = (() => { try { return stateManager.getActiveParticipants().length; } catch { return allParticipants.filter(p=>p.status!=="failed"&&p.status!=="passed").length; }})();
          if (activeCountV <= 1) return { output: JSON.stringify({ error: "loom_vote unavailable with 1 active participant — use loom_summon or loom_vector_search instead", activeCount: activeCountV }), metadata: { error: true }, title: "loom_vote error" };
          const currentRound = stateManager.getCurrentRound();
          const meetingIdForBatchV = stateManager.getState?.()?.id ?? meetingInfo.meetingId;
          const fallbackBatch = buildBatchId(meetingIdForBatchV, currentRound, caller?.config?.id);
          const callerBatchId = caller?.currentBatchId ?? fallbackBatch;
          // All plausible batchIds for idempotency (covers status-reset drift)
          const allBatchCandidatesV = (() => {
            const s = new Set();
            if (callerBatchId) s.add(callerBatchId);
            if (fallbackBatch) s.add(fallbackBatch);
            for (const p of allParticipants) if (p?.currentBatchId) s.add(p.currentBatchId);
            for (const p of allParticipants) s.add(buildBatchId(meetingIdForBatchV, currentRound, p?.config?.id));
            return [...s];
          })();
          const normQuestionV = normalizeQuestionForMatch(args.question);
          let roundObj = null;
          try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
          // Source snippet for context only — not a vote (source does not ballot, only voters do)
          const sourceSnippet = args.question.slice(0,300);
          // Voters = all other active participants excluding caller
          const voters = allParticipants.filter(p => (!caller || p.config.id !== caller.config.id) && p.status !== "failed" && p.status !== "passed");
          const extractVoteLetter = (text) => sharedVoteTally.extractVoteLetter(text);
          // Idempotent per-question guard: reuse existing votes across any plausible batch (retry guard with normalized match)
          const findExistingVotes = (weave, batchIds, questionNorm, sourceId, roundNum) => {
            // exact batch + normalized question
            for (const bid of batchIds) {
              const hits = weave.filter(c => c.batch_id === bid && c.type === "vote_response" && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === questionNorm);
              if (hits.length > 0) return hits;
            }
            // broader: same round + source + normalized question
            if (sourceId != null && roundNum != null) {
              const broad = weave.filter(c => c.round === roundNum && c.type === "vote_response" && c.prompt_context?.source_participant_id === sourceId && normalizeQuestionForMatch(c.prompt_context?.question ?? "") === questionNorm);
              if (broad.length > 0) return broad;
            }
            return [];
          };
          try {
            const weave = stateManager.getWeave ? stateManager.getWeave() : [];
            const existingVotesForQuestion = findExistingVotes(weave, allBatchCandidatesV, normQuestionV, caller?.config?.id ?? null, currentRound);
            if (existingVotesForQuestion.length > 0) {
              const voteResponses = existingVotesForQuestion.map(v => {
                const raw = (v.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                const name = v.content.match(/\[Vote from (.+?)\]/)?.[1] ?? v.participant_id;
                return { voter: name, content: raw };
              });
              const { lines: tallyLines } = sharedVoteTally.buildTally({
                question: args.question,
                sourceLetter: null,
                sourceLabel: caller?.config?.name ?? "source",
                responses: voteResponses,
              });
              const tallyContent = tallyLines.join("\n");
              const voterResults = existingVotesForQuestion.map(v => {
                const raw = (v.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                return { voter: v.participant_id, name: v.content.match(/\[Vote from (.+?)\]/)?.[1] ?? v.participant_id, content: raw.slice(0,200) };
              });
              const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, note: "Vote reused — partial poll already exists for this batch, tally rebuilt inline." };
              return { output: JSON.stringify(payload), metadata: { inline: true, voteCount: voterResults.length, reused: true }, title: `loom_vote:${voterResults.length} votes (reused)` };
            }
          } catch {}
          if (voters.length === 0) {
            const tallyContent = `[Vote Tally] ${args.question}\nNo voters (source does not ballot)\nTotal voters: 0`;
            const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: [], note: "Vote completed inline — source only (no voters, source does not ballot)." };
            return { output: JSON.stringify(payload), metadata: { inline: true }, title: "loom_vote:source only" };
          }
          // Parallel fan-out to voters — with hardened retry guard (any plausible batch + source+round fallback)
          const voteResponses = [];
          const voterResults = [];
          const hasExistingVote = (voterId) => {
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              for (const bid of allBatchCandidatesV) {
                if (weave.some(c => c.batch_id === bid && c.type === "vote_response" && c.participant_id === voterId)) return true;
              }
              // broader: same round + source + voter
              if (caller?.config?.id != null) {
                return weave.some(c => c.round === currentRound && c.type === "vote_response" && c.participant_id === voterId && c.prompt_context?.source_participant_id === caller.config.id);
              }
              return false;
            } catch { return false; }
          };
          const findExistingVoteForVoter = (voterId) => {
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              for (const bid of allBatchCandidatesV) {
                const hit = weave.find(c => c.batch_id === bid && c.type === "vote_response" && c.participant_id === voterId);
                if (hit) return hit;
              }
              if (caller?.config?.id != null) {
                return weave.find(c => c.round === currentRound && c.type === "vote_response" && c.participant_id === voterId && c.prompt_context?.source_participant_id === caller.config.id) ?? null;
              }
              return null;
            } catch { return null; }
          };
          await Promise.allSettled(voters.map(async (voter) => {
            // Idempotent skip: reuse existing vote for any plausible batch instead of re-prompting
            try {
              const existing = findExistingVoteForVoter(voter.config.id);
              if (existing) {
                const raw = (existing.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                voteResponses.push({ voter: voter.config.name, content: raw });
                voterResults.push({ voter: voter.config.id, name: voter.config.name, content: raw.slice(0,200), reused: true });
                return;
              }
            } catch {}
            let model = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(voter) : null; } catch { return null; }})();
            if (!model) {
              // Fallback: borrow any other participant's resolvable model rather than dropping the vote
              try {
                for (const p of stateManager.getParticipants()) {
                  if (!p || p.status === "failed") continue;
                  const m = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(p) : null; } catch { return null; } })();
                  if (m) { model = m; break; }
                }
              } catch {}
            }
            if (!model) {
              voterResults.push({ voter: voter.config.id, error: "peer model unavailable — vote not cast (no model assignment)" });
              return;
            }
            let previousStatus = voter.status;
            try {
              previousStatus = voter.status;
              if (context.abort?.aborted || context.signal?.aborted) return;
              voter.status = "speaking";
              try { db.setParticipantStatus(voter.config.id, "speaking"); } catch {}
              const callerForPrompt = caller ?? { config: { name: allParticipants.find(p=>p.status==="speaking")?.config?.name ?? "Unknown", tier: "mid", id: allParticipants.find(p=>p.status==="speaking")?.config?.id ?? "unknown" } };
              const prompt = buildVotePrompt(
                callerForPrompt,
                voter,
                sourceSnippet,
                args.question,
                stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= currentRound - 1).slice(-12) : [],
                currentRound,
                stateManager.getMaxRounds(),
                stateManager.getStateOfPlay?.() ?? ""
              );
              const systemPrompt = `You are ${voter.config.name} (${voter.config.tier}) — voting in Loom.\n\nChoose one letter (A/B/C…) as listed in the vote question. Format exactly:\n[Vote: X]\nOne sentence criterion (cost/risk/time/reversibility) reflecting your agenda. No contribution tags, 1-2 sentences total, in character.`;
              const effectiveSourceId = caller?.config?.id ?? callerForPrompt.config.id;
              const promptContext = {
                type: "vote_response",
                system_prompt: systemPrompt,
                user_prompt: prompt,
                source_participant_id: effectiveSourceId,
                source_participant_name: caller?.config?.name ?? callerForPrompt.config.name,
                question: args.question,
                round: currentRound,
              };
              // Shared ephemeral-prompt primitive (audit 10 MA1) — scoped: votes need no tools (no bash/read per user request)
              const res = await sessionManager.runEphemeralPrompt(voter, {
                system: systemPrompt,
                model,
                parts: [{ type: "text", text: prompt }],
                tools: {},
                timeoutMs: getConfig()?.tuning?.VOTE_TIMEOUT_MS ?? TUNING.VOTE_TIMEOUT_MS,
                signal: context.abort,
                abort: context.abort,
              }, meetingInfo.meetingId);
              if (!res.ok) throw res.error;
                            const { text } = extractAgentResponse(res.data);
              if (!text || text.trim().length < 5) return;
              const contrib = {
                id: stateManager.nextContributionId(),
                round: currentRound,
                participant_id: voter.config.id,
                content: `[Vote from ${voter.config.name}]\n\n${text.trim()}`,
                type: "vote_response",
                targets_which: null,
                batch_id: callerBatchId,
                tool_calls: null,
                prompt_context: promptContext,
                created_at: new Date().toISOString(),
              };
              stateManager.addContribution(contrib);
              if (roundObj) roundObj.contributions.push(contrib);
              voteResponses.push({ voter: voter.config.name, content: text.trim() });
              voterResults.push({ voter: voter.config.id, name: voter.config.name, content: text.trim().slice(0,200) });
              // O(1) increment instead of an O(N) weave scan (audit 11 PF5)
              stateManager.incrementParticipantContributions(voter.config.id);
              degrade("vote_response_db_failed", "Failed to persist vote_response — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, contrib, null), null);
              if (context.abort?.aborted || context.signal?.aborted) return;
              voter.status = previousStatus;
              try { db.setParticipantStatus(voter.config.id, previousStatus); } catch {}
            } catch (err) {
              if (context.abort?.aborted || context.signal?.aborted) return;
              voterResults.push({ voter: voter.config.id, error: err.message });
              voter.status = previousStatus;
              try { db.setParticipantStatus(voter.config.id, previousStatus); } catch {}
            }
          }));
          // Tally generation — source does not ballot, only voter responses counted
          const { lines: tallyLines } = sharedVoteTally.buildTally({
            question: args.question,
            sourceLetter: null,
            sourceLabel: caller?.config?.name ?? "source",
            responses: voteResponses,
          });
          const tallyContent = tallyLines.join("\n");
          const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, note: "Vote completed inline — invoker interprets tally (no persisted vote_tally row)." };
          return { output: JSON.stringify(payload), metadata: { inline: true, voteCount: voterResults.length }, title: `loom_vote:${voterResults.length} votes` };
        } catch (e) {
          const p = { error: `loom_vote inline failed: ${e.message}`, queued: true, question: args.question };
          return { output: JSON.stringify(p), metadata: { error: true, queued: true }, title: "loom_vote error" };
        }
      },
    }),

    loom_summon: tool({
      description: "Summon a guest expert persona for one additive contribution.",
      args: {
        persona_name: tool.schema.string().min(1).max(100).describe("Persona name to summon (e.g. 'Risk Officer')"),
        issue: tool.schema.string().min(1).max(500).describe("Issue to address (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_summon) return { output: JSON.stringify({ error: "loom_summon not enabled" }), metadata: { error: true }, title: "loom_summon error" };
        if (!context?.sessionID) return { output: JSON.stringify({ error: "loom_summon: session context unavailable" }), metadata: { error: true }, title: "loom_summon error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) {
            const p = { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — meeting not resolved." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_summon queued" };
          }
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine) {
            const p = { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — engine not ready." };
            return { output: JSON.stringify(p), metadata: { queued: true }, title: "loom_summon queued" };
          }
                    const allPersonas = getPersonas();
          let found = null;
          for (const tier of Object.keys(allPersonas)) {
            const m = allPersonas[tier].find(p => p.name.toLowerCase() === args.persona_name.toLowerCase());
            if (m) { found = { ...m, tier }; break; }
          }
          if (!found) return { output: JSON.stringify({ error: `Persona "${args.persona_name}" not found` }), metadata: { error: true }, title: "loom_summon error" };
          // Enforce summon caps from config (were dead theater before)
          try {
            const maxPerRound = config.getValue ? (config.getValue("maxSummonsPerRound") ?? config.getValue("tuning")?.MAX_SUMMONS_PER_ROUND ?? 2) : 2;
            const maxPerAgent = config.getValue ? (config.getValue("maxSummonsPerAgent") ?? config.getValue("tuning")?.MAX_SUMMONS_PER_AGENT ?? 1) : 1;
            // Support both flat and nested config shapes
            const cfgMaxRound = (typeof maxPerRound === "number" ? maxPerRound : (config.get?.()?.maxSummonsPerRound ?? 2));
            const cfgMaxAgent = (typeof maxPerAgent === "number" ? maxPerAgent : (config.get?.()?.maxSummonsPerAgent ?? 1));
            const curRound = (() => { try { return engine.getStateManager().getCurrentRound(); } catch { return 0; }})();
            const weaveForCap = (() => { try { return engine.getStateManager().getWeave() ?? []; } catch { return []; }})();
            const roundSummons = weaveForCap.filter(c => c.type === "summoned_response" && c.round === curRound).length;
            if (roundSummons >= cfgMaxRound) {
              return { output: JSON.stringify({ error: `Summon limit reached for round ${curRound} (${cfgMaxRound} per round) — try next round` }), metadata: { error: true }, title: "loom_summon error" };
            }
            let summonCallerForCap = null;
            try { summonCallerForCap = engine.getStateManager().getParticipants().find(p => p.session_id === context.sessionID) || engine.getStateManager().getParticipants().find(p => p?.status === "speaking") || null; } catch {}
            if (summonCallerForCap) {
              const agentSummons = weaveForCap.filter(c => c.type === "summoned_response" && c.round === curRound && c.prompt_context?.source_participant_id === summonCallerForCap.config.id).length;
              if (agentSummons >= cfgMaxAgent) {
                return { output: JSON.stringify({ error: `Summon limit reached for you this round (${cfgMaxAgent} per agent per round)` }), metadata: { error: true }, title: "loom_summon error" };
              }
            }
          } catch {}
          // Idempotent summon guard (retry-safe): reuse existing summoned_response for same batch+persona+issue
          try {
            const stateManagerPre = engine.getStateManager();
            const weavePre = stateManagerPre.getWeave ? stateManagerPre.getWeave() : [];
            const curRoundPre = stateManagerPre.getCurrentRound();
            const meetingIdPre = stateManagerPre.getState?.()?.id ?? meetingInfo.meetingId;
            const allPartsPre = stateManagerPre.getParticipants();
            let callerPre = allPartsPre.find(p => p.session_id === context.sessionID) || allPartsPre.find(p => p?.status === "speaking") || null;
            const fallbackPre = buildBatchId(meetingIdPre, curRoundPre, callerPre?.config?.id ?? null);
            const batchPre = callerPre?.currentBatchId ?? fallbackPre;
            const allBatchesPre = new Set([batchPre, fallbackPre]); for (const p of allPartsPre) { if (p?.currentBatchId) allBatchesPre.add(p.currentBatchId); allBatchesPre.add(buildBatchId(meetingIdPre, curRoundPre, p?.config?.id)); }
            const normIssue = (args.issue ?? "").trim().toLowerCase();
            const normPersona = (args.persona_name ?? "").trim().toLowerCase();
            let existingSummon = null;
            for (const bid of allBatchesPre) {
              existingSummon = weavePre.find(c => c.batch_id === bid && c.type === "summoned_response" && (c.prompt_context?.persona_name ?? "").trim().toLowerCase() === normPersona && (c.prompt_context?.issue ?? "").trim().toLowerCase() === normIssue);
              if (existingSummon) break;
            }
            if (!existingSummon) {
              existingSummon = weavePre.find(c => c.round === curRoundPre && c.type === "summoned_response" && c.prompt_context?.source_participant_id === callerPre?.config?.id && (c.prompt_context?.persona_name ?? "").trim().toLowerCase() === normPersona && (c.prompt_context?.issue ?? "").trim().toLowerCase() === normIssue);
            }
            if (existingSummon) {
              const rawSummon = (existingSummon.content ?? "").replace(/^\[Summoned:.+?\]\s*/m, "").trim();
              const payload = { inline: true, persona_name: args.persona_name, issue: args.issue, guest: found.name, content: rawSummon.slice(0,1200), note: "Summon reused — guest response already exists for this batch, returned inline.", reused: true };
              return { output: JSON.stringify(payload), metadata: { inline: true, guest: found.name, reused: true }, title: `loom_summon:${found.name} (reused)` };
            }
          } catch {}
          // For summon, we do inline prompt of the guest and return its content for immediate synthesis.
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
                    const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];
          const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
          let summonCaller = stateManager.getParticipants().find(p => p.session_id === context.sessionID) || null;
          if (!summonCaller) summonCaller = stateManager.getParticipants().find(p => p?.status === "speaking") || null;
          const summonCallerForPrompt = summonCaller ?? { config: { name: "Unknown", tier: "mid", id: "unknown" } };
          const prompt = buildSummonPrompt(found, summonCallerForPrompt, args.issue, roundContribs, stateManager.getCurrentRound(), stateManager.getMaxRounds(), stateOfPlay);
          const systemPrompt = `You are ${found.name} (${found.tier}) — guest expert summoned into Loom for one additive contribution. Be concise (100-150 words), grounded, in character. Build on what's settled; don't re-litigate without new evidence. Name one constraint only you would know. Cite Source: URL or [#id] if you use evidence. Never emit <<< or >>>. No contribution tags.`;
          // Use a temporary summoned participant config to create session
          const summonedConfig = { config: { id: `summoned_${found.name.toLowerCase().replace(/[^a-z0-9]/g,'_')}`, name: found.name, tier: found.tier, persona: found.persona, expertise: found.expertise, communication_style: found.communication_style }, tier_config: {} };
          // Reuse the caller's assigned model (left sidebar) — stays strictly within enabled allowlist
          let model = null;
          try { const participants = stateManager.getParticipants(); const caller = participants.find(p => p.session_id === context.sessionID) || participants[0]; model = engine.getParticipantModel ? engine.getParticipantModel(caller) : null; } catch {}
          if (!model) {
            // Borrow-any enabled model from any participant — never re-discovers outside the filtered pool
            try {
              for (const p of stateManager.getParticipants()) {
                if (!p || p.status === "failed") continue;
                const m = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(p) : null; } catch { return null; } })();
                if (m) { model = m; break; }
              }
            } catch {}
          }
          if (!model) return { output: JSON.stringify({ error: "No model available for summon — no enabled model assigned to any participant in this meeting" }), metadata: { error: true }, title: "loom_summon error" };
          // Shared ephemeral-prompt primitive (audit 10 MA1) — scoped permissions: only read/webfetch/websearch/loom_vector_search (no bash/glob/grep per guide: least privilege)
          const res = await sessionManager.runEphemeralPrompt(summonedConfig, {
            system: systemPrompt,
            model,
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
            timeoutMs: getConfig()?.tuning?.SUMMON_TIMEOUT_MS ?? TUNING.SUMMON_TIMEOUT_MS,
            signal: context.abort,
            abort: context.abort,
          }, meetingInfo.meetingId);
          if (!res.ok) return { output: JSON.stringify({ error: res.error?.message ?? "summon prompt failed" }), metadata: { error: true }, title: "loom_summon error" };
                    const { text, toolResults } = extractAgentResponse(res.data);
          const content = (text ?? "").slice(0,1200);
          // Store as summoned_response for timeline aesthetic (indented row)
          try {
            const stateManager2 = engine.getStateManager();
            const db2 = engine.getDatabase();
            const currentRound = stateManager2.getCurrentRound();
            let roundObj2 = null;
            try { const st = stateManager2.getState(); roundObj2 = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
            const allParts2 = stateManager2.getParticipants();
            let callerForBatch2 = allParts2.find(p => p.session_id === context.sessionID) || null;
            if (!callerForBatch2) callerForBatch2 = allParts2.find(p => p?.status === "speaking") || null;
            const fallbackBatch2 = `inline-${stateManager2.getState?.()?.id ?? meetingInfo.meetingId}-${stateManager2.getCurrentRound?.() ?? 0}-${summonCaller?.config?.id ?? "unknown"}`;
            const batchId2 = callerForBatch2?.currentBatchId ?? summonCaller?.currentBatchId ?? fallbackBatch2;
            const contributionTools2 = mapToolResults(toolResults);
            const contrib2 = {
              id: stateManager2.nextContributionId(),
              round: currentRound,
              participant_id: `summoned_${found.name.toLowerCase().replace(/[^a-z0-9]/g,'_')}`,
              content: `[Summoned: ${found.name} (${found.tier})]\n\n${content}`,
              type: "summoned_response",
              targets_which: null,
              batch_id: batchId2,
              tool_calls: contributionTools2 ?? [],
              prompt_context: {
                type: "summoned_response",
                persona_name: found.name,
                persona_tier: found.tier,
                issue: args.issue,
                round: currentRound,
                source_participant_id: summonCaller?.config?.id ?? callerForBatch2?.config?.id ?? null,
                source_batch_id: batchId2,
                system_prompt: systemPrompt,
                user_prompt: prompt,
                state_of_play: stateOfPlay,
                round_contributions_used: roundContribs.slice(-4).map(c => ({ id: c.id, participant_id: c.participant_id, type: c.type, content: (c.content ?? "").slice(0,300) })),
              },
              created_at: new Date().toISOString(),
            };
            stateManager2.addContribution(contrib2);
            if (roundObj2) roundObj2.contributions.push(contrib2);
            degrade("summon_db_failed", "Failed to persist summoned_response — visible in memory only this session", () => {
              // FK on contributions.participant_id (audit 12 PD9): summoned guests
              // need a participants row before their response can be persisted.
              db2.ensureParticipantRow?.(contrib2.participant_id, found.name, found.tier);
              db2.addContributionWithTurnRequest(stateManager2.getState().id, contrib2, null);
            }, null);
          } catch {}
          const payload = { inline: true, persona_name: args.persona_name, issue: args.issue, guest: found.name, content, note: "Inline summon — guest perspective returned for synthesis and stored as indented summoned_response row." };
          return { output: JSON.stringify(payload), metadata: { inline: true, guest: found.name }, title: `loom_summon:${found.name}` };
        } catch (e) {
          const p = { error: `loom_summon inline failed: ${e.message}`, queued: true, persona_name: args.persona_name, issue: args.issue };
          return { output: JSON.stringify(p), metadata: { error: true, queued: true }, title: "loom_summon error" };
        }
      },
    }),

  };
}
