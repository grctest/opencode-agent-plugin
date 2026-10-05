import { extractText } from "./shared.js";
import { extractErrorInfo } from "./logger.js";
import { withRetry, isRetryableError, isHardRateLimitError, classifyRateLimitError, classifyInputRejectionError } from "./utils/retry.js";
import { trimPayloadToBudget } from "./utils/context-budget.js";
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
  #resolveContextLimit;
  /** Set by onPromptTrimmed; called with (charsTrimmed, model) so a trim is observable. */
  onPromptTrimmed = null;
  /** Set by the orchestrator; called with (classification, model) on context/token rejection. */
  onInputRejected = null;

  /**
   * @param {import("./opencode.js").Client} client Raw opencode SDK client.
   * @param {string} directory Working directory for the SDK calls.
   * @param {import("./logger.js").Logger} [logger] Logger used for throttled delete warnings.
   * @param {{ resolveContextLimit?: (model: any) => number|null }} [opts]
   *   resolveContextLimit returns the input context window (tokens) for the
   *   model this call is about to use, or null when unknown (no guard). This is
   *   what makes the limit per-model: windows range from 32k to 1M, so a single
   *   global ceiling would be wrong for most calls.
   */
  constructor(client, directory, logger = null, opts = {}) {
    this.#client = client;
    this.#directory = directory;
    this.#logger = logger;
    this.#resolveContextLimit = typeof opts?.resolveContextLimit === "function"
      ? opts.resolveContextLimit
      : null;
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
    * Long-but-alive calls are protected by an optional liveness probe: when
    * `isAlive` reports fresh progress at the deadline, the deadline slides by
    * one more budget (up to an absolute cap) instead of failing. `onHeartbeat`
    * ticks while pending so callers can touch the stall watchdog even with
    * zero observable progress.
    * @param {{
    *   sessionId: string,
    *   system: string,
    *   model: unknown,
    *   parts?: Array<{ type: string; text: string }>,
    *   tools?: Record<string, boolean>,
    *   toolChoice?: string, // NOTE: PromptInput has no tool_choice field (see packages/opencode/src/session/prompt.ts:1499); server ignores this. Kept for future compat; toolChoice is actually determined by format ("required" for json_schema) and defaults to "auto". Evidence/vote "required"/"none" hints are prompt-enforced, not API-enforced.
    *   timeoutMs?: number,
    *   signal?: AbortSignal,
    *   heartbeatMs?: number,
    *   isAlive?: (info: { elapsedMs: number, extensions: number, sessionId: string }) => boolean | Promise<boolean>,
    *   onHeartbeat?: (info: { elapsedMs: number, extensions: number, sessionId: string, deadlineMs: number, absoluteDeadlineMs: number }) => void,
    *   maxTotalMs?: number,
    * }} payload
    * @returns {Promise<{ ok: true, data: object, text: string, tokens?: { input: number; output: number } | null, error: null } | { ok: false, data: null, text: "", tokens: null, error: Error }>}
    */
   async prompt({ sessionId, system, model, parts, tools, toolChoice, timeoutMs, signal, heartbeatMs, isAlive, onHeartbeat, maxTotalMs }) {
    const config = getConfig();
    try {
      if (signal?.aborted) {
        const err = new DOMException("Aborted", "AbortError");
        err.cause = "AbortSignal already aborted before prompt";
        throw err;
      }
      // Per-model input ceiling. Every LLM call funnels through here, so this
      // is the one place that guarantees no prompt exceeds the window of the
      // model it is about to use. Callers that can trim by block priority
      // (the agent turn) do so before calling; anything that arrives over
      // budget here is cut as a backstop, and the trim is reported.
      let outSystem = system;
      let outParts = parts ?? [{ type: "text", text: "" }];
      let outTools = tools ?? {};
      if (this.#resolveContextLimit) {
        const limit = this.#resolveContextLimit(model);
        if (limit !== null && limit !== undefined) {
          const available = [{ providerID: model?.providerID, modelID: model?.modelID, limit: { context: limit } }];
          const trimmed = trimPayloadToBudget({ system: outSystem, parts: outParts, tools: outTools }, model, available);
          if (trimmed) {
            outSystem = trimmed.system;
            outParts = trimmed.parts;
            try { this.onPromptTrimmed?.(trimmed.trimmedChars, model); } catch { /* reporting must never break a prompt */ }
          }
        }
      }

      const promptPromise = this.#client.session.prompt({
        path: { id: sessionId },
        body: {
          system: outSystem,
          model,
          parts: outParts,
          tools: outTools,
        },
        query: { directory: this.#directory },
      });
      const abortSession = async () => {
        try {
          if (typeof this.#client.session.abort === "function") {
            await this.#client.session.abort({ path: { id: sessionId }, query: { directory: this.#directory } });
          }
        } catch {}
      };
      const effectiveTimeout = timeoutMs ?? config.agentTimeoutMs;
      const shouldTimeout = Number.isFinite(effectiveTimeout) && effectiveTimeout > 0;
      // Sliding-deadline liveness: a fired deadline is deferred while the
      // caller observes fresh provider progress (inline loom tools landing in
      // the weave, message growth, …), bounded by an absolute cap so a
      // trickling-but-stuck call still dies. Without isAlive this is a plain
      // wall-clock timeout exactly as before.
      const tuning = config?.tuning ?? {};
      const tickRaw = heartbeatMs ?? tuning.PROMPT_LIVENESS_TICK_MS ?? 30_000;
      const tickMs = Number.isFinite(tickRaw) && tickRaw > 0 ? tickRaw : 0;
      const multipleRaw = tuning.PROMPT_LIVENESS_MAX_MULTIPLE ?? 3;
      const multiple = Number.isFinite(multipleRaw) && multipleRaw >= 1 ? multipleRaw : 3;
      const startMs = Date.now();
      const absoluteDeadlineMs = shouldTimeout
        ? (Number.isFinite(maxTotalMs) && maxTotalMs > 0
            ? startMs + maxTotalMs
            : startMs + Math.max(1, effectiveTimeout) * multiple)
        : Infinity;
      let deadlineMs = shouldTimeout ? startMs + effectiveTimeout : Infinity;
      let extensions = 0;
      let settled = false;
      let timer = null;
      let heartbeatTimer = null;
      let abortHandler = null;
      let rejectTimeout = null;
      const hasProbe = typeof isAlive === "function";
      const armTimer = (delayMs) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void onDeadline(), Math.max(1, delayMs));
        timer.unref?.();
      };
      const onDeadline = async () => {
        if (settled) return;
        const now = Date.now();
        let alive = false;
        if (hasProbe) {
          try {
            alive = !!(await isAlive({ elapsedMs: now - startMs, extensions, sessionId }));
          } catch { alive = false; }
        }
        if (alive && now < absoluteDeadlineMs && extensions < 100) {
          extensions++;
          deadlineMs = Math.min(now + effectiveTimeout, absoluteDeadlineMs);
          try {
            this.#logger?.info(
              "prompt_timeout_deferred",
              `Session ${sessionId} showed progress after ${Math.round((now - startMs) / 1000)}s — deadline extended (${extensions}×, +${Math.round((deadlineMs - now) / 1000)}s of ${Math.round((absoluteDeadlineMs - startMs) / 1000)}s cap)`,
              { sessionId, elapsedMs: now - startMs, extensions },
            );
          } catch {}
          armTimer(deadlineMs - Date.now());
          return;
        }
        void abortSession();
        const elapsed = Date.now() - startMs;
        const error = new Error(
          `Session prompt timed out after ${elapsed}ms (budget ${effectiveTimeout}ms${extensions ? `, ${extensions} liveness extension(s)` : ""})`,
        );
        error.name = "TimeoutError";
        error.timeoutMs = effectiveTimeout;
        error.elapsedMs = elapsed;
        error.livenessExtensions = extensions;
        settled = true;
        try { rejectTimeout?.(error); } catch {}
      };
      const guards = [];
      if (signal) {
        guards.push(new Promise((_, reject) => {
          abortHandler = () => {
            void abortSession();
            reject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abortHandler, { once: true });
        }));
      }
      if (shouldTimeout) {
        guards.push(new Promise((_, reject) => {
          rejectTimeout = reject;
          armTimer(deadlineMs - Date.now());
        }));
        if (tickMs > 0 && typeof onHeartbeat === "function") {
          heartbeatTimer = setInterval(() => {
            if (settled) return;
            try {
              const r = onHeartbeat({
                elapsedMs: Date.now() - startMs,
                extensions,
                sessionId,
                deadlineMs,
                absoluteDeadlineMs,
              });
              if (r && typeof r.catch === "function") r.catch(() => {});
            } catch {}
          }, tickMs);
          heartbeatTimer.unref?.();
        }
      }
      const raced = Promise.race([promptPromise, ...guards]).finally(() => {
        settled = true;
        if (timer) clearTimeout(timer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (signal && abortHandler) {
          try { signal.removeEventListener("abort", abortHandler); } catch {}
        }
      });
      const result = await raced;

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
        err.providerError = assistantError.name ?? null;
        err.providerData = d;
        err.rateLimitClassification = classifyRateLimitError(err);
        err.inputRejectionClassification = classifyInputRejectionError(err);
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
      if (error && !error.rateLimitClassification) {
        error.rateLimitClassification = classifyRateLimitError(error);
      }
      if (error && !error.inputRejectionClassification) {
        error.inputRejectionClassification = classifyInputRejectionError(error);
      }
      // An input rejection is the guard's last line of defence, so it is
      // reported at the point it happens rather than only as a failed turn.
      if (error?.inputRejectionClassification) {
        try { this.onInputRejected?.(error.inputRejectionClassification, model); } catch { /* reporting must not mask the error */ }
      }
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