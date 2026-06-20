// =============================================================================
// AI Provider Interface
// =============================================================================

export interface AiProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface ChatMessageToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ChatMessageToolCall[]; // assistant turns that invoked tools
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

export interface AnalyzeImageRequest {
  model: string;
  system?: string;
  prompt: string;
  /** Raw base64-encoded image data — no `data:` URI prefix. */
  imageBase64: string;
  /** MIME type, e.g. 'image/jpeg' */
  mimeType: string;
}

export interface AiProvider {
  /** Unique key identifying this provider, e.g. 'openai' | 'anthropic' */
  readonly key: string;
  /** Stream a chat completion. Yields ChatStreamEvents. */
  chat(creds: AiProviderCredentials, req: ChatRequest): AsyncIterable<ChatStreamEvent>;
  /** Return model IDs available for this provider/credentials. */
  listModels(creds: AiProviderCredentials): Promise<string[]>;
  /** Ping the provider with a minimal call. Used for credential verification. */
  testModel(creds: AiProviderCredentials, model: string): Promise<{ ok: boolean; error?: string }>;
  /**
   * Non-streaming vision call. Sends an image + text prompt and returns the
   * model's full text response. The caller is responsible for JSON-parsing if
   * structured output is expected.
   */
  analyzeImage(creds: AiProviderCredentials, req: AnalyzeImageRequest): Promise<string>;
  embedText?(creds: AiProviderCredentials, model: string, input: string): Promise<number[]>;
}
