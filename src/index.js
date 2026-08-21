import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isAgentSessionClient } from "./client-types.js";
import { deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId, getDbPathForMeeting, getDatabasesBySessionId, loadSessionIndex, MeetingDatabase } from "./database.js";
import { startDashboard } from "./dashboard/server.js";
import { createKnitHandler } from "./handlers/knit-handler.js";
import { createConfig, getConfigSource, setDefaultConfigDirectory } from "./config.js";
import { Logger } from "./logger.js";
import { VectorIndex } from "./services/vector-index.js";
import { resolveLoomBaseDir } from "./paths.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "./services/model-manager.js";
import { buildQueryPrompt, buildEvidencePrompt, buildVotePrompt, buildSummonPrompt } from "./prompts.js";
import * as sharedVoteTally from "./utils/vote-tally.js";
import { degrade } from "./utils/degrade.js";

const PROGRESS_PATTERN =
  /^🎬|^⚠️|^ℹ️|is thinking\.\.\.|— synthesize:|— critique:|Round \d+ (complete|starting)|Synthesizing final output|✅ Completed|❌ Error:/;

export const Loom = async (input) => {
  const { client, directory } = input;

  if (!isAgentSessionClient(client)) {
    throw new Error("Loom plugin requires a compatible opencode client with session.create, session.prompt, session.message, and provider API access.");
  }

  setDefaultConfigDirectory(directory);
  const config = createConfig(directory);
  loadSessionIndex(directory);
  const logger = new Logger();

  const configSource = getConfigSource();
  logger.info(
    "config",
    configSource
      ? `Loom config loaded from ${configSource}`
      : "No Loom config file found — using defaults",
  );

  const warnings = config.getWarnings();
  for (const warning of warnings) {
    logger.warn("config_validation", warning);
  }

  // Initialize the real embedding model in the plugin process so every
  // semantic feature (vector search, reflection targeting, room composition)
  // uses real embeddings rather than placeholder noise. This mirrors the
  // dashboard's initEmbeddingModel(), which previously was the only place the
  // model got loaded. Failures are non-fatal: semantic features degrade visibly.
  // Single config-driven startup (audit 06 V4): honor the configured model here,
  // once — orchestrator consumes whatever this loads.
  const startupConfig = createConfig().get();
  const resolvedModel = startupConfig.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const resolvedQuant = startupConfig.embeddingQuant ?? DEFAULT_EMBEDDING_QUANT;
  const { ensureEmbedderInitialized, getEmbeddingDim } = await import("./services/embedding-service.js");
  ensureEmbedderInitialized(resolvedModel, resolvedQuant)
    .then(() => {
      logger.info("embedder_initialized", `Embedding model loaded: ${resolvedModel} (${getEmbeddingDim()}d)`);
    })
    .catch((err) => {
      logger.warn(
        "embedder_init_failed",
        `Failed to initialize embedding model — semantic features (vector search, reflection targeting, room composition) will be unavailable: ${err.message}`,
      );
    });

  const activeLooms = new Map();
  let activeDashboard = null;
  const meetingResolveCache = new Map(); // sessionID -> { meeting, at }
  const RESOLVE_CACHE_TTL_MS = 30000;
  const RESOLVE_CACHE_MAX = 100;

  /**
   * Resolves an ephemeral session ID to its Loom meeting database path.
   * Used by agent tools to find which meeting the current session belongs to.
   * Cached to avoid readdirSync scan per tool call.
   */
  async function resolveMeeting(sessionID) {
    const cached = meetingResolveCache.get(sessionID);
    if (cached && (Date.now() - cached.at) < RESOLVE_CACHE_TTL_MS) {
      return cached.meeting;
    }
    // Rate-limit: if same sessionID requested >10 times/sec, return cached even if expired
    // (simple: if cached exists within 1s, reuse)
    if (cached && (Date.now() - cached.at) < 1000) {
      return cached.meeting;
    }
    // 1. Direct session → meeting lookup via DB index
    const meeting = await findMeetingBySessionId(directory, sessionID);
    if (meeting) {
      if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
        const oldest = meetingResolveCache.keys().next().value;
        meetingResolveCache.delete(oldest);
      }
      meetingResolveCache.set(sessionID, { meeting, at: Date.now() });
      return meeting;
    }

    // 2. Fallback: walk up to parent session
    try {
      const sessionResult = await client.session.get({
        path: { id: sessionID },
        query: { directory },
      });
      const parentID = sessionResult?.data?.parentID;
      if (parentID && parentID !== sessionID) {
        const parentMeeting = await findMeetingBySessionId(directory, parentID);
        if (parentMeeting) {
          if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
            const oldest = meetingResolveCache.keys().next().value;
            meetingResolveCache.delete(oldest);
          }
          meetingResolveCache.set(sessionID, { meeting: parentMeeting, at: Date.now() });
          return parentMeeting;
        }
      }
    } catch {
      // Session may not exist or API may not support .get()
    }
    return null;
  }

  // Agent tools that are available to deliberation agents during rounds
  const agentTools = {
    loom_vector_search: tool({
      description:
        "Semantic search against prior deliberation context. " +
        "Find exact wording of earlier disagreements, review a specific participant's past contributions, or dig into a sub-topic.",
      args: {
        query: tool.schema
          .string()
          .describe("Search query text for vector similarity search"),
        top_k: tool.schema
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Maximum results (default 5, max 20)"),
        exclude_round: tool.schema
          .number()
          .int()
          .optional()
          .describe("Exclude chunks from this round"),
      },
      async execute(args, context) {
        const agentToolsConfig = config.getValue("agentTools");
        if (!agentToolsConfig?.enabled || !agentToolsConfig?.loom?.loom_vector_search) {
          return { error: "Vector search is not enabled in configuration" };
        }

        // 1. Resolve session → meeting
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { error: "Could not resolve meeting for this session" };
        }

        // 2. Open DB and vector index
        const db = await MeetingDatabase.create(meetingInfo.dbPath, meetingInfo.meetingId);
        const vectorIndex = new VectorIndex(db);

        try {
          // 3. Execute search
          const topK = Math.min(args.top_k || 5, 10);
          const results = await vectorIndex.retrieveRelevant(args.query, topK, args.exclude_round);

          // Format results with participation tags
          const formattedResults = results.map((r) => ({
            round: r.round,
            source: r.source,
            distance: r.distance,
            content: r.content,
            participation_tags: [],
          }));

          return { results: formattedResults, truncated: false };
        } finally {
          db.close();
        }
      },
    }),
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
          const targets = args.targets.map(id => allParticipants.find(p => p.config.id === id)).filter(p => p && p.status !== "failed" && p.status !== "passed");
          if (targets.length === 0) return { error: `No eligible targets among [${args.targets.join(", ")}] — all filtered (self/failed/passed).` };
          const caller = allParticipants.find(p => p.session_id === context.sessionID) || allParticipants.find(p => p.config.id && args.targets.includes(p.config.id) === false) || null;
          // Use a lightweight inline prompt for each target (without creating DB rows yet — let RoundExecutor create them post-store, but return preview)
          // For true inline, we prompt here and return the answers directly.
          const results = [];
          for (const target of targets) {
            try {
              const model = (() => {
                try { return engine.getParticipantModel ? engine.getParticipantModel(target) : null; } catch { return null; }
              })();
              if (!model) { results.push({ participantId: target.config.id, error: "no model" }); continue; }
              const sessionId = await sessionManager.createEphemeralSession(target);
              sessionManager.registerSessionMeeting(sessionId, meetingInfo.meetingId);
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
              const res = await sessionManager.getContract().prompt({
                sessionId,
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
              });
              sessionManager.unregisterSession(sessionId);
              await sessionManager.deleteEphemeralSession(sessionId).catch(()=>{});
              if (!res.ok) { results.push({ participantId: target.config.id, error: res.error?.message ?? "prompt failed" }); continue; }
              const { extractAgentResponse, mapToolResults } = await import("./shared.js");
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
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, targets: args.targets, question: args.question, note: "Evidence queued — meeting not resolved." };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine || !engine.getStateManager) return { queued: true, targets: args.targets, question: args.question, note: "Evidence queued — engine not ready." };
          const stateManager = engine.getStateManager();
          const sessionManager = engine.getSessionManager();
          const allParticipants = stateManager.getParticipants();
          const targets = args.targets.map(id => allParticipants.find(p => p.config.id === id)).filter(p => p && p.status !== "failed" && p.status !== "passed");
          if (targets.length === 0) return { error: `No eligible targets among [${args.targets.join(", ")}]` };
          const results = [];
          for (const target of targets) {
            try {
              const model = (() => { try { return engine.getParticipantModel ? engine.getParticipantModel(target) : null; } catch { return null; } })();
              if (!model) { results.push({ participantId: target.config.id, error: "no model" }); continue; }
              const sessionId = await sessionManager.createEphemeralSession(target);
              sessionManager.registerSessionMeeting(sessionId, meetingInfo.meetingId);
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
              const res = await sessionManager.getContract().prompt({
                sessionId,
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
              });
              sessionManager.unregisterSession(sessionId);
              await sessionManager.deleteEphemeralSession(sessionId).catch(()=>{});
              if (!res.ok) { results.push({ participantId: target.config.id, error: res.error?.message ?? "prompt failed" }); continue; }
              const { extractAgentResponse, mapToolResults } = await import("./shared.js");
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
    loom_vote: tool({
      description: "Call a vote with a lettered question (e.g. 'A) ... B) ...'). All other active participants will vote.",
      args: {
        question: tool.schema.string().min(1).max(500).describe("Vote question with lettered options, e.g. 'A) yes B) no'"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_vote) return { error: "loom_vote not enabled" };
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
          const caller = allParticipants.find(p => p.session_id === context.sessionID) || null;
          const callerBatchId = caller?.currentBatchId ?? `inline-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
          const currentRound = stateManager.getCurrentRound();
          let roundObj = null;
          try { const st = stateManager.getState(); roundObj = (st.rounds || []).find(r => r.number === currentRound) || null; } catch {}
          // Source contribution placeholder for vote context — use caller's current contribution or question
          const sourceSnippet = caller?.currentContribution ?? args.question.slice(0,300);
          // Voters = all other active participants excluding caller
          const voters = allParticipants.filter(p => (!caller || p.config.id !== caller.config.id) && p.status !== "failed" && p.status !== "passed");
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
            const sessionId = await sessionManager.createEphemeralSession(voter);
            sessionManager.registerSessionMeeting(sessionId, meetingInfo.meetingId);
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
              const res = await sessionManager.getContract().prompt({
                sessionId,
                system: systemPrompt,
                model,
                temperature: voter.tier_config?.temperature ?? 0.7,
                parts: [{ type: "text", text: prompt }],
                tools: {},
                toolChoice: "none",
                timeoutMs: 60000,
              });
              if (!res.ok) throw res.error;
              const { extractAgentResponse } = await import("./shared.js");
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
              voter.contributions_count = stateManager.getWeave().filter((c) => c.participant_id === voter.config.id).length;
              degrade("vote_response_db_failed", "Failed to persist vote_response — visible in memory only this session", () => db.addContributionWithTurnRequest(stateManager.getState().id, contrib, null), null);
              voter.status = previousStatus;
              try { db.setParticipantStatus(voter.config.id, previousStatus); } catch {}
            } catch (err) {
              voterResults.push({ voter: voter.config.id, error: err.message });
              voter.status = "listening";
              try { db.setParticipantStatus(voter.config.id, "listening"); } catch {}
            } finally {
              try { sessionManager.unregisterSession(sessionId); } catch {}
              await sessionManager.deleteEphemeralSession(sessionId).catch(()=>{});
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
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo) return { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — meeting not resolved." };
          const engine = activeLooms.get(meetingInfo.meetingId);
          if (!engine) return { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon queued — engine not ready." };
          const { getPersonas } = await import("./composer.js");
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
          const { buildSummonPrompt } = await import("./prompts.js");
          const roundContribs = stateManager.getWeave ? stateManager.getWeave().filter(c => c.round != null && c.round >= stateManager.getCurrentRound() - 1).slice(-12) : [];
          const stateOfPlay = stateManager.getStateOfPlay?.() ?? "";
          const prompt = buildSummonPrompt(found, { config: { name: "Caller", tier: "mid", id: "caller" } }, args.issue, roundContribs, stateManager.getCurrentRound(), stateManager.getMaxRounds(), stateOfPlay);
          const systemPrompt = `You are ${found.name} (${found.tier}) — guest expert summoned into Loom for one additive contribution. Be concise (100-150 words), grounded, in character. Build on what's settled; don't re-litigate without new evidence. Name one constraint only you would know. Cite Source: URL or [#id] if you use evidence. Never emit <<< or >>>. No contribution tags.`;
          // Use a temporary summoned participant config to create session
          const summonedConfig = { config: { id: `summoned_${found.name.toLowerCase().replace(/[^a-z0-9]/g,'_')}`, name: found.name, tier: found.tier, persona: found.persona, expertise: found.expertise, communication_style: found.communication_style }, tier_config: { temperature: 0.7 } };
          const sessionId = await sessionManager.createEphemeralSession(summonedConfig);
          sessionManager.registerSessionMeeting(sessionId, meetingInfo.meetingId);
          // Try to get a model — use caller's model or fallback
          let model = null;
          try { const participants = stateManager.getParticipants(); const caller = participants.find(p => p.session_id === context.sessionID) || participants[0]; model = engine.getParticipantModel ? engine.getParticipantModel(caller) : null; } catch {}
          if (!model) {
            try { const { getHighestTierModel } = await import("./services/model-service.js"); const ms = stateManager.getParticipants().map(p=>({tier:p.config.tier, model:p.config.model})); model = getHighestTierModel(ms.map(m=>({tier:m.tier, model:m.model}))); } catch {}
          }
          if (!model) { await sessionManager.deleteEphemeralSession(sessionId).catch(()=>{}); return { error: "No model available for summon" }; }
          const res = await sessionManager.getContract().prompt({
            sessionId,
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
          });
          await sessionManager.deleteEphemeralSession(sessionId).catch(()=>{});
          sessionManager.unregisterSession(sessionId);
          if (!res.ok) return { error: res.error?.message ?? "summon prompt failed" };
          const { extractAgentResponse, mapToolResults } = await import("./shared.js");
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
            degrade("summon_db_failed", "Failed to persist summoned_response — visible in memory only this session", () => db2.addContributionWithTurnRequest(stateManager2.getState().id, contrib2, null), null);
          } catch {}
          return { inline: true, persona_name: args.persona_name, issue: args.issue, guest: found.name, content, note: "Inline summon — guest perspective returned for synthesis and stored as indented summoned_response row." };
        } catch (e) {
          return { error: `loom_summon inline failed: ${e.message}`, queued: true, persona_name: args.persona_name, issue: args.issue };
        }
      },
    }),
    loom_request_next: tool({
      description: "Request to speak next round with priority and reason.",
      args: {
        priority: tool.schema.number().int().min(1).max(10).describe("Priority 1-10 (capped by tier)"),
        reason: tool.schema.string().min(1).max(200).describe("Reason for turn request (quoted)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_request_next) return { error: "loom_request_next not enabled" };
        return { queued: true, priority: Math.min(10, Math.max(1, args.priority)), reason: args.reason, note: "Turn request queued — will be considered for next round order." };
      },
    }),
  };

  const markActiveMeetingsAborted = () => {
    for (const [id, engine] of activeLooms) {
      try {
        const state = engine.getState();
        if (state.status !== "converged" && state.status !== "cancelled" &&
            state.status !== "timeout" && state.status !== "max_rounds_reached" &&
            state.status !== "aborted" && state.status !== "deadlocked") {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
  };

  // Async abort — SIGINT/SIGTERM can briefly await before exit so
  // any in-flight persistState() has a grace window to complete (audit 05 LS8).
  // The sync "exit" handler below is intentionally minimal: async work cannot
  // complete there, so it only does best-effort flag setting.
  const markActiveMeetingsAbortedAsync = async () => {
    for (const [id, engine] of activeLooms) {
      try {
        const state = engine.getState();
        if (state.status !== "converged" && state.status !== "cancelled" &&
            state.status !== "timeout" && state.status !== "max_rounds_reached" &&
            state.status !== "aborted" && state.status !== "deadlocked") {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
    // Grace window for in-flight DB writes to settle
    await new Promise((r) => setTimeout(r, 500));
  };

  const originalExit = process.exit.bind(process);
  const wrappedExit = (code) => {
    markActiveMeetingsAborted();
    return originalExit(code);
  };

  // "exit" is synchronous — async DB ops cannot complete here (audit 05 LS8).
  // Keep it as a no-op flag setter; real persistence happens in SIGINT/SIGTERM.
  process.on("exit", () => {
    try { markActiveMeetingsAborted(); } catch {}
  });
  process.on("SIGINT", async () => {
    await markActiveMeetingsAbortedAsync();
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    await markActiveMeetingsAbortedAsync();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", "Uncaught exception — aborting active meetings", { message: err.message, stack: err.stack });
    markActiveMeetingsAborted();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", "Unhandled rejection — aborting active meetings", { reason: String(reason) });
    markActiveMeetingsAborted();
    process.exit(1);
  });

  const { handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels } = createKnitHandler(client, directory, activeLooms, agentTools);

  return {
    tool: {
      knit: tool({
        description:
          "Start a multi-agent deliberation session (a 'Loom'). " +
          "ONLY invoke when the user explicitly types /knit followed by a question. " +
          "Do NOT invoke for general questions, discussions, or information requests. " +
          "Run the deliberation directly — do NOT call with dry_run first unless the user explicitly asks for a preview.",
        args: {
          question: tool.schema
            .string()
            .describe("The question or task for the agents to deliberate on"),
          context: tool.schema
            .string()
            .optional()
            .describe(
              "Additional context, background files, or constraints the agents should consider",
            ),
          participants: tool.schema
            .array(
              tool.schema.object({
                name: tool.schema.string().describe("Display name for this participant"),
                persona: tool.schema
                  .string()
                  .describe("Who this agent is — their role and personality"),
                agenda: tool.schema
                  .string()
                  .describe(
                    "What this agent wants to achieve in the deliberation",
                  ),
                tier: tool.schema
                  .string()
                  .describe(
                    "Role name (e.g. junior, mid, senior, principal). Determines behavior and rights.",
                  ),
              }),
            )
            .optional()
            .describe(
              "Custom participant list. If omitted, auto-composed from the question.",
            ),
          max_rounds: tool.schema
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "Maximum deliberation rounds (default: 3)",
            ),
          dry_run: tool.schema
            .boolean()
            .optional()
            .describe(
              "Only set true if the user explicitly asked to preview the room before deliberating. Default: false — run directly.",
            ),
          models: tool.schema
            .array(
              tool.schema.object({
                tier: tool.schema.enum(["junior", "mid", "senior", "principal"]),
                provider_id: tool.schema.string().describe("Provider ID for this tier"),
                model_id: tool.schema.string().describe("Model ID for this tier"),
              }),
            )
            .optional()
            .describe(
              "Model assignments per tier. Use list_knit_models to discover available options.",
            ),
          meeting_timeout: tool.schema
            .number()
            .int()
            .min(60000)
            .max(1800000)
            .optional()
            .describe("Maximum meeting duration in ms. Default: 900000 (15 min)"),
          fresh: tool.schema
            .boolean()
            .optional()
            .describe("Force a fresh loom even if a previous meeting exists. Default: false"),
        },
        execute: handleKnit,
      }),

      loom_status: tool({
        description:
          "Check the status of a running Loom deliberation session. " +
          "Internal tool for agents to monitor progress. Not a user command.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to check (loom_id or meeting_id, both work)"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (engine) {
            const state = engine.getState();
            return `**Loom Status:** ${state.status}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Contributions:** ${state.weave.length}\n**Meeting ID:** ${engine.getMeetingId()}`;
          }
          // Fallback: completed loom — try DB by meetingId
          try {
            const { getMeetingDbPath } = await import("./paths.js");
            const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
              const { DashboardApi } = await import("./dashboard/api.js");
              const api = DashboardApi.get(dbPath);
              const state = api.getState();
              if (state) {
                return `**Loom Status (completed):** ${state.status}\n**Round:** ${state.round}/${state.max_rounds}\n**Meeting ID:** ${args.loom_id} (from DB)`;
              }
            }
          } catch {}
          return "No active Loom found with that ID.";
        },
      }),

      loom_cancel: tool({
        description: "Cancel a running Loom deliberation session.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to cancel (loom_id or meeting_id)"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID.";
          }
          engine.cancel();
          return "Loom cancellation requested. The current round will complete, then synthesis will run.";
        },
      }),

      loom_viz: tool({
        description:
          "Start the Loom deliberation dashboard server. " +
          "Provides a web UI to visualize deliberation progress in real-time. " +
          "The dashboard watches for new meetings and auto-switches to the most recent one.",
        args: {
          port: tool
            .schema
            .number()
            .int()
            .min(1024)
            .max(65535)
            .optional()
            .describe("Port number for the dashboard server. Default: 3210"),
        },
        execute: async (args, context) => {
          const port = args.port ?? 3210;

          if (activeDashboard) {
            return [
              "Dashboard already running!",
              `Open: http://localhost:${activeDashboard.port}`,
              "Run /loom_stop to stop the current dashboard first.",
            ].join("\n");
          }

          try {
            const dashboard = startDashboard(directory, port);
            activeDashboard = dashboard;
            return [
              "Dashboard started!",
              "",
              "Open in browser:",
              `http://localhost:${dashboard.port}`,
              "",
              "The dashboard auto-detects new meetings and refreshes in real-time.",
              "Run /loom_stop when done to free the port.",
            ].join("\n");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to start dashboard: ${message}`;
          }
        },
      }),

      loom_stop: tool({
        description: "Stop the running Loom dashboard server and free the port.",
        args: {},
        execute: async () => {
          if (!activeDashboard) {
            return "No dashboard is currently running.";
          }
          const port = activeDashboard.port;
          activeDashboard.stop();
          activeDashboard = null;
          return `Dashboard stopped (was running on port ${port}).`;
        },
      }),

      loom_debug: tool({
        description: "Inspect internal state of a running or completed loom for debugging.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to inspect (loom_id or meeting_id)"),
          include: tool.schema
            .array(tool.schema.enum(['state', 'participants', 'contributions', 'rounds', 'fabric', 'orchestratorMessages', 'config']))
            .optional()
            .describe("Which parts of the loom state to include (default: all — include 'config' for resolved config + warnings)"),
        },
        execute: async (args, _context) => {
          const include = args.include || ['state', 'participants', 'contributions', 'rounds', 'fabric', 'orchestratorMessages'];
          const engine = activeLooms.get(args.loom_id);
          if (engine) {
            const state = engine.getState();
            const result = {};
            if (include.includes('state')) {
              result.status = state.status;
              result.round = state.current_round;
              result.maxRounds = state.max_rounds;
              result.tags = state.tags;
              result.question = state.question;
              result.context = state.context;
            }
            if (include.includes('participants')) {
              result.participants = state.participants.map(p => ({
                id: p.config.id,
                name: p.config.name,
                tier: p.config.tier,
                status: p.status,
                contributions: p.contributions_count,
                has_reflection: !!p.reflection,
                model: p.config.model ? `${p.config.model.providerID}/${p.config.model.modelID}` : 'unassigned',
              }));
            }
            if (include.includes('contributions')) {
              result.contributions = state.weave.map(c => ({
                id: c.id,
                round: c.round,
                participantId: c.participant_id,
                type: c.type,
                contentPreview: c.content.slice(0, 2000),
                tool_calls: c.tool_calls ?? null,
                prompt_context_hash: c.prompt_context ? String(JSON.stringify(c.prompt_context).length) : null,
                timestamp: new Date(c.created_at ?? c.timestamp).toISOString(),
              }));
            }
            if (include.includes('rounds')) {
              result.rounds = state.rounds.map(r => ({
                number: r.number,
                contributionCount: r.contributions.length,
                turnRequestCount: r.turn_requests.length,
                summary: r.summary,
              }));
            }
            if (include.includes('fabric')) {
              result.fabric = state.fabric;
            }
            if (include.includes('orchestratorMessages')) {
              result.orchestratorMessages = engine.getOrchestratorMessages().map(m => ({
                type: m.type,
                role: m.role,
                contentPreview: m.content.slice(0, 2000),
                timestamp: new Date(m.timestamp).toISOString(),
              }));
            }
            if (include.includes('config')) {
              try {
                const cfg = config.get();
                const warnings = config.getWarnings();
                const source = config.getSource();
                result.config = { values: cfg, warnings, source, dormantNote: "maxTurnRequestsPerRound was removed from the schema (never enforced — ordering is planTurnOrder)" };
              } catch {}
            }
            return JSON.stringify(result, null, 2);
          }
          // Fallback: completed loom — load from DB via DashboardApi
          try {
            const { getMeetingDbPath } = await import("./paths.js");
            const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
              const { DashboardApi } = await import("./dashboard/api.js");
              const api = DashboardApi.get(dbPath);
              const state = api.getState();
              const participants = api.getParticipants();
              const contributions = api.getContributions(500, 0);
              const rounds = state ? [{ number: state.round, contributions, turn_requests: api.getTurnRequests(), summary: "" }] : [];
              const orchestratorMessages = api.getOrchestratorMessages(args.loom_id);
              const result = {};
              if (include.includes('state') && state) {
                result.status = state.status;
                result.round = state.round;
                result.maxRounds = state.max_rounds;
                result.question = state.question;
                result.context = state.context;
              }
              if (include.includes('participants')) {
                result.participants = participants.map(p => ({
                  id: p.id,
                  name: p.name,
                  tier: p.tier,
                  status: p.status,
                  contributions: 0,
                  has_reflection: !!p.reflection,
                  model: p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : 'unassigned',
                }));
              }
              if (include.includes('contributions')) {
                result.contributions = contributions.map(c => ({
                  id: c.id,
                  round: c.round,
                  participantId: c.participant_id,
                  type: c.type,
                  contentPreview: c.content.slice(0, 2000),
                  tool_calls: c.tool_calls ?? null,
                  prompt_context_hash: c.prompt_context ? String(JSON.stringify(c.prompt_context).length) : null,
                  created_at: c.created_at,
                }));
              }
              if (include.includes('rounds')) {
                result.rounds = rounds;
              }
              if (include.includes('fabric') && state) {
                result.fabric = state.fabric;
              }
              if (include.includes('orchestratorMessages')) {
                result.orchestratorMessages = orchestratorMessages.map(m => ({
                  type: m.type,
                  role: m.role,
                  contentPreview: m.content.slice(0, 2000),
                  timestamp: new Date(m.created_at).toISOString(),
                }));
              }
              if (include.includes('config')) {
                try {
                  const { createConfig } = await import("./config.js");
                  const cfgInst = createConfig(directory);
                  result.config = { values: cfgInst.get(), warnings: cfgInst.getWarnings(), source: cfgInst.getSource(), dormantNote: "maxTurnRequestsPerRound was removed from the schema (never enforced — ordering is planTurnOrder)" };
                } catch {}
              }
              result._source = "db-fallback";
              return JSON.stringify(result, null, 2);
            }
          } catch (e) {
            return `No active Loom found with that ID. DB fallback failed: ${e.message}`;
          }
          return "No active Loom found with that ID. For completed looms, use the dashboard export feature.";
        },
      }),

      list_knit_models: tool({
        description: "List all discovered models with their exact identifiers, cost, context window, reasoning capability, current enabled/disabled status, and proposed tier assignments.",
        args: {},
        execute: async () => {
          return handleListKnitModels();
        },
      }),

      enable_knit_models: tool({
        description: "Enable specific models for Loom agents. Provide exact 'provider/model' identifiers as shown in list_knit_models output.",
        args: {
          models: tool.schema
            .array(tool.schema.string())
            .describe("Exact 'provider/model' identifiers to enable (e.g. 'openai/gpt-4.1')"),
        },
        execute: async (args) => {
          return handleEnableKnitModels(args);
        },
      }),

      disable_knit_models: tool({
        description: "Disable specific models for Loom agents. Provide exact 'provider/model' identifiers as shown in list_knit_models output.",
        args: {
          models: tool.schema
            .array(tool.schema.string())
            .describe("Exact 'provider/model' identifiers to disable (e.g. 'openai/gpt-4.1')"),
        },
        execute: async (args) => {
          return handleDisableKnitModels(args);
        },
      }),

      reset_knit_models: tool({
        description: "Reset the model filter to default — all discovered models become available for Loom agents.",
        args: {},
        execute: async () => {
          return handleResetKnitModels();
        },
      }),


    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const deletedId = event.properties?.info?.id;
        if (deletedId) {
          const entries = getDatabasesBySessionId(deletedId);
          for (const { dbPath } of entries) {
            deleteMeetingFiles(dbPath);
          }
          await deleteMeetingsBySessionId(directory, deletedId);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "knit") return;

      const meetingId = output.metadata?.meeting_id;
      if (!meetingId) return;

      if (output.metadata?.loom_status === "error") return;

      try {
        const baseDir = resolveLoomBaseDir(directory);
        const filePath = join(baseDir, "meetings", `${meetingId}.md`);
        const fullReport = readFileSync(filePath, "utf-8");

        output.output =
          "Relay the following deliberation output to the user exactly as written. " +
          "Do not summarize, abbreviate, or reformat it. " +
          "Output the full content below as your response.\n\n" +
          fullReport;
      } catch (err) {
        // If file read fails, leave the original output unchanged
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(
        "When a loom/knit tool completes, its output contains the full deliberation report. " +
        "Relay the complete output to the user as your response. " +
        "Do not summarize, reformat, or abbreviate the tool output — present it as-is.",
      );
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      output.messages = output.messages.filter((msg) => {
        if (msg.info.role !== "user") return true;
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        return !PROGRESS_PATTERN.test(text);
      });
    },
  };
};

export { MeetingOrchestrator } from "./orchestrator.js";
export { formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  getPromptForTier,
  getRightsForTier,
} from "./shared.js";
