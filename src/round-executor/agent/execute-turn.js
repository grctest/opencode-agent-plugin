import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../../prompts/agent.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../../config.js";
import { extractAgentResponse, mapToolResults, extractFileBlockTools, getPriorityCap } from "../../shared.js";
import { parseAgentResponse } from "../../validation.js";
import { sanitizeAgentOutput } from "../../utils/sanitize.js";
import { isRetryableError } from "../../utils/retry.js";
import { selectFallbackModel } from "../../services/model-service.js";
import { incrementKeyedCounter, recordLatency } from "../../metrics.js";
import { extractErrorInfo } from "../../logger.js";
import { buildToolsMap, buildToolsMapWithoutLoom } from "../tools.js";
import { truncateLoomOutputs } from "../../utils/text.js";

export async function executeAgentTurn(participant, model, timeoutMs, promptContext) {
  const config = getConfig();
  const currentRound = this._stateManager.getCurrentRound();
  let ephemeralSessionId;
  let isRoundScoped = false;
  if (this._roundSessionIds?.has(participant.config.id)) {
    ephemeralSessionId = this._roundSessionIds.get(participant.config.id);
    isRoundScoped = true;
  } else {
    ephemeralSessionId = await this._options.createEphemeralSession(participant);
    this._sessionManager.registerSessionMeeting(ephemeralSessionId, this._stateManager.getMeetingId());
  }
  let ephemeralSessionIdToDelete = isRoundScoped ? null : ephemeralSessionId;

  const isSynthesisLoom = (name) => ["loom_query","loom_vote","loom_summon"].includes(name);
  const isLoomTool = (name) => name?.startsWith("loom_") && name !== "loom_vector_search";

  const truncateToolResults = (trs, agentToolsConfig) => {
    const maxToolCalls = agentToolsConfig?.maxToolCallsPerTurn ?? 8;
    const maxOutputTokens = agentToolsConfig?.maxToolOutputTokens ?? 6000;
    if (trs.length > maxToolCalls) {
      this._logger.warn("tool_call_limit", `${participant.config.name} executed ${trs.length} tool calls (limit ${maxToolCalls}) — storing all for audit, synthesis prompt will be bounded`);
    }
    const totalTokens = trs.reduce((sum, r) => sum + Math.ceil(((r.output ? String(r.output).length : 0) / 4)), 0);
    if (totalTokens > maxOutputTokens) {
      this._logger.warn("tool_output_limit", `${participant.config.name} tool outputs ${totalTokens} tokens exceed ${maxOutputTokens} — storing full outputs for audit, synthesis context will be truncated`);
    }
    return trs;
  };

  const extractRequestNextFromToolResults = (trs) => {
    for (const t of trs) {
      const name = t.tool ?? t.attempted_tool;
      if (name === "loom_request_next" && t.status !== "error") {
        try {
          const inp = typeof t.input === "object" ? t.input : (t.input ? JSON.parse(t.input) : {});
          const priority = typeof inp.priority === "number" ? inp.priority : parseInt(inp.priority, 10);
          const reason = typeof inp.reason === "string" ? inp.reason : "";
          if (Number.isFinite(priority) && reason.trim().length > 0) {
            const pr = Math.min(10, Math.max(1, priority));
            return { priority: pr, reason: reason.slice(0,200) };
          }
        } catch {}
        try {
          const out = typeof t.output === "string" ? JSON.parse(t.output) : t.output;
          if (out && Number.isFinite(out.priority) && typeof out.reason === "string") {
            return { priority: Math.min(10, Math.max(1, out.priority)), reason: out.reason.slice(0,200) };
          }
        } catch {}
      }
    }
    return null;
  };

  try {
    this._callStats.agent_prompts++;
    const llmStart = Date.now();

    const toolsMap = buildToolsMap(config);
    const agentToolsConfig = config.agentTools;

    const offeredTools = Object.keys(toolsMap);
    this._logger.info("agent_tools_offered", `${participant.config.name} offered ${offeredTools.length} tool(s)`, {
      participant: participant.config.id,
      round: currentRound,
      tools: offeredTools,
      tool_choice: offeredTools.length > 0 ? "auto" : "none",
    });

    const result1 = await this._sessionManager.getContract().prompt({
      sessionId: ephemeralSessionId,
      system: promptContext.system_prompt,
      model,
      temperature: participant.tier_config.temperature,
      parts: [{ type: "text", text: promptContext.user_prompt }],
      tools: toolsMap,
      toolChoice: Object.keys(toolsMap).length > 0 ? "auto" : undefined,
      timeoutMs,
    });
    const llmMs = Date.now() - llmStart;
    incrementKeyedCounter("llm_calls_by_type", "agent");
    recordLatency("llm_prompt_ms", llmMs);

    this._recordTokens(result1);

    if (!result1.ok) throw result1.error;

    const { text: agentText1, toolResults: toolResults1 } = extractAgentResponse(result1.data);

    if (toolResults1.length > 0) {
      const tools = toolResults1.map((t) => ({
        tool: t.tool,
        callID: t.callID,
        status: t.status ?? null,
        attempted_tool: t.attempted_tool ?? null,
        hasOutput: !!t.output,
        hasError: !!t.error,
      }));
      const attempts = tools.filter((t) => t.status === "error" || t.attempted_tool).length;
      this._logger.info("tool_results", `${participant.config.name} used ${toolResults1.length} tool(s)${attempts > 0 ? ` (${attempts} failed/attempted)` : ""}`, { tools });
    } else {
      // Diagnostic: distinguish "provider never called tools" from "parts dropped
      // before extraction". If partTypes contains tool-like types here, extraction
      // is at fault; if only text/reasoning, the provider saw no/ignored tools.
      const partTypes = (result1.data?.parts ?? []).map(p => p.type);
      this._logger.info("tool_results_none", `${participant.config.name} made 0 tool calls (LLM responded with text only)`, {
        participant: participant.config.id,
        round: currentRound,
        offeredTools: Object.keys(toolsMap),
        partTypeCounts: partTypes.reduce((acc, t) => { acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}),
        model,
      });
    }

    let effective1 = truncateToolResults(toolResults1, agentToolsConfig);

    const loomSynthesisCalls = effective1.filter(t => isSynthesisLoom(t.tool) && t.status === "completed" && t.output);
    const sameTurnEnabled = !!agentToolsConfig?.sameTurnSynthesis;
    const needsSynthesis = sameTurnEnabled && loomSynthesisCalls.length > 0 && agentText1 != null && String(agentText1).trim() !== "[PASS]" && String(agentText1).trim().length > 0;
    const cappedLoomCalls = truncateLoomOutputs(loomSynthesisCalls, 12000, 3500);

    let finalText = agentText1;
    let finalToolResults = effective1;

    if (needsSynthesis) {
      let remainingMs = timeoutMs;
      let synthRan = false;
      if (this._deadline) {
        const remaining = this._deadline - Date.now();
        if (remaining < 6000) {
          this._logger.warn("synthesis_deadline_skipped", `Skipping same-turn synthesis for ${participant.config.name} — deadline ${remaining}ms remaining`);
        } else {
          remainingMs = Math.min(timeoutMs, remaining - 1000);
          const synthesisToolsMap = buildToolsMapWithoutLoom(config);
          const loomOutputs = cappedLoomCalls.map(tc => {
            const out = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output);
            return `Tool ${tc.tool} (${tc.callID}) returned:\n${out.slice(0, 3500)}`;
          }).join("\n\n");
          const synthesisInstruction = `Loom tool results (budget ${loomOutputs.length} chars):\n${loomOutputs}\n\nNow synthesize your final contribution incorporating these responses. Cite [#id] when referencing peer answers. Do not re-call loom_query/loom_vote/loom_summon — you have the results. Stay in character and follow OUTPUT CONTRACT.`;
          if (!loomOutputs.trim()) {
            this._logger.warn("synthesis_empty_outputs", `Skipping synthesis for ${participant.config.name} — loom outputs empty after budget cap`);
          } else {
          this._logger.info("synthesis_prompt", `Same-turn synthesis for ${participant.config.name} with ${loomSynthesisCalls.length} loom result(s)`, { tools: loomSynthesisCalls.map(t=>t.tool), remainingMs });
          const synthStart = Date.now();
          synthRan = true;
          const result2 = await this._sessionManager.getContract().prompt({
            sessionId: ephemeralSessionId,
            system: promptContext.system_prompt,
            model,
            temperature: participant.tier_config.temperature,
            parts: [
              { type: "text", text: promptContext.user_prompt },
              ...(result1.data.parts ?? []).filter(p => p.type === "text" && p.text).slice(-1).map(p => ({ type: "text", text: p.text })),
              { type: "text", text: synthesisInstruction },
            ],
            tools: synthesisToolsMap,
            toolChoice: Object.keys(synthesisToolsMap).length > 0 ? "auto" : undefined,
            timeoutMs: remainingMs,
          });
          const synthMs = Date.now() - synthStart;
          recordLatency("llm_synthesis_ms", synthMs);
          if (result2.ok) {
            this._recordTokens(result2);
            const { text: agentText2, toolResults: toolResults2 } = extractAgentResponse(result2.data);
            if (toolResults2.length > 0) {
              const tools2 = toolResults2.map((t) => ({
                tool: t.tool,
                callID: t.callID,
                status: t.status ?? null,
                hasOutput: !!t.output,
              }));
              this._logger.info("synthesis_tool_results", `${participant.config.name} synthesis used ${toolResults2.length} tool(s)`, { tools: tools2 });
            }
            const effective2 = truncateToolResults(toolResults2, agentToolsConfig);
            const writeSynthetic2 = extractFileBlockTools(agentText2 ?? "");
            const deduped2 = writeSynthetic2.filter(s => !effective1.some(e => e.title === s.title));
            finalToolResults = [...effective1, ...effective2, ...deduped2];
            finalToolResults = truncateToolResults(finalToolResults, agentToolsConfig);
            if (agentText2 && agentText2.trim().length >= 10) {
              finalText = agentText2;
            } else {
              this._logger.warn("synthesis_empty", `Synthesis for ${participant.config.name} returned empty — using first turn text`);
            }
          } else {
            this._logger.warn("synthesis_failed", `Synthesis prompt failed for ${participant.config.name}: ${result2.error?.message ?? "unknown"}`);
            finalToolResults = [...effective1, ...extractFileBlockTools(agentText1 ?? "")];
          }
          }
        }
      }
      if (!synthRan && !finalToolResults.some(t => t.metadata?.synthetic || t.tool === "write")) {
        finalToolResults = [...effective1, ...extractFileBlockTools(agentText1 ?? "")];
        finalToolResults = truncateToolResults(finalToolResults, agentToolsConfig);
      }
    } else {
      finalToolResults = [...effective1, ...extractFileBlockTools(agentText1 ?? "")];
      finalToolResults = truncateToolResults(finalToolResults, agentToolsConfig);
    }

    if (!finalText) {
      const mappedTools = mapToolResults(finalToolResults);
      if (mappedTools.length > 0) {
        this._logger.warn("tool_only_turn", `${participant.config.name} produced no text but executed ${mappedTools.length} tool(s) — returning tool-evidence stub contribution`, {
          participant: participant.config.id,
          round: currentRound,
          tools: mappedTools.map(t => ({ tool: t.tool, status: t.status ?? null })),
        });
        const cap = getPriorityCap(participant.config.tier);
        const reqNext = extractRequestNextFromToolResults(finalToolResults);
        this._recordModelSuccess(model);
        ephemeralSessionIdToDelete = null;
        return {
          participant_id: participant.config.id,
          content: "[TOOL-ONLY TURN — no text produced; tool evidence preserved]",
          type: "contribution",
          request_next: reqNext ? { priority: Math.min(reqNext.priority, cap), reason: reqNext.reason } : null,
          query: null,
          evidence: null,
          summon: null,
          vote: null,
          tool_calls: mappedTools,
          prompt_context: promptContext,
        };
      }
      throw new Error("Empty agent response");
    }

    if (finalText.trim() === "[PASS]" && finalToolResults.length > 0) {
      this._logger.info("pass_with_tools", `${participant.config.name} passed but executed ${finalToolResults.length} tool(s) — attaching tool_calls to pass`, {
        participant: participant.config.id,
        round: currentRound,
      });
    }

    const safeContent = sanitizeAgentOutput(finalText);
    let response = parseAgentResponse(participant.config.id, safeContent, participant.config.tier);
    if (!response) {
      this._logger.warn("parse_fallback", `Failed to parse response for ${participant.config.name} — falling back to generic contribution`, {
        participant: participant.config.id,
        round: currentRound,
        rawPreview: String(finalText).slice(0, 500),
        safePreview: String(safeContent).slice(0, 500),
      });
      response = {
        participant_id: participant.config.id,
        content: safeContent.slice(0, 5000) || "[No content after sanitization]",
        type: "contribution",
        request_next: null,
        query: null,
        evidence: null,
        summon: null,
        vote: null,
      };
    }

    response.tool_calls = mapToolResults(finalToolResults);
    if (!response.tool_calls) response.tool_calls = [];

    this._logger.info("tool_calls_stored", `${participant.config.name} storing ${response.tool_calls.length} tool call(s) for contribution`, {
      participant: participant.config.id,
      round: currentRound,
      toolCount: response.tool_calls.length,
      tools: response.tool_calls.map(t => ({ tool: t.tool, status: t.status ?? null, hasError: !!t.error })),
    });

    const requestNextFromTools = extractRequestNextFromToolResults(finalToolResults);
    if (requestNextFromTools && !response.request_next) {
              const cap = getPriorityCap(participant.config.tier);
      response.request_next = {
        priority: Math.min(requestNextFromTools.priority, cap),
        reason: requestNextFromTools.reason,
      };
    }

    this._recordModelSuccess(model);
    response.prompt_context = promptContext;
    this._options.onAgentComplete?.(participant.config.id, response.content);
    ephemeralSessionIdToDelete = null;
    return response;
  } finally {
    if (!isRoundScoped) this._sessionManager.unregisterSession(ephemeralSessionId);
    else {
      // Round-scoped sessions are bulk-cleaned in runPromptPhase; don't double-unregister
    }
    if (ephemeralSessionIdToDelete) {
      this._options.deleteEphemeralSession(ephemeralSessionIdToDelete).catch((err) => {
        this._logger.warn("ephemeral_session_delete_failed", "Failed to clean up ephemeral session", extractErrorInfo(err));
      });
    }
  }
}
