import { extractText } from "./shared.js";
import { extractErrorInfo } from "./logger.js";

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
  }

  async createSynthesizerSession(synthesizer) {
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
  }

  async createOrchestratorSession() {
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
  }

  async promptOrchestrator(system, model, message) {
    const result = await this.#client.session.prompt({
      path: { id: this.#orchestratorSessionId },
      body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
      query: { directory: this.#directory },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    return extractText(result.data);
  }

  async recreateSession(participant, db) {
    try {
      const newSessionId = await this.createChildSession(participant);
      participant.session_id = newSessionId;
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
    const body = { system, model, tools: {}, parts: [{ type: "text", text: message }] };
    if (temperature !== undefined) body.temperature = temperature;
    const result = await this.#client.session.prompt({
      path: { id: this.#parentSessionId },
      body,
      query: { directory: this.#directory },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    return extractText(result.data);
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
      this.#logger?.warn("progress_post_failed", "Failed to post progress message", extractErrorInfo(err));
    });
  }

  postRaw(message) {
    const session = this.#client.session;
    if (typeof session.promptAsync !== "function") return;
    session.promptAsync({
      path: { id: this.#parentSessionId },
      body: {
        noReply: true,
        parts: [{ type: "text", text: message }],
      },
      query: { directory: this.#directory },
    }).catch(() => {});
  }
}
