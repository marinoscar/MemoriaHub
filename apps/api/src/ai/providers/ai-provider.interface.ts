// =============================================================================
// AI Provider Interface
// =============================================================================

export interface AiProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string; // for tool result messages
  toolName?: string; // for tool result messages
}

export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: object;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: AiToolDef[];
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason?: string };

export interface AiProvider {
  /** Unique key identifying this provider, e.g. 'openai' | 'anthropic' */
  readonly key: string;
  /** Stream a chat completion. Yields ChatStreamEvents. */
  chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent>;
  /** Return model IDs available for this provider/credentials. */
  listModels(creds: AiProviderCredentials): Promise<string[]>;
  /** Ping the provider with a minimal call. Used for credential verification. */
  testModel(creds: AiProviderCredentials, model: string): Promise<{ ok: boolean; error?: string }>;
}
