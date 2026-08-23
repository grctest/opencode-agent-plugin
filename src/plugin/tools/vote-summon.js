import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { buildVotePrompt, buildSummonPrompt } from "../../prompts/interaction-prompts.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
import { getHighestTierModel } from "../../services/model-service.js";
import { degrade } from "../../utils/degrade.js";
import * as sharedVoteTally from "../../utils/vote-tally.js";

export function createVoteSummonTools({ config, resolveMeeting, activeLooms }) {
  return {
    loom_vote: tool({
      description: "Call a vote with a lettered question (e.g. 'A) ... B) ...'). All other active participants will vote.",
      args: {
        question: tool.schema.string().min(1).max(500).describe("Vote question with lettered options, e.g. 'A) yes B) no'"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_vote) return { error: "loom_vote not enabled" };
        if (!context?.sessionID) return { error: "loom_vote: session context unavailable" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, question: args.question, note: "Vote queued — meeting not resolved." };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) return { queued: true, question: args.question, note: "Vote queued — engine not ready." };
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const db = engine.getDatabase();
          if (!stateManager || !sessionManager || !db) return { queued: true, question: args.question, note: "Vote queued — state not ready." };
          const allParticipants = stateManager.getParticipants();
          if (!Array.isArray(allParticipants)) return { error: "loom_vote: participant list unavailable" };
          const caller = allParticipants.find(p => p?.session_id === context.sessionID) || null;
          const callerBatchId = caller?.currentBatchId ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
          const currentRound = stateManager.getCurrentRound();
          let roundObj = null;
          try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
          // Source contribution placeholder for vote context — use caller's current contribution or question
          const sourceSnippet = caller?.currentContribution ?? args.question.slice(0,300);
          // Voters = all other active participants excluding caller
          const voters = allParticipants.filter(p => (!caller || p.config.id !== caller.config.id) && p.status !== "failed" && p.status !== "passed" && p.status !== "muted");
          const extractVoteLetter = (text) => sharedVoteTally.extractVoteLetter(text);
          if (voters.length === 0) {
            const tallyContent = `[Vote Tally] ${args.question}\nSource vote: ${sourceSnippet.slice(0,200)}\nTotal voters: 1 (source only)`;
            try {
              const tallyContrib = {
                id: stateManager.nextContributionId(),
                round: currentRound,
                participant_id: caller?.config?.id ?? allParticipants[0]?.config?.id ?? "unknown",
                content: tallyContent,
                type: "vote_tally",
                targets_which: null,
                batch_id: callerBatchId,
                tool_calls: null,
                prompt_context: { type: "vote_tally", question: args.question, round: currentRound },
                created_at: new Date().toISOString(),
              };
              stateManager.addContribution(tallyContrib);
              if (roundObj) roundObj.contributions.push(tallyContrib);
              degrade("tally_db_failed", "Failed to persist vote_tally — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, tallyContrib, null), null);
              return { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: [], tallyId: tallyContrib.id, note: "Vote completed inline — source only." };
            } catch (e) {
              return { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: [], note: `Vote inline stored failed: ${e.message}` };
            }
          }
          // Parallel fan-out to voters
          const voteResponses = [];
          const voterResults = [];
          await Promise.allSettled(voters.map(async (voter) => {
            const model = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(voter) : null; } catch { return null; }})();
            if (!model) { voterResults.push({ voter: voter.config.name, error: "no model" }); return; }
            try {
              const previousStatus = voter.status;
              voter.status = "speaking";
              try { db.setParticipantStatus(voter.config.id, "speaking"); } catch {}
              const prompt = buildVotePrompt(
                caller ?? { config: { name: "Caller", tier: "mid", id: "caller" } },
                voter,
                sourceSnippet,
                args.question,
                stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= currentRound - 1).slice(-12) : [],
                currentRound,
                stateManager.getMaxRounds(),
                stateManager.getStateOfPlay?.() ?? ""
              );
              const systemPrompt = `You are ${voter.config.name} (${voter.config.tier}) — voting in Loom.\n\nChoose one letter (A/B/C…) as listed in the vote question. Format exactly:\n[Vote: X]\nOne sentence criterion (cost/risk/time/reversibility) reflecting your agenda. No contribution tags, 1-2 sentences total, in character.`;
              const promptContext = {
                type: "vote_response",
                system_prompt: systemPrompt,
                user_prompt: prompt,
                source_participant_id: caller?.config?.id ?? "caller",
                question: args.question,
                round: currentRound,
              };
              // Shared ephemeral-prompt primitive (audit 10 MA1)
              const res = await sessionManager.runEphemeralPrompt(voter, {
                system: systemPrompt,
                model,
                temperature: voter.tier_config?.temperature ?? 0.7,
                parts: [{ type: "text", text: prompt }],
                tools: {},
                toolChoice: "none",
                timeoutMs: 60000,
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
              voter.status = previousStatus;
              try { db.setParticipantStatus(voter.config.id, previousStatus); } catch {}
            } catch (err) {
              voterResults.push({ voter: voter.config.id, error: err.message });
              voter.status = "listening";
              try { db.setParticipantStatus(voter.config.id, "listening"); } catch {}
            }
          }));
          // Tally generation via shared builder (audit 16 MA2 — mirrors RoundExecutor.executeVote)
          const { lines: tallyLines, counts: voteCounts } = sharedVoteTally.buildTally({
            question: args.question,
            sourceLetter: extractVoteLetter(sourceSnippet),
            sourceLabel: caller?.config?.name ?? "source",
            responses: voteResponses,
          });
          const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            const [winner, count] = sorted[0];
            tallyLines.push(`Leading option: ${winner} (${count} votes)`);
          }
          const tallyContent = tallyLines.join("\n");
          const tallyContrib = {
            id: stateManager.nextContributionId(),
            round: currentRound,
            participant_id: caller?.config?.id ?? allParticipants[0]?.config?.id ?? "unknown",
            content: tallyContent,
            type: "vote_tally",
            targets_which: null,
            batch_id: callerBatchId,
            tool_calls: null,
            prompt_context: { type: "vote_tally", question: args.question, votes: voteResponses, round: currentRound },
            created_at: new Date().toISOString(),
          };
          stateManager.addContribution(tallyContrib);
          if (roundObj) roundObj.contributions.push(tallyContrib);
          degrade("tally_db_failed", "Failed to persist final vote_tally — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, tallyContrib, null), null);
          return { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, tallyId: tallyContrib.id, note: "Vote completed inline — tally and vote_response/tally rows stored, returned for same-turn synthesis." };
        } catch (e) {
          return { error: `loom_vote inline failed: ${e.message}`, queued: true, question: args.question };
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
        if (!cfg?.enabled || !cfg?.loom?.loom_summon) return { error: "loom_summon not enabled" };
        if (!context?.sessionID) return { error: "loom_summon: session context unavailable" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — meeting not resolved." };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine) return { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — engine not ready." };
                    const allPersonas = getPersonas();
          let found = null;
          for (const tier of Object.keys(allPersonas)) {
            const m = allPersonas[tier].find(p => p.name.toLowerCase() === args.persona_name.toLowerCase());
            if (m) { found = { ...m, tier }; break; }
          }
          if (!found) return { error: `Persona "${args.persona_name}" not found` };
          // For summon, we do inline prompt of the guest and return its content for immediate synthesis.
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
                    const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];
          const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
          const prompt = buildSummonPrompt(found, { config: { name: "Caller", tier: "mid", id: "caller" } }, args.issue, roundContribs, stateManager.getCurrentRound(), stateManager.getMaxRounds(), stateOfPlay);
          const systemPrompt = `You are ${found.name} (${found.tier}) — guest expert summoned into Loom for one additive contribution. Be concise (100-150 words), grounded, in character. Build on what's settled; don't re-litigate without new evidence. Name one constraint only you would know. Cite Source: URL or [#id] if you use evidence. Never emit <<< or >>>. No contribution tags.`;
          // Use a temporary summoned participant config to create session
          const summonedConfig = { config: { id: `summoned_${found.name.toLowerCase().replace(/[^a-z0-9]/g,'_')}`, name: found.name, tier: found.tier, persona: found.persona, expertise: found.expertise, communication_style: found.communication_style }, tier_config: { temperature: 0.7 } };
          // Try to get a model — use caller's model or fallback
          let model = null;
          try { const participants = stateManager.getParticipants(); const caller = participants.find(p => p.session_id === context.sessionID) || participants[0]; model = engine.getParticipantModel ? engine.getParticipantModel(caller) : null; } catch {}
          if (!model) {
            try { const ms = stateManager.getParticipants().map(p=>({tier:p.config.tier, model:p.config.model})); model = getHighestTierModel(ms.map(m=>({tier:m.tier, model:m.model}))); } catch {}
          }
          if (!model) return { error: "No model available for summon" };
          // Shared ephemeral-prompt primitive (audit 10 MA1)
          const res = await sessionManager.runEphemeralPrompt(summonedConfig, {
            system: systemPrompt,
            model,
            temperature: 0.7,
            parts: [{ type: "text", text: prompt }],
            tools: (() => {
              const t = config.getValue("agentTools");
              const m = {};
              if (t?.builtIn?.webfetch || t?.builtIn?.web_fetch) m.webfetch = true;
              if (t?.builtIn?.websearch || t?.builtIn?.web_search) m.websearch = true;
              if (t?.builtIn?.read) m.read = true;
              if (t?.builtIn?.bash?.enabled) m.bash = true;
              if (t?.builtIn?.glob) m.glob = true;
              if (t?.builtIn?.grep) m.grep = true;
              if (t?.loom?.loom_vector_search) m.loom_vector_search = true;
              return m;
            })(),
            toolChoice: "auto",
            timeoutMs: 90000,
          }, meetingInfo.meetingId);
          if (!res.ok) return { error: res.error?.message ?? "summon prompt failed" };
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
            const callerForBatch2 = allParts2.find(p => p.session_id === context.sessionID) || null;
            const batchId2 = callerForBatch2?.currentBatchId ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
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
              prompt_context: { type: "summoned_response", persona_name: found.name, persona_tier: found.tier, issue: args.issue, round: currentRound },
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
          return { inline: true, persona_name: args.persona_name, issue: args.issue, guest: found.name, content, note: "Inline summon — guest perspective returned for synthesis and stored as indented summoned_response row." };
        } catch (e) {
          return { error: `loom_summon inline failed: ${e.message}`, queued: true, persona_name: args.persona_name, issue: args.issue };
        }
      },
    }),

  };
}
