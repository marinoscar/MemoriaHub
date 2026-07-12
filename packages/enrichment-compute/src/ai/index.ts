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

export interface AnthropicVisionRequest {
  model: string;
  system?: string;
  prompt: string;
  /** Raw base64-encoded image data — no `data:` URI prefix. */
  imageBase64: string;
  /** MIME type, e.g. 'image/jpeg' */
  mimeType: string;
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

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: req.model,
      max_tokens: 1024,
      ...(req.system && { system: req.system }),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: req.mimeType as Anthropic.Base64ImageSource['media_type'],
                data: req.imageBase64,
              },
            },
            {
              type: 'text',
              text: req.prompt,
            },
          ],
        },
      ],
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
  const client = new OpenAI({
    apiKey: creds.apiKey,
    ...(creds.baseUrl && { baseURL: creds.baseUrl }),
  });

  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  if (req.system) {
    messages.push({ role: 'system', content: req.system });
  }

  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: req.prompt,
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:${req.mimeType};base64,${req.imageBase64}`,
        },
      },
    ],
  });

  let response: OpenAI.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model: req.model,
      reasoning_effort: OPENAI_REASONING_EFFORT as any,
      max_completion_tokens: ANALYZE_IMAGE_MAX_COMPLETION_TOKENS,
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
