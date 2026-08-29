/**
 * Shared Anthropic vision-call primitive (extracted verbatim from
 * apps/api/src/ai/providers/anthropic.provider.ts's `analyzeImage`).
 *
 * PARITY RATIONALE (distributed-nodes spec §7 pattern, "transient credentials"
 * variant — see docs/specs/distributed-nodes.md, which is stale on this point
 * and will be updated separately): the server's compute/persist split for
 * `auto_tagging` calls this SAME function server-side; a distributed worker
 * node imports it directly and calls it with a per-job, transiently-fetched
 * API key (never persisted to disk/config/logs — see
 * `POST /api/nodes/:id/jobs/:jobId/credentials`). Both call sites therefore
 * send byte-identical requests to Anthropic and get identical parsing
 * behavior downstream (parsing of the raw text response stays server-side —
 * see `AutoTaggingService.persistAutoTagging`).
 *
 * `callAnthropicVision` and `callOpenAiVision` are the now-supported pair —
 * both the server's in-process auto-tagging path
 * (apps/api/src/ai/providers/anthropic.provider.ts,
 * apps/api/src/ai/providers/openai.provider.ts) and a distributed CLI worker
 * node (apps/cli/src/node/compute/auto-tagging.ts) import these directly and
 * call them with a per-job, transiently-fetched API key (never persisted to
 * disk/config/logs — see `POST /api/nodes/:id/jobs/:jobId/credentials`). A
 * node job configured for any OTHER tagging provider still declines with
 * `CapabilityUnavailableError` client-side and the job stays server-only.
 *
 * RATE-LIMIT CLASSIFICATION: the Anthropic SDK throws a typed `APIError`
 * (`.status`, `.headers`) for both HTTP 429 (rate limit) and 529 ("Overloaded")
 * responses — see `apps/api/src/enrichment/rate-limit.error.ts`'s
 * `classifyRateLimit`, which treats both the same way server-side.
 * `callAnthropicVision` classifies these into the shared
 * `ProviderRateLimitError` (../rate-limit/index.ts) so every caller — the
 * server's in-process auto-tagging path and a distributed CLI worker node
 * alike — gets one consistent signal to react to, instead of each having to
 * duck-type the SDK error itself. All other errors propagate unchanged.
 * `callOpenAiVision` mirrors this with `classifyOpenAiRateLimit`, keyed off
 * `OpenAI.APIError` and HTTP 429 only (OpenAI has no 529-equivalent overload
 * status).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ProviderRateLimitError, parseRetryAfterMs } from '../rate-limit/index.js';

// NOTE: despite the Anthropic-prefixed name, these two interfaces are shared
// across providers — their fields (apiKey/baseUrl, model/system/prompt/
// imageBase64/mimeType) are structurally identical for Anthropic and OpenAI,
// so `callOpenAiVision` below reuses them rather than duplicating the shape.
export interface AnthropicVisionCredentials {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Default Anthropic output budget for a vision call. Comfortable for a
 * photo's tag list plus a one-line description; a multi-frame video summary
 * raises it per-request via `AnthropicVisionRequest.maxTokens` rather than
 * moving this default, so the photo path stays byte-identical.
 */
const ANTHROPIC_VISION_MAX_TOKENS = 1024;

export interface VisionImage {
  /** Raw base64-encoded image data — no `data:` URI prefix. */
  base64: string;
  /** MIME type, e.g. 'image/jpeg' */
  mimeType: string;
}

export interface AnthropicVisionRequest {
  model: string;
  system?: string;
  prompt: string;
  /**
   * Single-image form. Ignored when `images` is present and non-empty.
   * Optional only so the multi-image form can omit it — one of the two forms
   * must supply at least one image or the call throws before any network I/O.
   */
  imageBase64?: string;
  /** MIME type of `imageBase64`, e.g. 'image/jpeg' */
  mimeType?: string;
  /**
   * Multi-image form — ORDERED; the model sees the images in array order.
   * Used by video auto-tagging to send N frames sampled across a video in a
   * single call (issue #453). Takes precedence over `imageBase64`/`mimeType`.
   */
  images?: VisionImage[];
  /**
   * Per-request output token budget. Absent keeps each provider's existing
   * default, so every pre-existing caller sends a byte-identical request.
   */
  maxTokens?: number;
}

/**
 * Normalizes the two request forms into one ordered image list. Throws before
 * any network call when neither form supplies an image — a malformed request
 * is cheaper to reject here than to have the provider reject it after a
 * round trip (and, on a rate-limited account, after burning a retry).
 */
function resolveVisionImages(req: AnthropicVisionRequest): VisionImage[] {
  if (req.images && req.images.length > 0) return req.images;
  if (req.imageBase64 && req.mimeType) {
    return [{ base64: req.imageBase64, mimeType: req.mimeType }];
  }
  throw new Error(
    'Vision request requires at least one image: supply `imageBase64` + `mimeType`, or a non-empty `images` array',
  );
}

/**
 * Non-streaming vision call: sends an image + text prompt to Anthropic and
 * returns the model's full text response (unparsed — callers JSON-parse if
 * structured output is expected). Identical request shape to
 * `AnthropicProvider.analyzeImage`.
 */
export async function callAnthropicVision(
  creds: AnthropicVisionCredentials,
  req: AnthropicVisionRequest,
): Promise<string> {
  const client = new Anthropic({
    apiKey: creds.apiKey,
    ...(creds.baseUrl && { baseURL: creds.baseUrl }),
  });

  const images = resolveVisionImages(req);

  // Image blocks first, then the single text block — the same ordering the
  // single-image form has always produced, so a one-image request is
  // byte-identical to what this function sent before multi-image support.
  const content: Anthropic.ContentBlockParam[] = images.map((image) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: image.mimeType as Anthropic.Base64ImageSource['media_type'],
      data: image.base64,
    },
  }));
  content.push({ type: 'text' as const, text: req.prompt });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? ANTHROPIC_VISION_MAX_TOKENS,
      ...(req.system && { system: req.system }),
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    throw classifyAnthropicRateLimit(err) ?? err;
  }

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Classifies an Anthropic SDK error as a rate limit / overload throttle.
 * Returns a `ProviderRateLimitError` for HTTP 429 or 529 ("Overloaded" — see
 * the module header), with `retryAfterMs` populated from the response's
 * `Retry-After` header when present. Returns `null` for any other error,
 * which callers should rethrow unchanged.
 *
 * Exported for direct use/testing; `callAnthropicVision` above applies this
 * automatically.
 */
export function classifyAnthropicRateLimit(err: unknown): ProviderRateLimitError | null {
  if (!(err instanceof Anthropic.APIError)) return null;
  if (err.status !== 429 && err.status !== 529) return null;

  const retryAfterMs = parseRetryAfterMs(err.headers?.get('retry-after') ?? null);
  return new ProviderRateLimitError(
    `Anthropic rate limit / overload (HTTP ${err.status}): ${err.message}`,
    'anthropic',
    retryAfterMs,
  );
}

// Tagging is a short structured-classification task. reasoning_effort:'low'
// keeps GPT-5.x reasoning models from spending the full token budget on
// hidden reasoning, so the JSON output reliably fits in the response — and
// it's faster/cheaper. 'low' is accepted by all allowed GPT-5.x models;
// override via OPENAI_REASONING_EFFORT env var if needed. Same env var name
// as apps/api/src/ai/providers/openai.provider.ts so a single knob controls
// both the server's in-process path and any node's compute path.
const ANALYZE_IMAGE_MAX_COMPLETION_TOKENS = 4096;
const OPENAI_REASONING_EFFORT = process.env['OPENAI_REASONING_EFFORT'] ?? 'low';

/**
 * Non-streaming vision call: sends an image + text prompt to OpenAI and
 * returns the model's full text response (unparsed — callers JSON-parse if
 * structured output is expected). Identical request shape to
 * `OpenAiProvider.analyzeImage`, ported verbatim from that method. Reuses
 * `AnthropicVisionCredentials`/`AnthropicVisionRequest` — see the note above
 * those interfaces.
 */
export async function callOpenAiVision(
  creds: AnthropicVisionCredentials,
  req: AnthropicVisionRequest,
): Promise<string> {
  const images = resolveVisionImages(req);

  const client = new OpenAI({
    apiKey: creds.apiKey,
    ...(creds.baseUrl && { baseURL: creds.baseUrl }),
  });

  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  // Text block first, then the image blocks — the same ordering the
  // single-image form has always produced, so a one-image request is
  // byte-identical to what this function sent before multi-image support.
  const content: OpenAI.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text: req.prompt,
    },
  ];
  for (const image of images) {
    content.push({
      type: 'image_url',
      image_url: {
        url: `data:${image.mimeType};base64,${image.base64}`,
      },
    });
  }

  messages.push({ role: 'user', content });

  let response: OpenAI.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: req.model,
      reasoning_effort: OPENAI_REASONING_EFFORT as any,
      max_completion_tokens: req.maxTokens ?? ANALYZE_IMAGE_MAX_COMPLETION_TOKENS,
      messages,
    });
  } catch (err) {
    throw classifyOpenAiRateLimit(err) ?? err;
  }

  return response.choices[0]?.message?.content ?? '';
}

/**
 * Classifies an OpenAI SDK error as a rate limit throttle. Returns a
 * `ProviderRateLimitError` for HTTP 429, with `retryAfterMs` populated from
 * the response's `Retry-After` header when present. Returns `null` for any
 * other error, which callers should rethrow unchanged.
 *
 * A single `status === 429` check is sufficient — no attempt is made to
 * distinguish OpenAI's `rate_limit_exceeded` vs `insufficient_quota`
 * sub-codes; the existing bounded backoff/max-hits caps already handle both
 * cases fine.
 *
 * Exported for direct use/testing; `callOpenAiVision` above applies this
 * automatically.
 */
export function classifyOpenAiRateLimit(err: unknown): ProviderRateLimitError | null {
  if (!(err instanceof OpenAI.APIError)) return null;
  if (err.status !== 429) return null;

  const retryAfterMs = parseRetryAfterMs(err.headers?.get('retry-after') ?? null);
  return new ProviderRateLimitError(
    `OpenAI rate limit (HTTP ${err.status}): ${err.message}`,
    'openai',
    retryAfterMs,
  );
}
