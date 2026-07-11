/**
 * node/compute/auto-tagging.ts — AI auto-tagging compute.
 *
 * MANDATED DESIGN (see apps/api/src/nodes/nodes.service.ts's
 * getJobCredentials): docs/specs/distributed-nodes.md documents an
 * "AI-proxy" pattern where the node never sees the provider API key and all
 * vision calls route through the server. That pattern was explicitly
 * rejected for this job type — the spec doc is stale on this point. Instead:
 *
 *   1. Fetch TRANSIENT, per-job credentials via
 *      `POST /api/nodes/:id/jobs/:jobId/credentials` (never persisted to
 *      disk/config/logs — the apiKey lives in a local variable only, for the
 *      duration of this call).
 *   2. Prepare the image exactly like the server does
 *      (prepareImageForProcessing, same TAG_MAX_IMAGE_DIM default) so a node
 *      and the server send byte-identical vision requests.
 *   3. Call the provider directly via
 *      @memoriahub/enrichment-compute/ai's callAnthropicVision.
 *
 * Only the 'anthropic' tagging provider is supported on nodes this pass
 * (mirrors the parity package — see packages/enrichment-compute/src/ai). A
 * job configured for any other provider declines with
 * CapabilityUnavailableError so the server keeps handling it in-process.
 *
 * Parsing/validation of the raw response text against the enabled TagLabel
 * vocabulary stays server-side (AutoTaggingService.persistAutoTagging) — this
 * module only returns the raw text, matching autoTaggingResultSchema
 * (`{ rawText: string }`).
 *
 * RATE LIMITS: `callAnthropicVision` (package `/ai`) already classifies a
 * 429/529 (Anthropic "Overloaded") SDK error into the shared
 * `ProviderRateLimitError` (package `/rate-limit`) and throws it directly —
 * no local duck-typing needed here. It propagates unchanged up through this
 * compute function to node-engine.ts's processJob catch block, which detects
 * `err instanceof ProviderRateLimitError` and forwards
 * `{ rateLimited: true, retryAfterMs }` to the server's failure endpoint so
 * the job backs off instead of burning through ENRICHMENT_MAX_ATTEMPTS.
 */

import { readFile } from 'node:fs/promises';
import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import { callAnthropicVision } from '@memoriahub/enrichment-compute/ai';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';
import { ApiClient } from '../../api.js';
import { loadConfig } from '../../config.js';

/** Mirrors AutoTaggingService's TAG_MAX_DIM default (env-configurable server-side). */
const TAG_MAX_DIM = parseInt(process.env['TAG_MAX_IMAGE_DIM'] ?? '1568', 10);

interface AutoTaggingComputeResult {
  rawText: string;
}

const computeAutoTagging: ComputeFn = async (inputPath, _params, ctx): Promise<AutoTaggingComputeResult> => {
  if (!ctx) {
    throw new Error(
      'job context not provided — auto_tagging compute requires { nodeId, jobId } to fetch transient credentials',
    );
  }

  const config = loadConfig();
  if (!config) {
    throw new Error('not logged in — no CLI config found (run `memoriahub login`)');
  }
  const client = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

  // --- 1. Fetch TRANSIENT credentials + the shared prompt for this job ---
  const creds = await client.getJobCredentials(ctx.nodeId, ctx.jobId);
  if (creds.type !== 'auto_tagging') {
    throw new Error(`unexpected credentials type "${creds.type}" for auto_tagging job`);
  }
  if (creds.provider !== 'anthropic') {
    throw new CapabilityUnavailableError(
      `auto_tagging via provider "${creds.provider}" not yet supported on nodes`,
      'auto_tagging',
    );
  }

  // --- 2. Prepare the image exactly like the server (EXIF-orientation + resize) ---
  const buffer = await readFile(inputPath);
  const prepared = await prepareImageForProcessing(buffer, { maxDim: TAG_MAX_DIM });
  if (prepared.width === 0) {
    throw new Error('auto_tagging: image preprocessing failed (unsupported/undecodable format)');
  }
  const imageBase64 = prepared.buffer.toString('base64');

  // --- 3. Call the provider directly. apiKey stays in this local variable
  // only — never assigned to `this`/module-level state, never logged.
  // Rate-limit classification (429/529 -> ProviderRateLimitError) happens
  // inside callAnthropicVision itself; nothing to catch here. ---
  const rawText = await callAnthropicVision(
    { apiKey: creds.apiKey, baseUrl: creds.baseUrl },
    {
      model: creds.model,
      system: creds.system,
      prompt: creds.prompt,
      imageBase64,
      mimeType: creds.mimeTypeHint,
    },
  );

  return { rawText };
};

export default computeAutoTagging;
