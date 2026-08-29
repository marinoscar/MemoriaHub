/**
 * node/compute/video-auto-tagging.ts — Video AI auto-tagging compute
 * (epic #452, issue #460).
 *
 * Structurally a merge of the two existing precedents: `compute/video-face-detection.ts`
 * (frame extraction + per-frame `prepareImageForProcessing`) and
 * `compute/auto-tagging.ts` (transient per-job credentials, direct provider
 * call, raw text returned unparsed).
 *
 * MANDATED DESIGN, same as `compute/auto-tagging.ts`: the "AI-proxy" pattern
 * documented (stale) in docs/specs/distributed-nodes.md was explicitly
 * rejected. Re-introducing it here would be worse still — it would mean
 * uploading N frames per video just to call an API this node can call
 * directly. Instead the node fetches TRANSIENT, per-job credentials, holds the
 * plaintext key in a local variable for the duration of one compute call, and
 * never persists it to disk, config, or logs.
 *
 * URL INPUT (issue #456): `video_auto_tagging` is in the engine's
 * `URL_INPUT_TYPES`, so `input` here is the PRESIGNED URL, not a local path.
 * ffmpeg range-seeks it, fetching only the bytes around each seek point rather
 * than pulling a multi-gigabyte file to disk. The functions below accept
 * either form, so a future engine change back to a local path needs no edit
 * here.
 *
 * PARITY. Frame timestamps (`computeSeekTimestamps`), image preparation
 * (`prepareImageForProcessing` at `TAG_MAX_IMAGE_DIM`), the prompt
 * (`buildVideoTaggingPrompt`), and the vision request body all come from the
 * shared `@memoriahub/enrichment-compute` package — the same code the server
 * runs. That is what makes a node's result indistinguishable from the
 * server's, which is the acceptance bar for this issue.
 *
 * PARSING STAYS SERVER-SIDE. A node has no access to the `tag_labels` table
 * and so cannot validate that returned tags are in-vocabulary. This module
 * returns raw text plus frame/transcript provenance, matching
 * `videoAutoTaggingResultSchema`.
 *
 * RATE LIMITS: `callAnthropicVision`/`callOpenAiVision` already classify a
 * 429/529 into the shared `ProviderRateLimitError` and throw it directly, so
 * it propagates unchanged to node-engine.ts's catch, which forwards
 * `{ rateLimited: true, retryAfterMs }` and lets the job back off instead of
 * burning attempts.
 */

import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import {
  VIDEO_AUTO_TAGGING_SYSTEM_PROMPT,
  VIDEO_TAGGING_MAX_TOKENS,
  buildVideoTaggingPrompt,
  callAnthropicVision,
  callOpenAiVision,
} from '@memoriahub/enrichment-compute/ai';
import { extractAudioLead, extractFrames } from '@memoriahub/enrichment-compute/video';
import { CapabilityUnavailableError, type ComputeFn } from '../capabilities.js';
import { ApiClient } from '../../api.js';
import { loadConfig } from '../../config.js';

/** Mirrors VideoAutoTaggingService's TAG_MAX_DIM default. */
const TAG_MAX_DIM = parseInt(process.env['TAG_MAX_IMAGE_DIM'] ?? '1568', 10);

/**
 * Hard cap on the combined base64 payload across all frames in the single
 * call. Identical to the server's `MAX_TOTAL_IMAGE_BYTES` — frames are dropped
 * from the END (keeping the earliest, which anchor the narrative) rather than
 * failing the video.
 */
const MAX_TOTAL_IMAGE_BYTES = 18_000_000;

interface VideoAutoTaggingComputeResult {
  rawText: string;
  frameCount: number;
  sampledTimestampsMs: number[];
  transcript?: { text: string; language?: string; leadSeconds: number } | null;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const computeVideoAutoTagging: ComputeFn = async (
  input,
  params,
  ctx,
): Promise<VideoAutoTaggingComputeResult> => {
  if (!ctx) {
    throw new Error(
      'job context not provided — video_auto_tagging compute requires { nodeId, jobId } to fetch transient credentials',
    );
  }

  const config = loadConfig();
  if (!config) {
    throw new Error('not logged in — no CLI config found (run `memoriahub login`)');
  }
  const client = new ApiClient({ serverUrl: config.serverUrl, pat: config.pat });

  // --- 1. Transient credentials + the vocabulary/people the prompt needs ---
  const creds = (await client.getJobCredentials(ctx.nodeId, ctx.jobId)) as unknown as {
    type: string;
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    system: string;
    labelNames: string[];
    peopleNames: string[];
    transcription?: { provider: string; model: string; apiKey: string; baseUrl?: string };
  };

  if (creds.type !== 'video_auto_tagging') {
    throw new Error(`unexpected credentials type "${creds.type}" for video_auto_tagging job`);
  }
  if (creds.provider !== 'anthropic' && creds.provider !== 'openai') {
    // Decline rather than fail: the job stays server-only, exactly as
    // compute/auto-tagging.ts does for an unsupported tagging provider.
    throw new CapabilityUnavailableError(
      `video_auto_tagging via provider "${creds.provider}" not yet supported on nodes`,
      'video_auto_tagging',
    );
  }

  const p = (params ?? {}) as Record<string, unknown>;
  const durationMsRaw = p['durationMs'];
  const durationMs = typeof durationMsRaw === 'number' ? durationMsRaw : null;
  const maxFrames = numberParam(p, 'maxFrames', 6);
  const sampleIntervalSeconds = numberParam(p, 'sampleIntervalSeconds', 5);
  const transcriptionEnabled = p['transcriptionEnabled'] === true;
  const leadSeconds = numberParam(p, 'leadSeconds', 30);

  // --- 2. Frames — bounded by maxFrames and spread across the WHOLE runtime,
  // so a 3-hour video and a 30-second clip cost the same. ---
  const frames = await extractFrames(input, {
    durationMs,
    sampleIntervalSeconds,
    maxFrames,
  });
  if (frames.length === 0) {
    throw new Error('video_auto_tagging: no frames could be extracted from the video');
  }

  // --- 3. Prepare each frame exactly as the server does. ---
  const images: Array<{ base64: string; mimeType: string }> = [];
  const sampledTimestampsMs: number[] = [];
  let totalBytes = 0;

  for (const frame of frames) {
    const prepared = await prepareImageForProcessing(frame.buffer, { maxDim: TAG_MAX_DIM });
    // A frame sharp cannot decode is skipped, not fatal — the rest still
    // describe the video.
    if (prepared.width === 0) continue;

    const base64 = prepared.buffer.toString('base64');
    if (totalBytes + base64.length > MAX_TOTAL_IMAGE_BYTES) break;
    totalBytes += base64.length;
    images.push({ base64, mimeType: 'image/jpeg' });
    sampledTimestampsMs.push(frame.timestampMs);
  }

  if (images.length === 0) {
    throw new Error('video_auto_tagging: no video frames could be prepared for analysis');
  }

  // --- 4. Transcription — BEST-EFFORT, exactly like the server. Absent
  // credentials, no audio track, or an ffmpeg failure all degrade the video to
  // visual-only rather than failing the job. A rate limit is the one thing
  // that propagates, so the queue defers instead of silently producing a worse
  // description. ---
  let transcript: { text: string; language?: string; leadSeconds: number } | null = null;
  if (transcriptionEnabled && creds.transcription) {
    try {
      const audio = await extractAudioLead(input, { leadSeconds });
      const text = await transcribeViaOpenAi(creds.transcription, audio.buffer, audio.mimeType);
      if (text) transcript = { text, leadSeconds };
    } catch (err) {
      if (isRateLimit(err)) throw err;
      // Swallowed: visual-only is a valid outcome.
    }
  }

  // --- 5. ONE multi-image vision call. apiKey stays in this local variable
  // only — never module-level state, never logged. ---
  const rawText = await (creds.provider === 'anthropic' ? callAnthropicVision : callOpenAiVision)(
    { apiKey: creds.apiKey, baseUrl: creds.baseUrl },
    {
      model: creds.model,
      // Prefer the server's system prompt when it sent one, so a server ahead
      // of this CLI still governs; the shared constant is the fallback.
      system: creds.system || VIDEO_AUTO_TAGGING_SYSTEM_PROMPT,
      prompt: buildVideoTaggingPrompt(
        creds.labelNames,
        creds.peopleNames,
        sampledTimestampsMs,
        transcript?.text ?? null,
      ),
      images,
      maxTokens: VIDEO_TAGGING_MAX_TOKENS,
    },
  );

  return {
    rawText,
    frameCount: images.length,
    sampledTimestampsMs,
    transcript,
  };
};

/**
 * Minimal OpenAI transcription call.
 *
 * Deliberately a direct `fetch` rather than pulling the OpenAI SDK into the
 * CLI's dependency graph for one multipart POST: the SDK is already an
 * optional/heavy dependency here, and this endpoint's contract is a stable
 * multipart form. Errors carry the HTTP status so `isRateLimit` below can
 * classify a 429.
 */
async function transcribeViaOpenAi(
  cfg: { provider: string; model: string; apiKey: string; baseUrl?: string },
  audio: Buffer,
  mimeType: string,
): Promise<string> {
  // Anthropic has no audio capability; anything but OpenAI degrades to
  // visual-only rather than erroring, matching the server.
  if (cfg.provider !== 'openai') return '';

  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('model', cfg.model);
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'audio.m4a');

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const err = new Error(`OpenAI transcription failed: HTTP ${response.status}`) as Error & {
      status?: number;
    };
    err.status = response.status;
    throw err;
  }

  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === 'string' ? body.text.trim() : '';
}

/** True for a provider throttle the queue should DEFER on rather than swallow. */
function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 429 || status === 529;
}

export default computeVideoAutoTagging;
