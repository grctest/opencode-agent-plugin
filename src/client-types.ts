import type { AssistantMessage, UserMessage, Part, Model } from "@opencode-ai/sdk";

/** Information about a created session. */
export interface SessionInfo {
  id: string;
  title: string;
  parentID?: string;
  projectID: string;
  directory: string;
  version: string;
  time: { created: number; updated: number };
}

/** Response from a session prompt call. */
export interface PromptResponse {
  info: AssistantMessage;
  parts: Part[];
}

/** Response from reading a specific message. */
export interface MessageResponse {
  info: UserMessage | AssistantMessage;
  parts: Part[];
}

/** Standard API result wrapper with data and optional error. */
export interface ApiResult<T> {
  data: T;
  error?: { message: string; [key: string]: any };
}

/** Minimal client interface needed by the orchestrator (decouples from full SDK types). */
export interface AgentSessionClient {
  session: {
    create(opts: { body?: { parentID?: string; title?: string }; query?: { directory?: string } }): Promise<ApiResult<SessionInfo>>;
    prompt(opts: {
      path: { id: string };
      body?: {
        system?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
        parts: Array<{ type: "text"; text: string }>;
      };
      query?: { directory?: string };
    }): Promise<ApiResult<PromptResponse>>;
    promptAsync(opts: {
      path: { id: string };
      body?: {
        system?: string;
        model?: { providerID: string; modelID: string };
        tools?: Record<string, boolean>;
        parts: Array<{ type: "text"; text: string }>;
      };
      query?: { directory?: string };
    }): Promise<ApiResult<{ messageID: string }>>;
    message(opts: {
      path: { id: string; messageID: string };
      query?: { directory?: string };
    }): Promise<ApiResult<MessageResponse>>;
  };
  provider: {
    list(opts?: { query?: { directory?: string } }): Promise<any>;
  };
}

/** Type guard to validate that a client conforms to the AgentSessionClient interface at runtime. */
export function isAgentSessionClient(client: unknown): client is AgentSessionClient {
  if (!client || typeof client !== "object") return false;
  const c = client as any;
  return (
    typeof c?.session?.create === "function" &&
    typeof c?.session?.prompt === "function" &&
    typeof c?.session?.message === "function" &&
    typeof c?.provider?.list === "function"
  );
}
