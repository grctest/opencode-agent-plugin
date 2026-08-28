/** Extracts text content from an LLM response data object. */
export function extractText(data) {
  if (!data?.parts) return null;
  const textParts = data.parts.filter((p) => p.type === "text");
  const content = textParts.map((p) => p.text).join("\n").trim();
  return content.length > 0 ? content : null;
}

/**
 * Extracts the agent's response from prompt data, handling all Part types.
 * Returns text plus any tool results. For audit completeness we preserve
 * ALL non-ignored TextParts (joined) so citations in pre-tool chatter
 * (e.g., "Source: https://…") are not silently lost — the dashboard can
 * then show the full evidence trail. The final segment is still primary,
 * but pre-tool text is retained for debugging (stored in allTexts).
 */
export function extractAgentResponse(data) {
  if (!data?.parts) return { text: null, toolResults: [], reasoning: null, allTexts: [] };

  let lastText = null;
  const allTexts = [];
  const toolResults = [];
  const reasoningParts = [];

  for (const part of data.parts) {
    switch (part.type) {
      case "text":
        if (!part.ignored && part.text) {
          allTexts.push(part.text);
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
          if (!status) {
            // Audit-first: never silently drop a ToolPart. Record it as "pending"
            // so the dashboard can show an attempted call even when the stream
            // ended before terminal state.
            toolResults.push({
              tool: tool.tool,
              callID: tool.callID,
              status: "pending",
              title: tool.state?.title,
              input: tool.state?.input ?? {},
              metadata: tool.state?.metadata ?? null,
              error: "ToolPart captured without terminal state (pending/unknown)",
            });
            break;
          }
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


      case "subtask":
        // Subtask result — capture text if available
        if (part.text) {
          allTexts.push(part.text);
          lastText = part.text;
        }
        break;

      default:
        // Audit-first: unknown part types are logged once so a renamed/future
        // part type (e.g. "tool_use") never silently zeroes the Tool use tab.
        if (!extractAgentResponse._warnedTypes) extractAgentResponse._warnedTypes = new Set();
        if (!extractAgentResponse._warnedTypes.has(part.type)) {
          console.warn(`[loom] extractAgentResponse encountered unknown part type "${part.type}" — not captured as tool or text`);
          extractAgentResponse._warnedTypes.add(part.type);
        }
        break;
    }
  }

  // Synthesize file-block tools from markdown fences so file writes are auditable
  // even when the LLM only emitted ```lang file=path``` without a real tool call.
  // Scan ALL text parts (not just last) so pre-tool file= blocks are also captured.
  const textForSynthetic = allTexts.join("\n");
  if (textForSynthetic) {
    const synthetic = extractFileBlockTools(textForSynthetic);
    if (synthetic.length > 0) {
      // Dedup only against exact file-path matches in real tool inputs — a loose
      // substring test over all inputs suppressed legitimate synthetic entries.
      const existingFilePaths = new Set();
      for (const t of toolResults) {
        let inp = t.input;
        try { inp = typeof inp === "string" ? JSON.parse(inp) : inp; } catch {}
        if (inp && typeof inp === "object") {
          for (const key of ["file", "filePath", "path"]) {
            if (typeof inp[key] === "string") existingFilePaths.add(inp[key]);
          }
        }
      }
      for (const st of synthetic) {
        if (!existingFilePaths.has(st.title)) toolResults.push(st);
      }
    }
  }

  return {
    text: lastText,
    reasoning: reasoningParts.join("\n").trim(),
    toolResults,
    allTexts,
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
  // Matches ```<lang> file=<path> up to newline, then code until ```
  // Example: ```js file=src/fizzbuzz-classic.js\nfunction ...``` — strip trailing :42 line suffix
  const fenceRe = /```[^\n]*\bfile\s*=\s*([^\s`"\n:]+)(?::\d+)?[^\n]*\n([\s\S]*?)```/g;
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
      output: code,
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

/** Safe JSON.stringify — never throws; handles BigInt in nested objects. */
function safeStringify(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value, (k, v) => typeof v === "bigint" ? String(v) : v);
  } catch {
    try {
      return JSON.stringify(value, (k, v) => typeof v === "bigint" ? String(v) : v);
    } catch {
      try { return String(value); } catch { return "[unserializable]"; }
    }
  }
}

/**
 * Normalizes raw extractAgentResponse tool results into the stored tool_calls
 * shape. Preserves attempt metadata (status, attempted_tool, input) so the
 * timeline can surface calls that were attempted but failed/invalid.
 * LOSSLESS: stores full input/output/error (no truncation) so every executed
 * tool is auditable. UI may show preview slices but storage is complete.
 */
export function mapToolResults(toolResults) {
  return (toolResults ?? []).map((t) => {
    const error = t.error != null
      ? (typeof t.error === "string" ? t.error : safeStringify(t.error))
      : null;
    // Preserve full fidelity — no slicing. The dashboard can truncate for display,
    // but the DB must retain the complete evidence for audit (per bug-fix requirement).
    return {
      tool: t.tool,
      callID: t.callID,
      status: t.status ?? null,
      attempted_tool: t.attempted_tool ?? null,
      title: t.title ?? null,
      output: t.output != null ? (typeof t.output === "string" ? t.output : safeStringify(t.output)) : null,
      error: error ?? null,
      input: safeStringify(
        typeof t.input === "object" && t.input !== null && Object.keys(t.input).length
          ? t.input
          : (t.input ?? null)
      ),
      metadata: t.metadata ?? null,
    };
  });
}

/** Caps loom synthesis outputs to a 12k char total budget, slicing per-call as needed. */
export function truncateLoomOutputs(loomCalls, maxTotal = 12000, perCallSlice = 3500) {
  let total = 0;
  const out = [];
  for (const tc of loomCalls) {
    const raw = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output);
    const slice = raw.slice(0, perCallSlice);
    if (total + slice.length > maxTotal) {
      const remaining = maxTotal - total;
      if (remaining > 500) out.push({ ...tc, output: slice.slice(0, remaining) + " …[truncated for budget]" });
      break;
    }
    total += slice.length;
    out.push(tc);
  }
  return out;
}

/** Wraps a promise with a timeout. Rejects if the promise doesn't resolve in time. */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
