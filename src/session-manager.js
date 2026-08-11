import { extractText } from "./shared.js";

export class SessionManager {
  #client;
  #directory;
  #parentSessionId;

  constructor(client, directory, parentSessionId) {
    this.#client = client;
    this.#directory = directory;
    this.#parentSessionId = parentSessionId;
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
    } catch {
      return false;
    }
  }

  async promptParent(system, model, message) {
    const result = await this.#client.session.prompt({
      path: { id: this.#parentSessionId },
      body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
      query: { directory: this.#directory },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    return extractText(result.data);
  }

  async postProgress(message) {
    try {
      const session = this.#client.session;
      if (typeof session.promptAsync === "function") {
        await session.promptAsync({
          path: { id: this.#parentSessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: message }],
          },
          query: { directory: this.#directory },
        });
      }
    } catch {
    }
  }
}
