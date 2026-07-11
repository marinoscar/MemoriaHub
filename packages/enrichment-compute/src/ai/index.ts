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
 */

import Anthropic from '@anthropic-ai/sdk';

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

  const response = await client.messages.create({
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

  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
