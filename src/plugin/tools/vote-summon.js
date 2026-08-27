import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { buildVotePrompt, buildSummonPrompt } from "../../prompts/interaction-prompts.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
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
          let caller = allParticipants.find(p => p?.session_id === context.sessionID) || null;
          // Robust fallback: speaking participant is the caller when session_id mismatches
          if (!caller) caller = allParticipants.find(p => p?.status === "speaking") || null;
          if (!caller) {
            try {
              const weave = stateManager.getWeave?.() ?? [];
              const roundWeave = weave.filter(c => c.round === stateManager.getCurrentRound());
              if (roundWeave.length > 0) {
                const lastId = roundWeave[roundWeave.length - 1].participant_id;
                caller = allParticipants.find(p => p.config.id === lastId) || null;
              }
            } catch {}
          }
          if (!caller) caller = allParticipants.find(p => p?.status !== "failed" && p?.status !== "passed" && p?.status !== "muted") || null;
          const fallbackBatch = `inline-${stateManager.getState?.()?.id ?? meetingInfo.meetingId}-${stateManager.getCurrentRound?.() ?? 0}-${caller?.config?.id ?? "unknown"}`;
          const callerBatchId = caller?.currentBatchId ?? fallbackBatch;
          const currentRound = stateManager.getCurrentRound();
          let roundObj = null;
          try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
          // Source contribution placeholder for vote context — use caller's current contribution or question
          const sourceSnippet = caller?.currentContribution ?? args.question.slice(0,300);
          // Voters = all other active participants excluding caller
          const voters = allParticipants.filter(p => (!caller || p.config.id !== caller.config.id) && p.status !== "failed" && p.status !== "passed" && p.status !== "muted");
          const extractVoteLetter = (text) => sharedVoteTally.extractVoteLetter(text);
          // Idempotent per-question guard: if this batch already polled this exact question (retry or duplicate tool call), reuse existing rows
          try {
            const weave = stateManager.getWeave ? stateManager.getWeave() : [];
            const existingTally = weave.find(c => c.batch_id === callerBatchId && c.type === "vote_tally" && c.prompt_context?.question === args.question);
            if (existingTally) {
              const existingVotes = weave.filter(c => c.batch_id === callerBatchId && c.type === "vote_response" && c.prompt_context?.question === args.question);
              const tallyContent = existingTally.content;
              const voterResults = existingVotes.map(v => {
                const raw = (v.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                return { voter: v.participant_id, name: v.content.match(/\[Vote from (.+?)\]/)?.[1] ?? v.participant_id, content: raw.slice(0,200) };
              });
              const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, tallyId: existingTally.id, note: "Vote reused — identical poll already exists for this batch (duplicate tool call suppressed)." };
              return { output: JSON.stringify(payload), metadata: { inline: true, voteCount: voterResults.length, reused: true }, title: `loom_vote:${voterResults.length} votes (cached)` };
            }
            const existingVotesForQuestion = weave.filter(c => c.batch_id === callerBatchId && c.type === "vote_response" && c.prompt_context?.question === args.question);
            if (existingVotesForQuestion.length > 0) {
              // Partial poll already exists (retry after timeout left votes but no tally) — reuse them and build tally
              const voteResponses = existingVotesForQuestion.map(v => {
                const raw = (v.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                const name = v.content.match(/\[Vote from (.+?)\]/)?.[1] ?? v.participant_id;
                return { voter: name, content: raw };
              });
              const { lines: tallyLines } = sharedVoteTally.buildTally({
                question: args.question,
                sourceLetter: extractVoteLetter(sourceSnippet),
                sourceLabel: caller?.config?.name ?? "source",
                responses: voteResponses,
              });
              const tallyContent = tallyLines.join("\n");
              const voterResults = existingVotesForQuestion.map(v => {
                const raw = (v.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                return { voter: v.participant_id, name: v.content.match(/\[Vote from (.+?)\]/)?.[1] ?? v.participant_id, content: raw.slice(0,200) };
              });
              // Find or create tally for these votes (reuse if not yet created)
              let tallyId = existingTally?.id ?? `reused-${Date.now()}`;
              const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, tallyId, note: "Vote reused — partial poll already exists for this batch, tally rebuilt." };
              return { output: JSON.stringify(payload), metadata: { inline: true, voteCount: voterResults.length, reused: true }, title: `loom_vote:${voterResults.length} votes (reused)` };
            }
          } catch {}
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
              const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: [], tallyId: tallyContrib.id, note: "Vote completed inline — source only." };
              return { output: JSON.stringify(payload), metadata: { inline: true }, title: "loom_vote:source only" };
            } catch (e) {
              const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: [], note: `Vote inline stored failed: ${e.message}` };
              return { output: JSON.stringify(payload), metadata: { inline: true, error: true }, title: "loom_vote error" };
            }
          }
          // Parallel fan-out to voters
          const voteResponses = [];
          const voterResults = [];
          // Idempotency: if this batch already has a vote from this voter, reuse it (retry guard)
          const isRetryDuplicate = () => {
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              return weave.some(c => c.batch_id === callerBatchId && c.type === "vote_response" && c.participant_id === voter.config?.id);
            } catch { return false; }
          };
          // Pre-check before model fetch to avoid duplicate fan-out on retry
          const existingVoteContribs = (() => {
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              return weave.filter(c => c.batch_id === callerBatchId && c.type === "vote_response");
            } catch { return []; }
          })();
          // If we already have votes for this batch (retry after timeout), skip fresh fan-out and reuse
          // This check is per-voter below; for whole batch we still need to collect existing
          await Promise.allSettled(voters.map(async (voter) => {
            // Idempotent skip: reuse existing vote for this batch+voter instead of re-prompting
            try {
              const weave = stateManager.getWeave ? stateManager.getWeave() : [];
              const existing = weave.find(c => c.batch_id === callerBatchId && c.type === "vote_response" && c.participant_id === voter.config.id);
              if (existing) {
                const raw = (existing.content ?? "").replace(/^\[Vote from .+?\]\s*/m, "").trim();
                voteResponses.push({ voter: voter.config.name, content: raw });
                voterResults.push({ voter: voter.config.id, name: voter.config.name, content: raw.slice(0,200) });
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
            try {
              const previousStatus = voter.status;
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
                temperature: voter.tier_config?.temperature ?? 0.7,
                parts: [{ type: "text", text: prompt }],
                tools: {},
                timeoutMs: 60000,
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
          // Idempotent tally: reuse existing tally for this batch if present (retry)
          let tallyContrib = null;
          try {
            const weave = stateManager.getWeave ? stateManager.getWeave() : [];
            const existingTally = weave.find(c => c.batch_id === callerBatchId && c.type === "vote_tally");
            if (existingTally) {
              tallyContrib = existingTally;
            }
          } catch {}
          if (!tallyContrib) {
            tallyContrib = {
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
          }
          const payload = { inline: true, question: args.question, tally: tallyContent.slice(0,800), votes: voterResults, tallyId: tallyContrib.id, note: "Vote completed inline — tally and vote_response/tally rows stored, returned for same-turn synthesis." };
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
          const summonedConfig = { config: { id: `summoned_${found.name.toLowerCase().replace(/[^a-z0-9]/g,'_')}`, name: found.name, tier: found.tier, persona: found.persona, expertise: found.expertise, communication_style: found.communication_style }, tier_config: { temperature: 0.7 } };
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
            temperature: 0.7,
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
            timeoutMs: 90000,
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
