import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isAgentSessionClient } from "./client-types.js";
import { deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId, getDbPathForMeeting, getDatabasesBySessionId, loadSessionIndex, MeetingDatabase } from "./database.js";
import { startDashboard } from "./dashboard/server.js";
import { createKnitHandler } from "./handlers/knit-handler.js";
import { createConfig, getConfigSource, setDefaultConfigDirectory } from "./config.js";
import { Logger } from "./logger.js";
import { VectorIndex } from "./services/vector-index.js";
import { resolveLoomBaseDir } from "./paths.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "./services/model-manager.js";
import { buildQueryPrompt, buildEvidencePrompt, buildVotePrompt, buildSummonPrompt } from "./prompts/interaction-prompts.js";
import * as sharedVoteTally from "./utils/vote-tally.js";
import { degrade } from "./utils/degrade.js";
import { createAgentTools } from "./plugin/agent-tools.js";
import { createPluginReturn } from "./plugin/return.js";
import { createResolveMeeting } from "./plugin/resolve-meeting.js";
import { createLifecycleHandlers } from "./plugin/lifecycle.js";
// Static hoists (audit 10 MA4): these were previously `await import()` inside
// tool handlers on every call — pure overhead for cycle-free modules.
import { extractAgentResponse, mapToolResults } from "./shared.js";
import { getPersonas } from "./composer.js";
import { getHighestTierModel } from "./services/model-service.js";
import { getMeetingDbPath } from "./paths.js";
import { DashboardApi } from "./dashboard/api.js";

export const Loom = async (input) => {
  const { client, directory } = input;

  if (!isAgentSessionClient(client)) {
    throw new Error("Loom plugin requires a compatible opencode client with session.create, session.prompt, session.message, and provider API access.");
  }

  setDefaultConfigDirectory(directory);
  const config = createConfig(directory);
  loadSessionIndex(directory);
  const logger = new Logger();

  const configSource = getConfigSource();
  logger.info(
    "config",
    configSource
      ? `Loom config loaded from ${configSource}`
      : "No Loom config file found — using defaults",
  );

  const warnings = config.getWarnings();
  for (const warning of warnings) {
    logger.warn("config_validation", warning);
  }

  // Initialize the real embedding model in the plugin process so every
  // semantic feature (vector search, reflection targeting, room composition)
  // uses real embeddings rather than placeholder noise. This mirrors the
  // dashboard's initEmbeddingModel(), which previously was the only place the
  // model got loaded. Failures are non-fatal: semantic features degrade visibly.
  // Single config-driven startup (audit 06 V4): honor the configured model here,
  // once — orchestrator consumes whatever this loads. Use the config instance
  // already created with the session directory (not a global no-dir cache).
  const startupValues = config.get();
  const resolvedModel = startupValues.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const resolvedQuant = startupValues.embeddingQuant ?? DEFAULT_EMBEDDING_QUANT;
  const { ensureEmbedderInitialized, getEmbeddingDim, isEmbedderInitialized } = await import("./services/embedding-service.js");
  const embedInitPromise = ensureEmbedderInitialized(resolvedModel, resolvedQuant)
    .then(() => {
      logger.info("embedder_initialized", `Embedding model loaded: ${resolvedModel} (${getEmbeddingDim()}d)`);
    })
    .catch((err) => {
      logger.warn(
        "embedder_init_failed",
        `Failed to initialize embedding model — semantic features (vector search, reflection targeting, room composition) will be unavailable: ${err.message}`,
      );
    });
  // Expose for handlers to await when composition is imminent
  const awaitEmbedderReady = async (timeoutMs = 5000) => {
    if (isEmbedderInitialized()) return true;
    try {
      await Promise.race([
        embedInitPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("embedder init timeout")), timeoutMs)),
      ]);
      return isEmbedderInitialized();
    } catch { return isEmbedderInitialized(); }
  };

  const activeLooms = new Map();
  let activeDashboard = null;
  const meetingResolveCache = new Map(); // sessionID -> { meeting, at }
  const RESOLVE_CACHE_TTL_MS = 30000;
  const RESOLVE_CACHE_MAX = 100;

  /**
   * Resolves an ephemeral session ID to its Loom meeting database path.
   * Used by agent tools to find which meeting the current session belongs to.
   * Cached to avoid readdirSync scan per tool call.
   */
  const _resolveMeetingFactory = createResolveMeeting(directory, meetingResolveCache);
  const resolveMeeting = (sessionID) => _resolveMeetingFactory(sessionID, client);
  const agentTools = createAgentTools({ config, resolveMeeting, activeLooms, directory });

  const { setupProcessHandlers } = createLifecycleHandlers(activeLooms);
  setupProcessHandlers();
  const { handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels } = createKnitHandler(client, directory, activeLooms, agentTools);

  const activeDashboardRef = { current: activeDashboard };
  const pluginReturn = createPluginReturn({ activeLooms, activeDashboardRef, directory, config, handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels, agentTools });
  return pluginReturn;
};

export { MeetingOrchestrator } from "./orchestrator.js";
export { formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  getRightsForTier,
} from "./shared.js";
