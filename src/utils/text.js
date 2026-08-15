import { getConfig } from "../config.js";

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
        // All ToolParts are in "completed" or "error" state — never "pending" or "running".
        const tool = part;
        if (tool.state?.status === "completed") {
          toolResults.push({
            tool: tool.tool,
            callID: tool.callID,
            output: tool.state.output,
            title: tool.state.title,
            metadata: tool.state.metadata,
          });
        } else if (tool.state?.status === "error") {
          toolResults.push({
            tool: tool.tool,
            callID: tool.callID,
            error: tool.state.error,
          });
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

/** Enforces a word limit on text, appending [truncated] if exceeded. */
export function enforceWordLimit(text, maxWords) {
  if (!text || typeof text !== "string") return "";
  const limit = maxWords ?? getConfig().maxContributionWords;
  const words = text.split(/\s+/);
  if (words.length <= limit) return text;
  return words.slice(0, limit - 1).join(" ") + " [truncated]";
}

/** Wraps a promise with a timeout. Rejects if the promise doesn't resolve in time. */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
