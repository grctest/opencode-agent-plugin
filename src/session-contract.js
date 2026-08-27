import { extractText, withTimeout } from "./shared.js";
import { extractErrorInfo } from "./logger.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { getConfig } from "./config.js";

/**
 * A single contract for raw opencode session lifecycle: create / prompt / delete.
 * Centralizes DEFAULT-RETRY, timeout, error extraction, and token accounting so
 * no caller has to replicate `client.session.*` plumbing, accept its raw result
 * shape, or decide retry/timeout defaults per call site.
 *
 * All methods resolve with normalized `{ ok, ... , error }` shapes.
 */
export class SessionContract {
  #client;
  #directory;
  #logger;

  /**
   * @param {import("./opencode.js").Client} client Raw opencode SDK client.
   * @param {string} directory Working directory for the SDK calls.
   * @param {import("./logger.js").Logger} [logger] Logger used for throttled delete warnings.
   */
  constructor(client, directory, logger = null) {
    this.#client = client;
    this.#directory = directory;
    this.#logger = logger;
  }

  /**
   * Creates an ephemeral child session. Retries use config defaults.
   * @param {{ title: string, parentID?: string, onRetry?: (err, attempt, delay) => void }} payload
   * @returns {Promise<{ ok: true, sessionId: string, error: null } | { ok: false, sessionId: null, error: Error }>}
   */
  async create({ title, parentID, onRetry = null }) {
    const config = getConfig();
    try {
      const sessionId = await withRetry(async () => {
        const result = await this.#client.session.create({
          body: { parentID, title },
          query: { directory: this.#directory },
        });

        if (!result.data || result.error) {
          throw new Error(`Failed to create session "${title}": ${result.error?.message || "unknown error"}`);
        }

        return result.data.id;
      }, {
        maxAttempts: config.maxRetryAttempts ?? 3,
        baseDelayMs: config.retryBaseDelayMs ?? 1000,
        maxDelayMs: config.retryMaxDelayMs ?? 5000,
        retryable: isRetryableError,
        onRetry,
      });

      return { ok: true, sessionId, error: null };
    } catch (error) {
      return { ok: false, sessionId: null, error };
    }
  }

  /**
   * Sends a single stateless prompt to an existing session. Applies a timeout
   * (default: `config.agentTimeoutMs`; override with `timeoutMs`).
   * @param {{
   *   sessionId: string,
   *   system: string,
   *   model: unknown,
   *   temperature?: number,
   *   parts?: Array<{ type: string; text: string }>,
   *   tools?: Record<string, boolean>,
   *   toolChoice?: string, // NOTE: PromptInput has no tool_choice field (see packages/opencode/src/session/prompt.ts:1499); server ignores this. Kept for future compat; toolChoice is actually determined by format ("required" for json_schema) and defaults to "auto". Evidence/vote "required"/"none" hints are prompt-enforced, not API-enforced.
   *   timeoutMs?: number,
   * }} payload
   * @returns {Promise<{ ok: true, data: object, text: string, tokens?: { input: number; output: number } | null, error: null } | { ok: false, data: null, text: "", tokens: null, error: Error }>}
   */
  async prompt({ sessionId, system, model, temperature, parts, tools, toolChoice, timeoutMs }) {
    const config = getConfig();
    try {
      // Note: SessionPromptData (packages/sdk/js/src/gen/types.gen.ts:2588) has no tool_choice field; PromptInput (packages/opencode/src/session/prompt.ts:1499) also has no tool_choice — server derives toolChoice from format/isLastStep. We do NOT send tool_choice to avoid unknown-field noise.
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: sessionId },
          body: {
            system,
            model,
            temperature,
            parts: parts ?? [{ type: "text", text: "" }],
            tools: tools ?? {},
          },
          query: { directory: this.#directory },
        }),
        timeoutMs ?? config.agentTimeoutMs,
      );

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      // The opencode SDK returns HTTP 200 {info, parts} even when the provider
      // fails mid-generation — the real cause lands in AssistantMessage.error.
      // Surface it as a thrown error (with .status set) so retry/model-fallback
      // machinery engages instead of the failure being masked as empty text.
      const assistantError = result.data?.info?.error;
      if (assistantError) {
        const d = assistantError.data ?? {};
        const err = new Error(`${assistantError.name}: ${d.message || JSON.stringify(d)}`);
        if (d.statusCode) err.status = d.statusCode;
        // Preserve partial response (may contain already-executed ToolParts)
        err.partialData = result.data ?? null;
        throw err;
      }

      return {
        ok: true,
        data: result.data,
        text: extractText(result.data) ?? "",
        tokens: result.data?.tokens ?? null,
        error: null,
      };
    } catch (error) {
      // Audit-first: preserve whatever partial data the server returned so
      // already-executed tool calls are not silently lost on failure.
      // Callers treat falsy data as "nothing", so this is backward-compatible;
      // salvage-capable callers can extract ToolParts from partial data.
      return { ok: false, data: error?.partialData ?? null, text: "", tokens: null, error };
    }
  }

  /**
   * Best-effort deletion of a session. Never rejects; failures are logged once
   * per session via the throttled warn path.
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, error: Error | null }>}
   */
  async delete(sessionId) {
    try {
      await this.#client.session.delete({
        path: { id: sessionId },
        query: { directory: this.#directory },
      });
      return { ok: true, error: null };
    } catch (error) {
      this.#logger?.warnThrottled(
        `session-delete`,
        "session_delete_failed",
        `Failed to delete session ${sessionId}`,
        extractErrorInfo(error),
        undefined,
      );
      return { ok: false, error };
    }
  }

  /**
   * Lists messages of a session (audit 14 PV2 human-in-the-loop). Best-effort:
   * resolves { ok: false } on any failure so callers can skip steering checks
   * without crashing the meeting loop.
   * @param {string} sessionId
   * @returns {Promise<{ ok: boolean, messages: Array<{id: string, role: string, text: string}>, error: Error | null }>}
   */
  async messages(sessionId) {
    try {
      const result = await this.#client.session.messages({
        path: { id: sessionId },
        query: { directory: this.#directory },
      });
      if (result.error) {
        return { ok: false, messages: [], error: new Error(result.error?.message || "messages failed") };
      }
      const raw = Array.isArray(result.data) ? result.data : (result.data?.messages ?? []);
      const messages = [];
      for (const m of raw) {
        const text = extractText(m);
        if (!text) continue;
        messages.push({ id: m.id ?? `${m.role ?? "?"}:${text.slice(0, 32)}`, role: m.role ?? "user", text });
      }
      return { ok: true, messages, error: null };
    } catch (error) {
      return { ok: false, messages: [], error };
    }
  }
}