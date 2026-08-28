import { buildSummonPrompt, buildVotePrompt } from "../../prompts/interaction-prompts.js";
import { getConfig, resolveBuiltInTools } from "../../config.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
import { extractErrorInfo } from "../../logger.js";
import { extractVoteLetter, buildTally } from "../../utils/vote-tally.js";
import { degrade } from "../../utils/degrade.js";

export async function executeSummons(round, sourceParticipant, summon, {
  sessionManager,
  stateManager,
  db,
  callStats,
}) {
  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;

  if (!round.summons) round.summons = [];
  if (round.summons.length >= (config.maxSummonsPerRound ?? 2)) return;
  const agentSummons = round.summons.filter((s) => s.requesterId === sourceParticipant.config.id);
  if (agentSummons.length >= (config.maxSummonsPerAgent ?? 1)) return;

  const allPersonas = getPersonas();
  let resolvedPersona = null;
  for (const tier of Object.keys(allPersonas)) {
    const match = allPersonas[tier].find(
      (p) => p.name.toLowerCase() === summon.persona_name.toLowerCase()
    );
    if (match) { resolvedPersona = { ...match, tier }; break; }
  }

  if (!resolvedPersona) {
    this._logger.warn("summon_persona_not_found", `Persona "${summon.persona_name}" not found`);
    return;
  }

  const summonedId = `summoned_${resolvedPersona.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  db.setSummoningParticipants([summonedId]);

  const summonedConfig = {
    config: {
      id: summonedId,
      name: resolvedPersona.name,
      tier: resolvedPersona.tier,
      persona: resolvedPersona.persona,
      expertise: resolvedPersona.expertise,
      communication_style: resolvedPersona.communication_style,
    },
    tier_config: { temperature: 0.7 },
  };

  const sessionId = await sessionManager.createEphemeralSession(summonedConfig);
  try {
    const prompt = buildSummonPrompt(
      resolvedPersona,
      sourceParticipant,
      summon.issue,
      round.contributions,
      stateManager.getCurrentRound(),
      stateManager.getMaxRounds(),
      stateManager.getStateOfPlay(),
    );

    const agentToolsConfig = getConfig().agentTools;
    const toolsMap = {};
    if (agentToolsConfig?.enabled) {
      const t = resolveBuiltInTools(agentToolsConfig);
      if (t.webfetch) toolsMap.webfetch = true;
      if (t.websearch) toolsMap.websearch = true;
      if (t.read) toolsMap.read = true;
      if (t.bash) toolsMap.bash = true;
      if (t.glob) toolsMap.glob = true;
      if (t.grep) toolsMap.grep = true;
      if (agentToolsConfig.loom?.loom_vector_search) toolsMap.loom_vector_search = true;
    }
    const summonedToolKeys = Object.keys(toolsMap);
    this._logger.info("agent_tools_offered", `${resolvedPersona.name} (summoned) offered ${summonedToolKeys.length} tool(s)`, {
      participant: summonedId,
      round: stateManager.getCurrentRound(),
      tools: summonedToolKeys,
      tool_choice: summonedToolKeys.length > 0 ? "auto" : "none",
    });

    // Reuse source's assigned model (left sidebar) — stays strictly within enabled allowlist
    let model = null;
    try {
      model = this._getParticipantModel ? this._getParticipantModel(sourceParticipant) : sourceParticipant.config.model;
    } catch {
      model = sourceParticipant.config.model;
    }
    if (!model) {
      // Borrow-any enabled model from any participant — never re-discovers outside filtered pool
      try {
        for (const p of stateManager.getParticipants()) {
          if (!p || p.status === "failed") continue;
          const m = (() => { try { return this._getParticipantModel ? this._getParticipantModel(p) : p.config.model; } catch { return null; } })();
          if (m) { model = m; break; }
        }
      } catch {}
    }
    if (!model) {
      this._logger.warn("summon_no_model", "No model available for summoned persona — no enabled model assigned to any participant");
      return;
    }

    const systemPrompt = `You are ${resolvedPersona.name} (${resolvedPersona.tier}) — guest expert summoned into Loom for one additive contribution.

Be concise (100-150 words), grounded, in character. Build on what’s settled; don’t re-litigate without new evidence. Name one constraint only you would know. Cite Source: URL or [#id] if you use evidence. Never emit <<< or >>>. No contribution tags.`;
    const promptContext = {
      type: "summoned_response",
      system_prompt: systemPrompt,
      user_prompt: prompt,
      persona_name: resolvedPersona.name,
      persona_tier: resolvedPersona.tier,
      source_participant_id: sourceParticipant.config.id,
      issue: summon.issue,
      round_contributions_used: round.contributions.slice(-4).map((c) => ({
        id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
      })),
      round: stateManager.getCurrentRound(),
    };

    const result = await sessionManager.getContract().prompt({
      sessionId,
      system: systemPrompt,
      model,
      temperature: 0.7,
      parts: [{ type: "text", text: prompt }],
      tools: toolsMap,
      toolChoice: Object.keys(toolsMap).length > 0 ? "auto" : undefined,
      timeoutMs,
    });

    if (callStats) {
      callStats.reflection_calls++;
      const tokens = result.tokens;
      if (tokens) {
        callStats.input_tokens += tokens.input ?? 0;
        callStats.output_tokens += tokens.output ?? 0;
      }
    }

    if (!result.ok) throw result.error;

    const { text, toolResults } = extractAgentResponse(result.data);

    if (!text || text.trim().length < 10) {
      if (toolResults.length > 0) {
        this._logger.warn("summon_short_text_with_tools", `${resolvedPersona.name} produced short/empty summoned answer but executed ${toolResults.length} tool(s) — storing tool-evidence-only contribution`, {
          participant: summonedId,
          round: stateManager.getCurrentRound(),
          tools: toolResults.map(t => ({ tool: t.tool, status: t.status ?? null })),
        });
        const evidenceOnly = {
          id: stateManager.nextContributionId(),
          round: stateManager.getCurrentRound(),
          participant_id: summonedId,
          content: `[Summoned: ${resolvedPersona.name} (${resolvedPersona.tier})]\n\n(insufficient response text — tool evidence preserved)`,
          type: "summoned_response",
          targets_which: null,
          batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
          tool_calls: mapToolResults(toolResults),
          prompt_context: promptContext,
          created_at: new Date().toISOString(),
        };
        stateManager.addContribution(evidenceOnly);
        round.contributions.push(evidenceOnly);
        degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), evidenceOnly, null), null);
      }
      return;
    }

    const contributionTools = mapToolResults(toolResults);

    const contribution = {
      id: stateManager.nextContributionId(),
      round: stateManager.getCurrentRound(),
      participant_id: summonedId,
      content: `[Summoned: ${resolvedPersona.name} (${resolvedPersona.tier})]\n\n${text.trim()}`,
      type: "summoned_response",
      targets_which: null,
      batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
      tool_calls: contributionTools ?? [],
      prompt_context: promptContext,
      created_at: new Date().toISOString(),
    };

    stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    round.summons.push({ requesterId: sourceParticipant.config.id, personaName: resolvedPersona.name });

    degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null), null);

    this._options.onProgress?.(`${resolvedPersona.name} (${resolvedPersona.tier}) — summoned by ${sourceParticipant.config.name}`);
    this._options.onContribution?.(resolvedPersona.name, stateManager.getCurrentRound(), "summoned_response");

  } catch (err) {
    const info = extractErrorInfo(err);
    this._logError(`summon for ${resolvedPersona.name}`, err);
    this._logger.warn("summon_failed", `Summon of ${resolvedPersona.name} failed`, info);
  } finally {
    await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
    db.setSummoningParticipants(null);
  }
}

export async function executeVote(round, sourceParticipant, vote, sourceContributionId, {
  sessionManager,
  getParticipantModel,
  stateManager,
  db,
  callStats,
}) {
  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;
  const allParticipants = stateManager.getParticipants();

  const sourceContribution = round.contributions.find((c) => c.id === sourceContributionId);
  const sourceVoteText = sourceContribution?.content ?? "";

  const voters = allParticipants.filter(
    (p) => p.config.id !== sourceParticipant.config.id && p.status !== "failed" && p.status !== "passed",
  );

  if (voters.length === 0) {
    // No voters — no tally needed, source's vote is in their own contribution prose
    this._options.onProgress?.(`${sourceParticipant.config.name} — vote (source only, no voters)`);
    return;
  }

  db.setQueryingParticipants(voters.map((v) => v.config.id));

  const voteResponses = [];

  await Promise.allSettled(
    voters.map(async (voter) => {
      const model = getParticipantModel(voter);
      let sessionId;
      let isRoundScoped = false;
      if (this._roundSessionIds?.has(voter.config.id)) {
        sessionId = this._roundSessionIds.get(voter.config.id);
        isRoundScoped = true;
      } else {
        sessionId = await sessionManager.createEphemeralSession(voter);
        sessionManager.registerSessionMeeting(sessionId, stateManager.getMeetingId());
      }
      try {
        const previousStatus = voter.status;
        voter.status = "speaking";
        db.setParticipantStatus(voter.config.id, "speaking");

        const prompt = buildVotePrompt(
          sourceParticipant,
          voter,
          sourceContribution || sourceParticipant.config.name,
          vote.question,
          round.contributions,
          stateManager.getCurrentRound(),
          stateManager.getMaxRounds(),
          stateManager.getStateOfPlay(),
        );

        const systemPrompt = `You are ${voter.config.name} (${voter.config.tier}) — voting in Loom.

Choose one letter (A/B/C…) as listed in the vote question. Format exactly:
[Vote: X]
One sentence criterion (cost/risk/time/reversibility) reflecting your agenda. No contribution tags, 1-2 sentences total, in character.`;

        const promptContext = {
          type: "vote_response",
          system_prompt: systemPrompt,
          user_prompt: prompt,
          source_contribution_id: sourceContributionId,
          source_participant_id: sourceParticipant.config.id,
          question: vote.question,
          round_contributions_used: round.contributions.slice(-4).map((c) => ({
            id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
          })),
          round: stateManager.getCurrentRound(),
        };

        const result = await sessionManager.getContract().prompt({
          sessionId,
          system: systemPrompt,
          model,
          temperature: voter.tier_config.temperature,
          parts: [{ type: "text", text: prompt }],
          tools: {},
          toolChoice: "none",
          timeoutMs,
        });

        if (callStats) {
          callStats.reflection_calls++;
          const tokens = result.tokens;
          if (tokens) {
            callStats.input_tokens += tokens.input ?? 0;
            callStats.output_tokens += tokens.output ?? 0;
          }
        }

        if (!result.ok) throw result.error;

        const { text } = extractAgentResponse(result.data);

        if (!text || text.trim().length < 5) return;

        const contribution = {
          id: stateManager.nextContributionId(),
          round: stateManager.getCurrentRound(),
          participant_id: voter.config.id,
          content: `[Vote from ${voter.config.name}]\n\n${text.trim()}`,
          type: "vote_response",
          targets_which: sourceContributionId,
          batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
          tool_calls: null,
          prompt_context: promptContext,
          created_at: new Date().toISOString(),
        };

        stateManager.addContribution(contribution);
        round.contributions.push(contribution);
        voteResponses.push({ voter: voter.config.name, content: text.trim() });
        stateManager.incrementParticipantContributions(voter.config.id);

        degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null), null);

        voter.status = previousStatus;
        db.setParticipantStatus(voter.config.id, previousStatus);

        this._options.onProgress?.(`${voter.config.name} (${voter.config.tier}) — voted on poll`);
        this._options.onContribution?.(voter.config.name, stateManager.getCurrentRound(), "vote_response");

      } catch (err) {
        const info = extractErrorInfo(err);
        this._logError(`vote response for ${voter.config.name}`, err);
        this._logger.warn("vote_failed", `Vote response for ${voter.config.name} failed`, info);
        voter.status = "listening";
        db.setParticipantStatus(voter.config.id, "listening");
      } finally {
        if (!isRoundScoped) {
          sessionManager.unregisterSession(sessionId);
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }
    }),
  );

  db.setQueryingParticipants(null);

  // Tally is inline-only via loom_vote tool output; no persisted vote_tally row (invoker interprets in prose)
  const { counts: voteCounts } = buildTally({
    question: vote.question,
    sourceLetter: extractVoteLetter(sourceVoteText),
    sourceLabel: sourceParticipant.config.name,
    responses: voteResponses,
  });
  const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
  this._options.onProgress?.(`${sourceParticipant.config.name} — votes collected: ${sorted.length > 0 ? `leading ${sorted[0][0]}` : "no votes"} (tally inline, not persisted)`);
}
