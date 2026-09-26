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
import { getBashCommand, isBashCommandAllowed } from "../../utils/sanitize.js";

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
    const effectiveAgentTools = this.getEffectiveAgentTools?.() ?? this._options?.agentTools ?? this._tools ?? config.agentTools;
    const effectiveConfig = { ...config, agentTools: effectiveAgentTools };
    const toolsMap = buildToolsMap(effectiveConfig, { activeCount: activeCountExec });
    const agentToolsConfig = effectiveAgentTools;

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
       if (tr.tool !== "bash") continue;
       const command = getBashCommand(tr.input);
       const allowlist = agentToolsConfig?.builtIn?.bash?.allowlist;
       if (!isBashCommandAllowed(command, allowlist)) {
         this._logger.warn("bash_unsafe_args_blocked", `Blocked unsafe bash args for ${participant.config.name}: ${String(command ?? "missing command").slice(0,120)}`);
         tr.status = "error";
         tr.error = "Blocked by Loom bash policy";
         tr.output = null;
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
          const synthesisToolsMap = buildToolsMapWithoutLoom(effectiveConfig, { activeCount: activeCountExec });
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
              // Same session already holds system + user prompt + turn-1 history;
              // re-sending the ~10k-token user prompt duplicates it verbatim and
              // reads as an instruction to produce the contribution again (audit B2).
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
            const priorLen = (agentText1 ?? "").trim().length;
            const synthLen = (agentText2 ?? "").trim().length;
            const substantive = synthLen >= 200 || (priorLen > 0 && synthLen >= Math.floor(priorLen / 2));
            if (agentText2 && substantive) {
              finalText = agentText2;
            } else if (synthLen >= 10) {
              this._logger.warn("synthesis_too_short", `Synthesis for ${participant.config.name} returned only ${synthLen} chars — keeping first turn text (${priorLen} chars)`, { participant: participant.config.id, round: currentRound });
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

    // SKILL.state mandatory patch-retry (plan §5.6 step 3): exactly one second pass on
    // the same ephemeral session when no applied loom_state_patch and the turn was not
    // a pass. Order is primary → synthesis → patch, so cited [#id]s from inline answers
    // can enter facts_add. Never fails the turn — prose is preserved, state stays prior.
    const patchEnabled = !!agentToolsConfig?.enabled && !!agentToolsConfig?.loom?.loom_state_patch;
    const mandatoryCapabilities = agentToolsConfig?.mandatory ?? {};
    const patchRetryEnabled = !!mandatoryCapabilities.skillState || (!agentToolsConfig?.mandatory && agentToolsConfig?.patchRetry !== false);
    const hasAppliedPatch = (trs) => (trs ?? []).some((t) => t.tool === "loom_state_patch" && t.metadata?.applied === true);
    let statePatchVersion = (() => {
      const hit = (finalToolResults ?? []).find((t) => t.tool === "loom_state_patch" && t.metadata?.applied === true);
      return hit?.metadata?.version ?? null;
    })();
    const hasContentForPatch = (finalText && String(finalText).trim().length > 0) || (finalToolResults ?? []).length > 0;
    let patchDeadlineSkipped = false;
    // Tracks whether the patch-retry above already ran: the mandatory-capability
    // retry below must not re-nag SKILL.state in the same turn (audit P0-B —
    // two near-identical nags, two extra LLM calls, on the worst-case turn).
    let patchRetryAttempted = false;
    if (patchEnabled && patchRetryEnabled && !hasAppliedPatch(finalToolResults) && !loomPassCall && hasContentForPatch) {
      // Surface primary-pass validation issues so the retry does not repeat identical args blindly
      let issuesHint = "";
      try {
        const failed = (finalToolResults ?? []).find((t) => t.tool === "loom_state_patch" && (t.status === "error" || t.metadata?.validationFailed));
        const raw = failed?.output ?? failed?.error ?? "";
        const txt = typeof raw === "string" ? raw : JSON.stringify(raw);
        if (txt && txt.length > 10) issuesHint = `\nYour previous call failed validation: ${txt.slice(0, 500)}\nFix the args and retry.`;
      } catch {}
      const patchInstruction = `Your contribution is recorded. Now call loom_state_patch ONCE to project what should survive: your current stance (1 sentence) + 1-3 bullets across established/contested/open/facts/files (facts need Source: or [#id], optionally with Strength: strong/weak) + exact-text remove entries for outdated bullets. At least one field. No prose needed beyond the call.${issuesHint}`;
      let patchRemaining = timeoutMs;
      if (timeoutMs !== 0 && this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
        const remaining = this._deadline - Date.now();
        if (remaining < 15000) {
          this._logger.warn("state_patch_retry_skipped_deadline", `Skipping loom_state_patch retry for ${participant.config.name} — deadline ${remaining}ms remaining (needs 15s)`);
          patchRemaining = 0;
          patchDeadlineSkipped = true;
        } else {
          patchRemaining = Math.min(timeoutMs, Math.max(15000, remaining - 1000));
        }
      }
      if (patchRemaining !== 0) {
        patchRetryAttempted = true;
        try {
          this._logger.info("state_patch_retry", `Requesting loom_state_patch retry for ${participant.config.name}`, { participant: participant.config.id, round: currentRound });
          const patchToolsMap = buildToolsMap(effectiveConfig, { activeCount: activeCountExec });
          const resultP = await this._sessionManager.getContract().prompt({
            sessionId: ephemeralSessionId,
            system: promptContext.system_prompt,
            model,
            parts: [
              // Same-session follow-up: user prompt already in history (audit B2).
              ...(result1?.data?.parts ?? []).filter((p) => p.type === "text" && p.text).slice(-1).map((p) => ({ type: "text", text: p.text })),
              { type: "text", text: patchInstruction },
            ],
            tools: patchToolsMap,
            toolChoice: Object.keys(patchToolsMap).length > 0 ? "auto" : undefined,
            timeoutMs: patchRemaining,
            signal: abortController.signal,
          });
          if (resultP.ok) {
            this._recordTokens(resultP);
            const { toolResults: toolResultsP } = extractAgentResponse(resultP.data);
            const effectiveP = truncateToolResults(toolResultsP ?? [], agentToolsConfig);
            if (effectiveP.length > 0) {
              finalToolResults = truncateToolResults([...finalToolResults, ...effectiveP], agentToolsConfig);
            }
            const hitP = effectiveP.find((t) => t.tool === "loom_state_patch" && t.metadata?.applied === true);
            if (hitP) {
              statePatchVersion = hitP.metadata?.version ?? null;
              this._logger.info("state_patch_retry_ok", `${participant.config.name} applied loom_state_patch on retry (v${statePatchVersion ?? "?"})`, { participant: participant.config.id, round: currentRound, version: statePatchVersion });
            } else {
              this._logger.warn("state_patch_missed", `${participant.config.name} — no applied loom_state_patch after retry; state stays at prior version`, { participant: participant.config.id, round: currentRound });
            }
          } else {
            this._logger.warn("state_patch_retry_failed", `loom_state_patch retry prompt failed for ${participant.config.name}: ${resultP.error?.message ?? "unknown"}`, { participant: participant.config.id, round: currentRound });
          }
        } catch (e) {
          this._logger.warn("state_patch_retry_error", `loom_state_patch retry error for ${participant.config.name}: ${e?.message ?? e}`, { participant: participant.config.id, round: currentRound });
        }
      }
    }
    const hasSuccessfulTool = (toolName) => (finalToolResults ?? []).some((t) => t.tool === toolName && t.status !== "error" && t.output != null);
    const hasSuccessfulOneOf = (toolNames) => toolNames.some((toolName) => hasSuccessfulTool(toolName));
    const missingMandatory = [];
    if (mandatoryCapabilities.forums && !hasSuccessfulOneOf(["loom_forum_create_topic", "loom_forum_list_topics", "loom_forum_read_topic", "loom_forum_add_comment"])) missingMandatory.push("Forums: call loom_forum_list_topics, loom_forum_read_topic, loom_forum_create_topic, or loom_forum_add_comment");
    // SKILL.state is covered by the dedicated patch-retry above: if that retry
    // already ran and missed, a second nag in the same turn adds an LLM call
    // for no new information (audit P0-B).
    if (mandatoryCapabilities.skillState && !hasSuccessfulTool("loom_state_patch") && !patchRetryAttempted) missingMandatory.push("SKILL.state: call loom_state_patch");
    if (patchRetryAttempted && mandatoryCapabilities.skillState && !hasSuccessfulTool("loom_state_patch")) {
      try {
        this._logger.debug("mandatory_state_retry_suppressed", `SKILL.state mandatory retry suppressed for ${participant.config.name} — patch-retry already ran this turn`, { participant: participant.config.id, round: currentRound });
      } catch {}
    }
    if (mandatoryCapabilities.agentQueries && Number.isFinite(activeCountExec) && activeCountExec > 1 && !hasSuccessfulOneOf(["loom_query", "loom_vote", "loom_summon", "loom_request_next"])) missingMandatory.push("Agent-to-agent: call loom_query, loom_vote, loom_summon, or loom_request_next with an eligible peer");
    if (mandatoryCapabilities.localSearch && !hasSuccessfulOneOf(["read", "glob", "grep"])) missingMandatory.push("Local search: call read, glob, or grep");
    if (mandatoryCapabilities.onlineResearch && !hasSuccessfulOneOf(["websearch", "webfetch"])) missingMandatory.push("Online research: call websearch or webfetch");
    if (!loomPassCall && missingMandatory.length > 0) {
      let mandatoryRemaining = timeoutMs;
      if (timeoutMs !== 0 && this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
        const remaining = this._deadline - Date.now();
        if (remaining < 15000) {
          mandatoryRemaining = 0;
        } else {
          mandatoryRemaining = Math.min(timeoutMs, Math.max(15000, remaining - 1000));
        }
      }
      if (mandatoryRemaining !== 0) {
        try {
          const mandatoryInstruction = `This turn has unmet mandatory capabilities: ${missingMandatory.join("; ")}. Complete every applicable requirement now, using the exact tool names and valid targets. Do not repeat the prose — make ONLY the required tool call(s). Your earlier contribution is already recorded; no replacement prose is needed.`;
          this._logger.info("mandatory_capability_retry", `Requesting mandatory capability retry for ${participant.config.name}`, { participant: participant.config.id, round: currentRound, missing: missingMandatory });
          // Loom-free map: this retry satisfies a capability, it must not open a
          // new peer interaction with no synthesis pass to fold it in (audit B8).
          // loom_request_next (fire-and-forget, no peer answers) and the forum
          // tools stay available; loom_state_patch is re-added only when the
          // state capability itself is what's missing, otherwise the retry
          // could never satisfy it. loom_query/vote/summon stay off: their
          // answers would arrive with no synthesis pass to fold them in.
          // Same-session follow-up: user prompt already in history (audit B2).
          const mandatoryToolsMap = buildToolsMapWithoutLoom(effectiveConfig, { activeCount: activeCountExec });
          if (missingMandatory.some((m) => m.startsWith("SKILL.state")) && effectiveAgentTools?.loom?.loom_state_patch) {
            mandatoryToolsMap.loom_state_patch = true;
          }
          const resultM = await this._sessionManager.getContract().prompt({
            sessionId: ephemeralSessionId,
            system: promptContext.system_prompt,
            model,
            parts: [
              ...(result1?.data?.parts ?? []).filter((p) => p.type === "text" && p.text).slice(-1).map((p) => ({ type: "text", text: p.text })),
              { type: "text", text: mandatoryInstruction },
            ],
            tools: mandatoryToolsMap,
            toolChoice: Object.keys(mandatoryToolsMap).length > 0 ? "auto" : undefined,
            timeoutMs: mandatoryRemaining,
            signal: abortController.signal,
          });
          if (resultM.ok) {
            this._recordTokens(resultM);
            const retryResponse = extractAgentResponse(resultM.data);
            const effectiveM = truncateToolResults(retryResponse.toolResults ?? [], agentToolsConfig);
            if (effectiveM.length > 0) finalToolResults = truncateToolResults([...finalToolResults, ...effectiveM], agentToolsConfig);
            // Enforcement retries harvest tool calls only: the retry instruction
            // tells the model not to repeat the prose, so its text must never
            // displace the primary contribution (audit N0 — a compliant model
            // returns a one-line filler that would silently replace full prose).
            if (retryResponse.text && retryResponse.text.trim().length > 0) {
              try {
                this._logger.debug("mandatory_retry_text_ignored", `Ignoring ${retryResponse.text.trim().length}-char prose from mandatory retry for ${participant.config.name} — primary contribution preserved`, { participant: participant.config.id, round: currentRound });
              } catch {}
            }
            const retryPatch = effectiveM.find((t) => t.tool === "loom_state_patch" && t.metadata?.applied === true);
            if (retryPatch) statePatchVersion = retryPatch.metadata?.version ?? null;
          } else {
            this._logger.warn("mandatory_capability_retry_failed", `Mandatory capability retry failed for ${participant.config.name}: ${resultM.error?.message ?? "unknown"}`, { participant: participant.config.id, round: currentRound, missing: missingMandatory });
          }
        } catch (e) {
          this._logger.warn("mandatory_capability_retry_error", `Mandatory capability retry error for ${participant.config.name}: ${e?.message ?? e}`, { participant: participant.config.id, round: currentRound, missing: missingMandatory });
        }
      }
    }

    // Per-turn patch outcome (§5.10 observability, made legible). The retry above
    // is deliberately non-fatal, so "no patch" has several distinct causes that
    // a single counter collapses. Recording the cause lets the dashboard explain
    // coverage without anyone reading logs. Ordered by specificity.
    const patchAttempted = (finalToolResults ?? []).some((t) => t.tool === "loom_state_patch");
    const patchRejected = (finalToolResults ?? []).some(
      (t) => t.tool === "loom_state_patch" && (t.status === "error" || t.metadata?.validationFailed || t.metadata?.persistenceFailed),
    );
    const patchOutcome = !patchEnabled
      ? "disabled"
      : loomPassCall
        ? "exempt_pass"
        : statePatchVersion != null
          ? "applied"
          : patchDeadlineSkipped
            ? "skipped_deadline"
            : patchRejected
              ? "rejected"
              : patchAttempted
                ? "unverified"
                : "never_attempted";
    let patchOutcomeDetail = null;
    if (patchOutcome === "skipped_deadline") patchOutcomeDetail = "retry skipped: <15s remained on the meeting deadline";
    if (patchOutcome === "rejected") {
      const bad = (finalToolResults ?? []).find(
        (t) => t.tool === "loom_state_patch" && (t.status === "error" || t.metadata?.validationFailed || t.metadata?.persistenceFailed),
      );
      patchOutcomeDetail = String(bad?.output ?? bad?.error ?? "validation/persistence failure").slice(0, 300);
    }

    // Operational logging only (§5.10): DEBUG patch/version counts, never gating.
    try {
      if (patchEnabled && !loomPassCall) {
        if (statePatchVersion != null) {
          this._logger.debug("state_patch_applied", `${participant.config.name} state patch v${statePatchVersion}`, { participant: participant.config.id, round: currentRound, version: statePatchVersion, outcome: patchOutcome });
        } else {
          this._logger.debug("state_patch_missed", `${participant.config.name} — turn produced no applied state patch`, { participant: participant.config.id, round: currentRound, outcome: patchOutcome, detail: patchOutcomeDetail });
        }
      }
    } catch {}

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
        const toolOnlyCtx = { ...(promptContext ?? {}), state_patch_outcome: patchOutcome };
        if (patchOutcomeDetail) toolOnlyCtx.state_patch_detail = patchOutcomeDetail;
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
          prompt_context: toolOnlyCtx,
          ...(statePatchVersion != null ? { state_patch: { version: statePatchVersion } } : {}),
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
    if (statePatchVersion != null) response.state_patch = { version: statePatchVersion };
    // Persist the per-turn patch outcome on the already-persisted prompt_context
    // blob — avoids a schema migration just for observability, and the dashboard
    // reads it straight off the contribution.
    if (response.prompt_context && typeof response.prompt_context === "object") {
      response.prompt_context.state_patch_outcome = patchOutcome;
      if (patchOutcomeDetail) response.prompt_context.state_patch_detail = patchOutcomeDetail;
    } else {
      response.state_patch = {
        ...(response.state_patch ?? {}),
        outcome: patchOutcome,
        ...(patchOutcomeDetail ? { detail: patchOutcomeDetail } : {}),
      };
    }
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
