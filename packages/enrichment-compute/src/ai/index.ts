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
 * Only Anthropic is extracted this pass. OpenAI also implements
 * `analyzeImage` (apps/api/src/ai/providers/openai.provider.ts) but is not
 * ported here — a node job configured for a non-Anthropic tagging provider
 * throws CapabilityUnavailableError client-side and the job stays
 * server-only, exactly as before this change.
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
 */

import Anthropic from '@anthropic-ai/sdk';
import { ProviderRateLimitError, parseRetryAfterMs } from '../rate-limit/index.js';

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
