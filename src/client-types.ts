import type { AssistantMessage, UserMessage, Part, Model } from "@opencode-ai/sdk";

export interface SessionInfo {
  id: string;
  title: string;
  parentID?: string;
  projectID: string;
  directory: string;
  version: string;
  time: { created: number; updated: number };
}

export interface PromptResponse {
  info: AssistantMessage;
  parts: Part[];
}

export interface MessageResponse {
  info: UserMessage | AssistantMessage;
  parts: Part[];
}

export interface ApiResult<T> {
  data: T;
  error?: { message: string; [key: string]: any };
}

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
