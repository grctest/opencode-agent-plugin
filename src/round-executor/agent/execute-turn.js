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
import { isSafeBashCommand } from "../../utils/sanitize.js";

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
  const abortController = new AbortController();
  if (this._abortControllers) this._abortControllers.add(abortController);

  const isSynthesisLoom = (name) => ["loom_query","loom_vote","loom_summon"].includes(name);
  const isLoomTool = (name) => name?.startsWith("loom_");

  const truncateToolResults = (trs, agentToolsConfig) => {
    const maxToolCalls = agentToolsConfig?.maxToolCallsPerTurn ?? 200;
    const maxOutputTokens = agentToolsConfig?.maxToolOutputTokens ?? 60000;
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
    const activeCountExec = (() => { try { return this._stateManager.getActiveParticipants().length; } catch { return undefined; }})();
    const toolsMap = buildToolsMap(config, { activeCount: activeCountExec });
    const agentToolsConfig = config.agentTools;

    const offeredTools = Object.keys(toolsMap);
        const result1 = await this._sessionManager.getContract().prompt({
      sessionId: ephemeralSessionId,
      system: promptContext.system_prompt,
      model,
      parts: [{ type: "text", text: promptContext.user_prompt }],
      tools: toolsMap,
      toolChoice: Object.keys(toolsMap).length > 0 ? "auto" : undefined,
      timeoutMs,
      signal: abortController.signal,
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
      const suspiciousParts = (result1.data?.parts ?? []).filter(p => {
        const t = p.type;
        return t && !["text","reasoning","step-start","step-finish","snapshot","agent","retry","subtask","file","patch","tool"].includes(t) && (p.tool || p.state || p.input || p.callID || p.toolCallId);
      });
      if (suspiciousParts.length > 0) {
        this._logger.warn("tool_extraction_mismatch", `${participant.config.name} offered ${Object.keys(toolsMap).length} tools but extraction yielded 0 — ${suspiciousParts.length} suspicious part(s) with tool shape but non-tool type`, {
          participant: participant.config.id,
          round: currentRound,
          offeredTools: Object.keys(toolsMap),
          partTypeCounts: partTypes.reduce((acc, t) => { acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}),
          suspiciousTypes: [...new Set(suspiciousParts.map(p=>p.type))],
          suspiciousSample: suspiciousParts.slice(0,2).map(p=>({ type: p.type, tool: p.tool ?? p.name, hasState: !!p.state, hasInput: !!p.input })),
          model,
        });
      } else {
      }
    }

    let effective1 = truncateToolResults(toolResults1, agentToolsConfig);
    // Arg sandbox: reject unsafe bash args even if command is allowlisted
    for (const tr of effective1) {
      if (tr.tool === "bash" && typeof tr.input === "string" && !isSafeBashCommand(tr.input)) {
        this._logger.warn("bash_unsafe_args_blocked", `Blocked unsafe bash args for ${participant.config.name}: ${tr.input.slice(0,120)}`);
        tr.status = "error";
        tr.error = "Blocked: unsafe bash args (--upload-pack/-exec/-R)";
        tr.output = null;
      } else if (tr.tool === "bash" && tr.input && typeof tr.input === "object") {
        const cmd = typeof tr.input.command === "string" ? tr.input.command : JSON.stringify(tr.input);
        if (!isSafeBashCommand(cmd)) {
          this._logger.warn("bash_unsafe_args_blocked", `Blocked unsafe bash args for ${participant.config.name}: ${cmd.slice(0,120)}`);
          tr.status = "error";
          tr.error = "Blocked: unsafe bash args (--upload-pack/-exec/-R)";
          tr.output = null;
        }
      }
    }

    const loomSynthesisCalls = effective1.filter(t => isSynthesisLoom(t.tool) && t.status === "completed" && t.output);
    const loomPassCall = effective1.find(t => t.tool === "loom_pass" && t.status !== "error");
    const sameTurnEnabled = !!agentToolsConfig?.sameTurnSynthesis;
    const needsSynthesis = sameTurnEnabled && loomSynthesisCalls.length > 0 && !loomPassCall && agentText1 != null && String(agentText1).trim().length > 0;
    const cappedLoomCalls = truncateLoomOutputs(loomSynthesisCalls, 12000, 3500);

    let finalText = agentText1;
    let finalToolResults = effective1;

    if (needsSynthesis) {
      let remainingMs = timeoutMs;
      let synthRan = false;
      if (timeoutMs !== 0 && this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
        const remaining = this._deadline - Date.now();
        if (remaining < 15000) {
          this._logger.warn("synthesis_deadline_skipped", `Skipping same-turn synthesis for ${participant.config.name} — deadline ${remaining}ms remaining (needs 15s)`);
        } else {
          remainingMs = Math.min(timeoutMs, Math.max(15000, remaining - 1000));
          const synthesisToolsMap = buildToolsMapWithoutLoom(config, { activeCount: activeCountExec });
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
            parts: [
              { type: "text", text: promptContext.user_prompt },
              ...(result1.data.parts ?? []).filter(p => p.type === "text" && p.text).slice(-1).map(p => ({ type: "text", text: p.text })),
              { type: "text", text: synthesisInstruction },
            ],
            tools: synthesisToolsMap,
            toolChoice: Object.keys(synthesisToolsMap).length > 0 ? "auto" : undefined,
            timeoutMs: remainingMs,
            signal: abortController.signal,
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
      throw new Error(`Empty agent response — model ${model?.providerID}/${model?.modelID} / ${participant.config.id}, tools: ${Object.keys(toolsMap).join(',')}, prompt ${promptContext.user_prompt?.length ?? 0} chars`);
    }

    if (loomPassCall && finalToolResults.length > 0) {
      this._logger.info("pass_with_tools", `${participant.config.name} passed via loom_pass but executed ${finalToolResults.length} tool(s) — attaching tool_calls to pass`, {
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
    if (this._abortControllers) this._abortControllers.delete(abortController);
    if (!isRoundScoped) {
      // deleteEphemeralSession already unregisters, no need for double unregister
    }
    if (ephemeralSessionIdToDelete) {
      this._options.deleteEphemeralSession(ephemeralSessionIdToDelete).catch((err) => {
        this._logger.warn("ephemeral_session_delete_failed", "Failed to clean up ephemeral session", extractErrorInfo(err));
      });
    }
  }
}
