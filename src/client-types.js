/**
 * @typedef {Object} SessionInfo
 * @property {string} id
 * @property {string} title
 * @property {string} [parentID]
 * @property {string} projectID
 * @property {string} directory
 * @property {string} version
 * @property {{ created: number; updated: number }} time
 */

/**
 * @typedef {Object} PromptResponse
 * @property {import("@opencode-ai/sdk").AssistantMessage} info
 * @property {import("@opencode-ai/sdk").Part[]} parts
 */

/**
 * @typedef {Object} MessageResponse
 * @property {import("@opencode-ai/sdk").UserMessage | import("@opencode-ai/sdk").AssistantMessage} info
 * @property {import("@opencode-ai/sdk").Part[]} parts
 */

/**
 * @typedef {Object} ProviderModel
 * @property {string} id
 * @property {string} name
 * @property {string} status
 * @property {{ input: number; output: number; cache_read?: number; cache_write?: number }} cost
 * @property {{ context: number; output: number }} limit
 * @property {{ reasoning?: boolean; temperature?: boolean }} capabilities
 * @property {boolean} [reasoning]
 * @property {boolean} [temperature]
 */

/**
 * @typedef {Object} ProviderResult
 * @property {{ id: string; models: Record<string, ProviderModel> }[]} [providers]
 * @property {{ id: string; models: Record<string, ProviderModel> }[]} [all]
 * @property {string[]} [connected]
 */

/**
 * @typedef {Object} ApiResult
 * @property {T} data
 * @property {{ message: string; [key: string]: any }} [error]
 * @template T
 */

/**
 * @typedef {Object} AgentSessionClient
 * @property {Object} session
 * @property {(opts: { body?: { parentID?: string; title?: string }; query?: { directory?: string } }) => Promise<ApiResult<SessionInfo>>} session.create
 * @property {(opts: { path: { id: string }; query?: { directory?: string } }) => Promise<ApiResult<any>>} session.get
 * @property {(opts: any) => Promise<ApiResult<PromptResponse>>} session.prompt
 * @property {(opts: any) => Promise<ApiResult<{ messageID: string }>>} session.promptAsync
 * @property {(opts: any) => Promise<ApiResult<MessageResponse>>} session.message
 * @property {Object} provider
 * @property {(opts?: any) => Promise<ApiResult<ProviderResult>>} [provider.list]
 * @property {(opts?: any) => Promise<ApiResult<ProviderResult>>} [provider.providers]
 */

/** Type guard to validate that a client conforms to the AgentSessionClient interface at runtime. */
export function isAgentSessionClient(client) {
  if (!client || typeof client !== "object") return false;
  const c = client;
  return (
    typeof c?.session?.create === "function" &&
    typeof c?.session?.prompt === "function" &&
    typeof c?.session?.message === "function" &&
    (typeof c?.provider?.list === "function" || typeof c?.provider?.providers === "function")
  );
}
