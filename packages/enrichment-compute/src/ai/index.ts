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


// ---------------------------------------------------------------------------
// Video auto-tagging prompt (epic #452, issues #455/#460)
// ---------------------------------------------------------------------------

/**
 * System prompt for the video tagging pass.
 *
 * Lives HERE, in the shared parity package, for the same reason the ffmpeg
 * argv builders do: the server's in-process path and a distributed worker node
 * must send BYTE-IDENTICAL vision requests, and a prompt string duplicated in
 * two places is exactly the kind of thing that drifts silently.
 *
 * Same output CONTRACT as the photo prompt — a `{"tags": [...],
 * "description": "..."}` JSON envelope — which is what lets the entire
 * parse/persist half be reused verbatim. What differs is the framing: the
 * model must understand it is looking at ordered stills from ONE video, not a
 * set of unrelated photos.
 */
export const VIDEO_AUTO_TAGGING_SYSTEM_PROMPT =
  'You are a video analysis assistant. You will be shown several still frames sampled in order from a SINGLE video, ' +
  'and optionally a transcript of its opening seconds. Your job is to analyze the video as a whole and return a JSON object ' +
  'with two keys: "tags" and "description". ' +
  '"tags" must be a JSON array of strings — each string must exactly match one of the labels in the provided allowed list; return an empty array if none apply. ' +
  '"description" must be a brief 1-3 sentence description of the video as a whole, not of any single frame. ' +
  'Respond with ONLY a JSON object with those two keys — no explanation, no code fences, no extra text.';

/** Render a millisecond offset as `m:ss`, for the frame-timestamp list. */
function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Build the video tagging user prompt.
 *
 * EXTENDS the photo prompt's contract rather than replacing it: the same
 * `{"tags": [...], "description": "..."}` envelope, the same newline-joined
 * `Allowed labels:` vocabulary, and the same named-people clause. What it adds
 * is the ordered-frames framing, the timestamp of each frame, and — when
 * present — a delimited transcript block. Because the OUTPUT contract is
 * unchanged, the whole parse/persist half is reused verbatim.
 */
export function buildVideoTaggingPrompt(
  labelNames: string[],
  peopleNames: string[],
  sampledTimestampsMs: number[],
  transcript: string | null,
): string {
  const frameList = sampledTimestampsMs.map((ms, i) => `${i + 1}. ${formatTimestamp(ms)}`).join('\n');

  let prompt = `Analyze this video and return a JSON object with two keys: "tags" and "description".

You are shown ${sampledTimestampsMs.length} still frame(s) sampled in order from a single video, at these points in its runtime:
${frameList}

Treat them as one video, not as unrelated photos. Describe what the video as a whole is about.

"tags": an array of applicable labels from the following allowed list. Only choose labels that clearly apply. Return an empty array if none apply.
"description": a brief 1-3 sentence description of the video.

Allowed labels:
${labelNames.join('\n')}

Example response: {"tags": ["label1", "label2"], "description": "A child blows out candles on a birthday cake while family members sing. The video was taken indoors at a decorated dining table."}`;

  if (transcript) {
    prompt += `\n\nTranscript of the video's opening seconds (may be incomplete or misheard — treat it as a hint, not as fact):\n"""\n${transcript}\n"""`;
  }

  if (peopleNames.length > 0) {
    prompt += `\n\nThe following named people appear in this video: ${peopleNames.join(', ')}. Mention them by name in the description where appropriate.`;
  }

  return prompt;
}

/** Output budget for the video vision call — see VIDEO_TAGGING_MAX_TOKENS use. */
export const VIDEO_TAGGING_MAX_TOKENS = 2048;
