import type { z } from 'zod';

// =============================================================================
// MEMORIAHUB_AI: the model port (RETRO-J4, #610)
// =============================================================================
//
// Everything a slice asks of a model: a vision or text answer, a streamed chat with tools, one
// structured answer, embeddings, an inline image edit and an inline transcription. The web edition
// binds it over the platform AI slice (`AiService.forUser|forSystem`); a bare host binds its own.
//
// A KEY NEVER CROSSES THIS PORT. A call is made for a user (`forUser`: the user's own, the
// organization's or the deployment's key, resolved per call) or for the system (`forSystem`: a
// background job with no acting user). The adapter resolves the credential on its own side and
// drops it when the call returns; no event, error message or response below holds one (the
// conformance kit asserts it).
//
// AI JOBS ARE SERVER-ONLY. A handler that makes these calls declares `usesAi: true` on the jobs
// port and never `nodeResultSchema`.
//
// The request shapes are deliberately the platform's Responses-style ones (message items, content
// parts, function tools) reduced to the fields MemoriaHub uses, so a call site reads the same on
// either side of the port.
// =============================================================================

/**
 * Injection token of {@link MemoriahubAiPort}. The description string is permanent.
 *
 * @extensionPoint token
 * @stability experimental
 */
export const MEMORIAHUB_AI = Symbol.for('@marinoscar/memoriahub/MEMORIAHUB_AI');

/**
 * Who a call is made for and what it is for.
 *
 * @stability experimental
 */
export interface MemoriahubAiScope {
  /** The registered AI feature the call is metered and attributed to (`semantic_embedding`, `search_agent`). */
  feature: string;
  /** The organization the call is billed and audited under; `null` is the host's default organization. */
  orgId?: string | null;
  /** The queue job the call runs under, so a usage row can link to it. */
  jobId?: string;
}

/**
 * A piece of a message: text or an image (a URL or a `data:` URI).
 *
 * @stability experimental
 */
export type MemoriahubAiContentPart = { type: 'text'; text: string } | { type: 'image'; url: string };

/**
 * One item of a conversation.
 *
 * @stability experimental
 */
export type MemoriahubAiInputItem =
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string | MemoriahubAiContentPart[] }
  | { type: 'function_call'; callId: string; name: string; arguments: string }
  | { type: 'function_call_output'; callId: string; output: string };

/**
 * A function the model may call.
 *
 * @stability experimental
 */
export interface MemoriahubAiFunctionTool {
  /** Discriminant. */
  type: 'function';
  /** The tool name the model calls. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** The arguments' schema: a Zod schema or an object JSON Schema. */
  parameters: z.ZodType | Record<string, unknown>;
  /** Strict function calling. MemoriaHub's agent leaves it off so an optional argument stays optional. */
  strict?: boolean;
}

/**
 * A text or vision request.
 *
 * @stability experimental
 */
export interface MemoriahubAiRequest {
  /** The provider id (`openai`, `anthropic`). */
  provider?: string;
  /** The model id. */
  model?: string;
  /** The system instructions. */
  instructions?: string;
  /** The conversation, or one user string. */
  input: string | MemoriahubAiInputItem[];
  /** Tools the model may call. */
  tools?: MemoriahubAiFunctionTool[];
  /** An output ceiling, in tokens. */
  maxOutputTokens?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Reasoning effort, sent only to a model that reasons. */
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' };
  /** Per-provider escape hatch (`{ openai: { parallel_tool_calls: false } }`). */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Token counts of one call. `null` means the provider did not report it; never `0` for "unknown".
 *
 * @stability experimental
 */
export interface MemoriahubAiUsage {
  /** Prompt tokens, or `null` when unreported. */
  inputTokens: number | null;
  /** Completion tokens, or `null` when unreported. */
  outputTokens: number | null;
}

/**
 * A text answer.
 *
 * @stability experimental
 */
export interface MemoriahubAiResponse {
  /** The model's text. */
  outputText: string;
  /** What the call consumed. */
  usage?: MemoriahubAiUsage;
}

/**
 * A structured answer, validated against the caller's schema.
 *
 * @stability experimental
 */
export interface MemoriahubAiStructuredResponse<T> {
  /** The validated value. */
  parsed: T;
  /** The raw text. */
  outputText: string;
  /** What the call consumed. */
  usage?: MemoriahubAiUsage;
}

/**
 * One event of a streamed answer: zero or more `text` and `tool_call`, then one `done`.
 *
 * @stability experimental
 */
export type MemoriahubAiStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; usage?: MemoriahubAiUsage };

/**
 * An embeddings result.
 *
 * @stability experimental
 */
export interface MemoriahubAiEmbedResult {
  /** The model that produced the vectors. */
  model?: string;
  /** One vector per input, in order. */
  vectors: number[][];
}

/**
 * Bytes handed to a model (an image to edit, audio to transcribe).
 *
 * @stability experimental
 */
export interface MemoriahubAiBinary {
  /** The bytes. */
  data: Uint8Array;
  /** The MIME type. */
  mimeType: string;
  /** A file name hint some providers need. */
  filename?: string;
}

/**
 * An inline image edit.
 *
 * @stability experimental
 */
export interface MemoriahubAiImageEditRequest {
  /** The provider id. */
  provider?: string;
  /** The model id. */
  model: string;
  /** What to change. */
  prompt: string;
  /** The input images. */
  images: MemoriahubAiBinary[];
  /** The canvas (`1024x1024`, `1024x1536`, `1536x1024`). */
  size?: string;
  /** Output quality. */
  quality?: 'low' | 'medium' | 'high';
  /** Output format. */
  outputFormat?: 'png' | 'jpeg' | 'webp';
  /** How many images. */
  n?: number;
  /** Per-provider escape hatch. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * An inline image edit result.
 *
 * @stability experimental
 */
export interface MemoriahubAiImageResult {
  /** The images the model returned. */
  images: Array<{ data: Uint8Array; mimeType?: string }>;
}

/**
 * An inline transcription.
 *
 * @stability experimental
 */
export interface MemoriahubAiTranscribeRequest {
  /** The provider id. */
  provider?: string;
  /** The model id. */
  model: string;
  /** The audio. */
  audio: MemoriahubAiBinary;
  /** A language hint (ISO 639-1). */
  language?: string;
}

/**
 * An inline transcription result.
 *
 * @stability experimental
 */
export interface MemoriahubAiTranscription {
  /** The transcript. */
  text: string;
  /** The detected language, when reported. */
  language?: string;
}

/**
 * An AI feature the host meters, limits and lists. Its id is permanent once usage rows carry it (lower snake case).
 *
 * @stability experimental
 */
export interface MemoriahubAiFeatureDef {
  /** The feature id (`semantic_embedding`). */
  id: string;
  /** What an administrator reads in the usage report. */
  label: string;
  /** The usage report's group (`Search`, `Tagging`). */
  group?: string;
  /** The model capabilities the feature needs (`responses`, `tools`, `streaming`, `vision_input`, `embeddings`). */
  needs: readonly string[];
  /** True when a background job runs the feature with no acting user (`forSystem`). */
  systemCalls?: boolean;
}

/**
 * Options of one call.
 *
 * @stability experimental
 */
export interface MemoriahubAiCallOptions {
  /** Aborts the call. */
  signal?: AbortSignal;
}

/**
 * Why an AI call failed, in the vocabulary a slice branches on.
 *
 * - `auth`: the provider refused the credential.
 * - `refusal`: the provider declined to answer (content filter).
 * - `rate_limit`: the provider's limit was hit; defer the job.
 * - `timeout`: the call outlived its backstop.
 * - `not_configured`: AI is switched off, or no model or provider is set up.
 * - `key_missing`: no credential is stored.
 * - `capability`: the model lacks a capability the call needs.
 * - `invalid_output`: a structured answer was not a usable value.
 * - `other`: anything else (transient; retryable).
 *
 * @stability experimental
 */
export type MemoriahubAiErrorClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'timeout'
  | 'not_configured'
  | 'key_missing'
  | 'capability'
  | 'invalid_output'
  | 'other';

/**
 * Every {@link MemoriahubAiErrorClass}, for validation and for the conformance kit.
 *
 * @stability experimental
 */
export const MEMORIAHUB_AI_ERROR_CLASSES: readonly MemoriahubAiErrorClass[] = [
  'auth',
  'refusal',
  'rate_limit',
  'timeout',
  'not_configured',
  'key_missing',
  'capability',
  'invalid_output',
  'other',
];

/**
 * The one error type the AI port throws. Its message never holds a credential.
 *
 * @stability experimental
 */
export class MemoriahubAiError extends Error {
  /** The failure's class. */
  readonly errorClass: MemoriahubAiErrorClass;

  /** How long to wait before retrying, for `rate_limit`, when the provider said. */
  readonly retryAfterMs?: number;

  /**
   * @param errorClass - the failure's class.
   * @param message - a sentence for the log and the user. Never key material.
   * @param retryAfterMs - the provider's retry hint, in milliseconds.
   */
  constructor(errorClass: MemoriahubAiErrorClass, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'MemoriahubAiError';
    this.errorClass = errorClass;
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * One scoped client: every call it makes is metered and attributed to its feature.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubAiClient {
  /**
   * One text or vision answer.
   *
   * @param req - the request.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError on any failure.
   */
  respond(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiResponse>;

  /**
   * One structured answer, validated against `schema`.
   *
   * @param req - the request plus the schema and its name.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError (`invalid_output` when the answer does not parse).
   */
  respondStructured<S extends z.ZodTypeAny>(
    req: Omit<MemoriahubAiRequest, 'tools'> & { schema: S; schemaName?: string },
    opts?: MemoriahubAiCallOptions,
  ): Promise<MemoriahubAiStructuredResponse<z.output<S>>>;

  /**
   * A streamed answer. Gates and the provider connection settle on the first iteration.
   *
   * @param req - the request.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError while iterating.
   */
  stream(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): AsyncIterable<MemoriahubAiStreamEvent>;

  /**
   * Like `stream`, but the gates and the provider connection settle BEFORE this resolves, so a refusal
   * (the kill switch, no key, a model that cannot call tools) is thrown ahead of the caller's first
   * response byte. Use it where the caller is already committed to a response (an SSE route).
   *
   * @param req - the request.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError on a refusal.
   */
  openStream(req: MemoriahubAiRequest, opts?: MemoriahubAiCallOptions): Promise<AsyncIterable<MemoriahubAiStreamEvent>>;

  /**
   * One vector per input, in order.
   *
   * @param req - the model and the text(s).
   * @param opts - an abort signal.
   * @throws MemoriahubAiError on any failure.
   */
  embed(
    req: { provider?: string; model: string; input: string | string[] },
    opts?: MemoriahubAiCallOptions,
  ): Promise<MemoriahubAiEmbedResult>;

  /**
   * One synchronous image edit over bytes the caller already holds.
   *
   * @param req - the model, the prompt and the images.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError on any failure.
   */
  editImageInline(req: MemoriahubAiImageEditRequest, opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiImageResult>;

  /**
   * One synchronous transcription over audio the caller already holds.
   *
   * @param req - the model and the audio.
   * @param opts - an abort signal.
   * @throws MemoriahubAiError (`capability` when the model cannot transcribe).
   */
  transcribeInline(req: MemoriahubAiTranscribeRequest, opts?: MemoriahubAiCallOptions): Promise<MemoriahubAiTranscription>;
}

/**
 * The model port.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface MemoriahubAiPort {
  /**
   * The client of a call made for a user: the user's own key, else the organization's, else the
   * deployment's, resolved per call.
   *
   * @param userId - the acting user.
   * @param scope - the feature, the organization and the job.
   */
  forUser(userId: string, scope: MemoriahubAiScope): MemoriahubAiClient;

  /**
   * The client of a call made by a background job with no acting user: the organization's or the
   * deployment's key, never a user's.
   *
   * @param scope - the feature, the organization and the job.
   */
  forSystem(scope: MemoriahubAiScope): MemoriahubAiClient;

  /**
   * Declares an AI feature the host meters, limits and lists. Idempotent per id; call it at import or
   * start-up time, before the host freezes its registries.
   *
   * @param feature - the id, a label, the capabilities it needs, and whether system (job) calls are allowed.
   */
  registerFeature(feature: MemoriahubAiFeatureDef): void;
}
