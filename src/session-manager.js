import { extractText, withTimeout } from "./shared.js";
import { extractErrorInfo } from "./logger.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { getConfig } from "./config.js";

const MAX_PROGRESS_FAILURES_BEFORE_ALERT = 3;

export class SessionManager {
  #client;
  #directory;
  #parentSessionId;
  #logger;
  #progressFailureCount = 0;
  #progressAlerted = false;
  #orchestratorSessionId = null;

  constructor(client, directory, parentSessionId, logger = null) {
    this.#client = client;
    this.#directory = directory;
    this.#parentSessionId = parentSessionId;
    this.#logger = logger;
  }

  setOrchestratorSessionId(sessionId) {
    this.#orchestratorSessionId = sessionId;
  }

  async #createSessionWithRetry(title, onRetry = null) {
    return withRetry(async () => {
      const result = await this.#client.session.create({
        body: {
          parentID: this.#parentSessionId,
          title,
        },
        query: { directory: this.#directory },
      });

      if (!result.data || result.error) {
        throw new Error(`Failed to create session "${title}": ${result.error?.message || "unknown error"}`);
      }

      return result.data.id;
    }, {
      maxAttempts: getConfig().maxRetryAttempts ?? 3,
      baseDelayMs: getConfig().retryBaseDelayMs ?? 1000,
      maxDelayMs: getConfig().retryMaxDelayMs ?? 5000,
      retryable: isRetryableError,
      onRetry,
    });
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

  async createOrchestratorSession() {
    return this.#createSessionWithRetry("Loom · Orchestrator");
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
    try {
      await this.#client.session.delete({
        path: { id: sessionId },
        query: { directory: this.#directory },
      });
    } catch {
      // Best effort — session may already be deleted
    }
  }

  /**
   * Prompts the orchestrator session. Resolves with { text, tokens } so callers can
   * accumulate usage stats. tokens is undefined when the provider omits usage data.
   * @returns {Promise<{ text: string, tokens?: { input: number; output: number } }>}
   */
  async promptOrchestrator(system, model, message) {
    return withRetry(async () => {
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: this.#orchestratorSessionId },
          body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
          query: { directory: this.#directory },
        }),
        getConfig().agentTimeoutMs,
      );
      if (result.error) throw new Error(JSON.stringify(result.error));
      return { text: extractText(result.data), tokens: result.data?.tokens };
    }, {
      maxAttempts: getConfig().maxRetryAttempts,
      baseDelayMs: getConfig().retryBaseDelayMs,
      maxDelayMs: getConfig().retryMaxDelayMs,
      retryable: isRetryableError,
    });
  }

  async deleteSession(sessionId) {
    try {
      await this.#client.session.delete({
        path: { id: sessionId },
        query: { directory: this.#directory },
      });
    } catch {
      // Best effort - session may already be deleted
    }
  }

  postProgress(message) {
    const session = this.#client.session;
    if (typeof session.promptAsync !== "function") return;
    session.promptAsync({
      path: { id: this.#parentSessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: message }],
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
