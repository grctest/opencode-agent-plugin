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

  async createChildSession(participant) {
    return withRetry(async () => {
      const result = await this.#client.session.create({
        body: {
          parentID: this.#parentSessionId,
          title: `Loom · ${participant.config.name} (${participant.config.tier})`,
        },
        query: { directory: this.#directory },
      });

      if (!result.data || result.error) {
        throw new Error(`Failed to create session for ${participant.config.name}: ${result.error?.message || "unknown error"}`);
      }

      return result.data.id;
    }, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      retryable: isRetryableError,
      onRetry: (err, attempt, delay) => {
        this.#logger?.warn("session_create_retry", `Retrying session creation for ${participant.config.name} (attempt ${attempt + 1})`, { delay, error: err.message });
      }
    });
  }

  async createSynthesizerSession(synthesizer) {
    return withRetry(async () => {
      const result = await this.#client.session.create({
        body: {
          parentID: this.#parentSessionId,
          title: `Loom · Synthesizer (${synthesizer.config.tier})`,
        },
        query: { directory: this.#directory },
      });

      if (!result.data || result.error) {
        throw new Error(`Failed to create synthesizer session: ${result.error?.message || "unknown error"}`);
      }

      return result.data.id;
    }, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      retryable: isRetryableError,
    });
  }

  async createOrchestratorSession() {
    return withRetry(async () => {
      const result = await this.#client.session.create({
        body: {
          parentID: this.#parentSessionId,
          title: "Loom · Orchestrator",
        },
        query: { directory: this.#directory },
      });

      if (!result.data || result.error) {
        throw new Error(`Failed to create orchestrator session: ${result.error?.message || "unknown error"}`);
      }

      return result.data.id;
    }, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      retryable: isRetryableError,
    });
  }

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
      return extractText(result.data);
    }, {
      maxAttempts: getConfig().maxRetryAttempts,
      baseDelayMs: getConfig().retryBaseDelayMs,
      maxDelayMs: getConfig().retryMaxDelayMs,
      retryable: isRetryableError,
    });
  }

  async recreateSession(participant, db) {
    try {
      const newSessionId = await this.createChildSession(participant);
      participant.session_id = newSessionId;
      participant.session_version = (participant.session_version ?? 0) + 1;
      if (db) {
        db.setParticipantSessionId(participant.config.id, newSessionId);
      }
      participant.status = "listening";
      if (db) {
        db.setParticipantStatus(participant.config.id, "listening");
      }
      return true;
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logger?.error("session_recreate_failed", `Failed to recreate session for ${participant.config.name}`, info);
      return false;
    }
  }

  async promptParent(system, model, message, temperature) {
    return withRetry(async () => {
      const body = { system, model, tools: {}, parts: [{ type: "text", text: message }] };
      if (temperature !== undefined) body.temperature = temperature;
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: this.#parentSessionId },
          body,
          query: { directory: this.#directory },
        }),
        getConfig().agentTimeoutMs,
      );
      if (result.error) throw new Error(JSON.stringify(result.error));
      return extractText(result.data);
    }, {
      maxAttempts: getConfig().maxRetryAttempts,
      baseDelayMs: getConfig().retryBaseDelayMs,
      maxDelayMs: getConfig().retryMaxDelayMs,
      retryable: isRetryableError,
    });
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
    });
  }
}
