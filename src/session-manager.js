import { extractErrorInfo } from "./logger.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { getConfig } from "./config.js";
import { SessionContract } from "./session-contract.js";

const MAX_PROGRESS_FAILURES_BEFORE_ALERT = 3;

// Severity prefixes for progress lines (audit 07 EH5): machine-filterable
// `[info]`/`[warn]`/`[error]` markers ahead of the human-facing emoji.
const SEVERITY_PREFIXES = { info: "[info]", warn: "[warn]", error: "[error]" };

// Empty-but-OK responses are treated as transient failures: retried with the
// same backoff as network/provider errors instead of propagating blank text.
function isEmptyResponseError(err) {
  return err?.name === "EmptyResponseError";
}

export class SessionManager {
  #client;
  #directory;
  #parentSessionId;
  #logger;
  #contract;
  #progressFailureCount = 0;
  #progressAlerted = false;
  #sessionMeetingMap = new Map();
  #orchestratorSessionId = null;
  #database = null;

  constructor(client, directory, parentSessionId, logger = null) {
    this.#client = client;
    this.#directory = directory;
    this.#parentSessionId = parentSessionId;
    this.#logger = logger;
    this.#contract = new SessionContract(client, directory, logger);
  }

  setDatabase(database) {
    this.#database = database;
  }

  /**
   * Shared session contract used by all prompt/delete call sites so behavior
   * (timeout, retry, error normalization, throttled delete warnings) is unified.
   */
  getContract() {
    return this.#contract;
  }

  getParentSessionId() {
    return this.#parentSessionId;
  }

  /**
   * Fetches user messages posted to the parent session after `sinceId`
   * (audit 14 PV2 human-in-the-loop). Best-effort — returns [] on failure.
   * @param {string|null} sinceId
   * @returns {Promise<Array<{id: string, role: string, text: string}>>}
   */
  async getParentUserMessages(sinceId = null) {
    if (!this.#parentSessionId) return [];
    const { ok, messages } = await this.#contract.messages(this.#parentSessionId);
    if (!ok) return [];
    let seen = false;
    return messages.filter((m) => {
      if (m.role !== "user") return false;
      if (sinceId == null) return true;
      if (seen) return true;
      if (m.id === sinceId) {
        seen = true;
        return false;
      }
      return false;
    });
  }

  /**
   * Maps an ephemeral session ID to its meeting ID for fast lookup
   * during tool execution. Populated when sessions are created for a meeting.
   */
  registerSessionMeeting(sessionId, meetingId) {
    this.#sessionMeetingMap.set(sessionId, meetingId);
  }

  /**
   * Resolves an ephemeral session ID to its meeting ID.
   * @param {string} sessionId
   * @returns {string|null}
   */
  resolveMeetingId(sessionId) {
    return this.#sessionMeetingMap.get(sessionId) ?? null;
  }

  /**
   * Cleans up session→meeting mappings for a given session.
   */
  unregisterSession(sessionId) {
    this.#sessionMeetingMap.delete(sessionId);
  }

  async #createSessionWithRetry(title, onRetry = null) {
    const { ok, sessionId, error } = await this.#contract.create({
      title,
      parentID: this.#parentSessionId,
      onRetry,
    });
    if (!ok) throw error;
    return sessionId;
  }

  async createChildSession(participant) {
    return this.#createSessionWithRetry(
      `Loom · ${participant.config.name} (${participant.config.tier})`,
      (err, attempt, delay) => {
        this.#logger?.warn("session_create_retry", `Retrying session creation for ${participant.config.name} (attempt ${attempt + 1})`, { delay, error: err.message });
      }
    );
  }

  async createSynthesizerSession(synthesizer) {
    return this.#createSessionWithRetry(`Loom · Synthesizer (${synthesizer.config.tier})`);
  }

  /**
   * Creates a short-lived ephemeral session for a single agent turn.
   * The caller is responsible for deleting it after use.
   */
  async createEphemeralSession(participant) {
    return this.#createSessionWithRetry(
      `Loom · Ephemeral · ${participant.config.name}`,
      (err, attempt, delay) => {
        this.#logger?.warn("ephemeral_session_retry", `Retrying ephemeral session for ${participant.config.name} (attempt ${attempt + 1})`, { delay, error: err.message });
      }
    );
  }

  /**
   * Best-effort deletion of an ephemeral session.
   */
  async deleteEphemeralSession(sessionId) {
    const { ok } = await this.#contract.delete(sessionId);
    this.unregisterSession(sessionId);
  }

  /**
   * Shared interaction-engine primitive (audit 10 MA1): creates an ephemeral
   * session for `participant`, prompts it, then always deletes/unregisters the
   * session. The loom_* inline tools previously hand-rolled this create →
   * register → prompt → unregister → delete dance per call site.
   * @param {Object} participant - participant-like ({ config: { name, ... } })
   * @param {Object} promptOpts - passed straight to SessionContract.prompt
   * @param {string|null} [meetingId=null] - optional meeting registration
   * @returns {Promise<{ ok: boolean, data: unknown, error: Error | null }>}
   */
  async runEphemeralPrompt(participant, promptOpts, meetingId = null) {
    let sessionId = null;
    try {
      sessionId = await this.createEphemeralSession(participant);
      if (meetingId) this.registerSessionMeeting(sessionId, meetingId);
      // Honor context.abort if provided in promptOpts.signal/abort (guide: pass context.abort)
      const { signal, abort, ...restOpts } = promptOpts;
      const effectiveSignal = signal ?? abort ?? null;
      // SessionContract currently ignores signal (PromptInput has no tool_choice/signal), but we forward for future compat
      // and use it to race the prompt if abort fires
      let res;
      if (effectiveSignal) {
        const abortPromise = new Promise((_, reject) => {
          if (effectiveSignal.aborted) reject(new DOMException("Aborted", "AbortError"));
          else effectiveSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        res = await Promise.race([
          this.getContract().prompt({ sessionId, ...restOpts }),
          abortPromise.then(() => { throw new DOMException("Aborted", "AbortError"); }),
        ]).catch((err) => ({ ok: false, data: null, error: err }));
        // If abort raced, ensure we still clean up
        if (res && res.error && res.error.name === "AbortError") throw res.error;
      } else {
        res = await this.getContract().prompt({ sessionId, ...restOpts });
      }
      return res;
    } catch (err) {
      return { ok: false, data: null, error: err };
    } finally {
      if (sessionId) {
        this.unregisterSession(sessionId);
        await this.deleteEphemeralSession(sessionId).catch(() => {});
      }
    }
  }

  /**
   * Prompts via a persistent orchestrator session (Option D) — one session for all
   * orchestrator calls in a meeting. Falls back to ephemeral if persistent creation fails.
   * @returns {Promise<{ text: string, tokens?: { input: number; output: number } }>}
   */
  async promptOrchestrator(system, model, message) {
    // Try persistent session first (Option D)
    let sessionId = this.#orchestratorSessionId;
    if (!sessionId) {
      try {
        sessionId = await this.#createSessionWithRetry("Loom · Orchestrator (persistent)");
        this.#orchestratorSessionId = sessionId;
      } catch {
        // Fallback to ephemeral per-prompt (previous behavior)
        sessionId = await this.#createSessionWithRetry("Loom · Orchestrator (ephemeral)");
        try {
          const result = await withRetry(async () => {
            const res = await this.#contract.prompt({
              sessionId,
              system,
              model,
              tools: {},
              parts: [{ type: "text", text: message }],
            });
            if (!res.ok) throw res.error;
            if (!String(res.text ?? "").trim()) {
              const err = new Error("Empty response from orchestrator LLM");
              err.name = "EmptyResponseError";
              throw err;
            }
            return res;
          }, {
            maxAttempts: getConfig().maxRetryAttempts,
            baseDelayMs: getConfig().retryBaseDelayMs,
            maxDelayMs: getConfig().retryMaxDelayMs,
            retryable: (err) => isRetryableError(err) || isEmptyResponseError(err),
          });
          return { text: result.text, tokens: result.tokens };
        } finally {
          this.deleteEphemeralSession(sessionId);
        }
      }
    }
    // Persistent path — reuse session, do not delete
    const result = await withRetry(async () => {
      const res = await this.#contract.prompt({
        sessionId,
        system,
        model,
        tools: {},
        parts: [{ type: "text", text: message }],
      });
      if (!res.ok) throw res.error;
      if (!String(res.text ?? "").trim()) {
        const err = new Error("Empty response from orchestrator LLM");
        err.name = "EmptyResponseError";
        throw err;
      }
      return res;
    }, {
      maxAttempts: getConfig().maxRetryAttempts,
      baseDelayMs: getConfig().retryBaseDelayMs,
      maxDelayMs: getConfig().retryMaxDelayMs,
      retryable: (err) => isRetryableError(err) || isEmptyResponseError(err),
    });
    return { text: result.text, tokens: result.tokens };
  }

  async deleteSession(sessionId) {
    await this.#contract.delete(sessionId);
  }

  async deleteOrchestratorSession() {
    if (this.#orchestratorSessionId) {
      try { await this.#contract.delete(this.#orchestratorSessionId); } catch {}
      this.#orchestratorSessionId = null;
    }
  }

  /**
   * Posts a progress line to the parent session (audit 07 EH5 severity contract).
   * @param {string} message
   * @param {"info"|"warn"|"error"} [severity="info"] — rendered as a `[severity]`
   *   prefix so downstream consumers can filter without emoji parsing.
   */
  postProgress(message, severity = "info") {
    const session = this.#client.session;
    if (typeof session.promptAsync !== "function") return;
    const prefix = SEVERITY_PREFIXES[severity] ?? "";
    const text = prefix ? `${prefix} ${message}` : message;
    session.promptAsync({
      path: { id: this.#parentSessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text }],
      },
      query: { directory: this.#directory },
    }).catch((err) => {
      this.#progressFailureCount++;
      if (this.#progressFailureCount >= MAX_PROGRESS_FAILURES_BEFORE_ALERT && !this.#progressAlerted) {
        this.#progressAlerted = true;
        this.#logger?.error(
          "progress_stream_down",
          `Failed to post progress ${MAX_PROGRESS_FAILURES_BEFORE_ALERT}+ times — live status updates will not appear in the chat`,
          extractErrorInfo(err),
        );
        // Persist degraded state so dashboard timeline shows the gap
        try {
          this.#database?.addOrchestratorMessage("progress_down", "assistant", "⚠️ Progress stream down — deliberation continues, dashboard not live.", null);
        } catch {}
      } else {
        this.#logger?.warn("progress_post_failed", "Failed to post progress message", extractErrorInfo(err));
      }
      // Reset failure count after a successful interval to allow recovery
      if (this.#progressFailureCount >= MAX_PROGRESS_FAILURES_BEFORE_ALERT) {
        setTimeout(() => {
          this.#progressFailureCount = 0;
          this.#progressAlerted = false;
        }, 60000);
      }
    });
  }
}
