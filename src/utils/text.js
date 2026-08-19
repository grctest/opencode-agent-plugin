/** Extracts text content from an LLM response data object. */
export function extractText(data) {
  if (!data?.parts) return null;
  const textParts = data.parts.filter((p) => p.type === "text");
  const content = textParts.map((p) => p.text).join("\n").trim();
  return content.length > 0 ? content : null;
}

/**
 * Extracts the agent's response from prompt data, handling all Part types.
 * Returns the last text segment (post-tool-execution) plus any tool results.
 * When tools are enabled, the LLM may call tools mid-response; this function
 * returns the final text after all tool calls have been resolved.
 * 
 * Key design: Returns only the LAST TextPart (not concatenated).
 * Pre-tool text ("Let me look that up...") is noise — the agent's actual
 * response is the final text after tool execution.
 */
export function extractAgentResponse(data) {
  if (!data?.parts) return { text: null, toolResults: [], reasoning: null };

  let lastText = null;
  const toolResults = [];
  const reasoningParts = [];

  for (const part of data.parts) {
    switch (part.type) {
      case "text":
        // Track the LAST text part — this is the agent's actual response.
        // Pre-tool text ("Let me look that up...") is noise and should be ignored.
        if (!part.ignored && part.text) {
          lastText = part.text;
        }
        break;

      case "reasoning":
        // Claude 3.7 thinking, o1-style reasoning
        if (part.text) {
          reasoningParts.push(part.text);
        }
        break;

      case "tool":
        // ToolPart — session.prompt() auto-executes tools server-side.
        // ToolParts are terminal-state here ("completed" or "error"); attempts that
        // hit an unknown/invalid tool are routed by opencode through the "invalid"
        // tool, whose original tool name + error are embedded in the call input.
        {
          const tool = part;
          const status = tool.state?.status ?? null;
          if (!status) break;
          const callInput = tool.state?.input ?? {};
          const result = {
            tool: tool.tool,
            callID: tool.callID,
            status,
            title: tool.state?.title,
            input: callInput,
            metadata: tool.state?.metadata ?? null,
          };
          if (tool.tool === "invalid") {
            // Remember what the agent actually tried so the timeline can show it.
            if (typeof callInput?.tool === "string") result.attempted_tool = callInput.tool;
            result.tool = result.attempted_tool ?? result.tool;
            result.status = "error";
            result.error = String(tool.state?.output ?? callInput?.error ?? "Tool call rejected as invalid");
          } else if (status === "error") {
            result.error = tool.state?.error;
          } else if (status === "completed") {
            result.output = tool.state?.output;
          }
          toolResults.push(result);
        }
        break;

      case "file":
        // FilePart — agent referenced a file (informational)
        break;

      // Step/file/patch/lsp/etc. parts — informational, not actionable
      case "step-start":
      case "step-finish":
      case "snapshot":
      case "patch":
      case "agent":
      case "retry":
      case "compaction":
        // Log for observability, don't include in extracted text
        break;

      case "subtask":
        // Subtask result — capture text if available
        if (part.text) lastText = part.text;
        break;
    }
  }

  return {
    text: lastText,
    reasoning: reasoningParts.join("\n").trim(),
    toolResults,
  };
}

/** Truncates text to max length, adding ellipsis if needed. */
export function truncate(text, max) {
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 3) + "...";
}

/**
 * Normalizes raw extractAgentResponse tool results into the stored tool_calls
 * shape. Preserves attempt metadata (status, attempted_tool, input) so the
 * timeline can surface calls that were attempted but failed/invalid.
 */
export function mapToolResults(toolResults) {
  return (toolResults ?? []).map((t) => {
    const error = t.error
      ? (typeof t.error === "string" ? t.error : JSON.stringify(t.error))
      : null;
    return {
      tool: t.tool,
      callID: t.callID,
      status: t.status ?? null,
      attempted_tool: t.attempted_tool ?? null,
      title: t.title ?? null,
      output: t.output ? String(t.output).slice(0, 2000) : null,
      error: error ? error.slice(0, 500) : null,
      input: t.input && typeof t.input === "object" && Object.keys(t.input).length ? JSON.stringify(t.input).slice(0, 500) : null,
      metadata: t.metadata ?? null,
    };
  });
}

/** Wraps a promise with a timeout. Rejects if the promise doesn't resolve in time. */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
