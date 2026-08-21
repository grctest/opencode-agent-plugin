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
        // FilePart — agent referenced or produced a file; surface as a tool so the
        // dashboard's Tool use tab can show it even when no explicit tool call exists.
        {
          const fp = part;
          toolResults.push({
            tool: "file",
            callID: fp.id ?? fp.callID ?? `file-${toolResults.length}`,
            status: "completed",
            title: fp.filename || fp.url || fp.mime || "file",
            input: { url: fp.url, filename: fp.filename, mime: fp.mime, source: fp.source },
            output: fp.url ? `File: ${fp.url}${fp.filename ? ` (${fp.filename})` : ""}` : (fp.filename || "file reference"),
            metadata: fp.source ?? null,
          });
        }
        break;

      case "patch":
        // PatchPart — VCS patch applied (actual file edits on disk). Previously ignored,
        // which caused "file exists but no tool calls recorded". Now surface as tool.
        {
          const pp = part;
          toolResults.push({
            tool: "patch",
            callID: pp.id ?? `patch-${toolResults.length}`,
            status: "completed",
            title: Array.isArray(pp.files) ? pp.files.join(", ") : "patch",
            input: { files: pp.files, hash: pp.hash },
            output: Array.isArray(pp.files) && pp.files.length > 0 ? `Patched: ${pp.files.join(", ")}\nHash: ${pp.hash ?? ""}`.trim() : `Patch hash: ${pp.hash ?? ""}`,
            metadata: null,
          });
        }
        break;

      // Step/snapshot/etc. parts — informational, not actionable
      case "step-start":
      case "step-finish":
      case "snapshot":
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

  // Synthesize file-block tools from markdown fences so file writes are auditable
  // even when the LLM only emitted ```lang file=path``` without a real tool call.
  // This complements the patch/file Part capture above and makes Tool use tab useful.
  if (lastText) {
    const synthetic = extractFileBlockTools(lastText);
    if (synthetic.length > 0) {
      const existingTitles = new Set(toolResults.map((t) => t.title).filter(Boolean));
      const existingInputs = toolResults.map((t) => {
        try { return typeof t.input === "string" ? t.input : JSON.stringify(t.input ?? ""); } catch { return ""; }
      }).join(" ");
      for (const st of synthetic) {
        if (existingTitles.has(st.title)) continue;
        if (existingInputs.includes(st.title)) continue;
        toolResults.push(st);
      }
    }
  }

  return {
    text: lastText,
    reasoning: reasoningParts.join("\n").trim(),
    toolResults,
  };
}

/**
 * Scans markdown text for fenced code blocks that declare a file target
 * (```lang file=path) and synthesizes pseudo tool calls so the dashboard's
 * Tool use tab can surface them even when the LLM only emitted text.
 * The file on disk may have been created via a PatchPart (now also captured)
 * or hallucinated; this ensures any file= block is auditable.
 */
export function extractFileBlockTools(text) {
  if (!text || typeof text !== "string") return [];
  const tools = [];
  // Matches ```<lang> file=<path>  up to newline, then code until ```
  // Example: ```js file=src/fizzbuzz-classic.js\nfunction ...``` 
  const fenceRe = /```[^\n]*\bfile\s*=\s*([^\s`"\n]+)[^\n]*\n([\s\S]*?)```/g;
  let m;
  let idx = 0;
  const seen = new Set();
  while ((m = fenceRe.exec(text)) !== null) {
    const filePath = m[1]?.trim();
    const code = m[2] ?? "";
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    tools.push({
      tool: "write",
      callID: `synthetic-file-${idx++}-${filePath}`,
      status: "completed",
      title: filePath,
      input: { file: filePath, synthetic: true },
      output: code.slice(0, 2000),
      metadata: { synthetic: true, source: "markdown-file-block" },
    });
  }
  return tools;
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
