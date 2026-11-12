import { api } from '../../../core/headless/index.js';

/**
 * The outcome of a global social-media detection backfill.
 *
 * @stability experimental
 */
export interface SocialMediaBackfillResult {
  /** Detection jobs enqueued. */
  enqueued: number;
  /** Circles that were swept. */
  circles: number;
}

/**
 * Enqueues social-media detection for every video of every circle (admin only).
 *
 * @param body - optional capture-date bounds (`from`, `to`) and `force` to re-run videos already classified
 * @returns the counts of enqueued jobs and swept circles
 * @stability experimental
 */
export async function backfillSocialMedia(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<SocialMediaBackfillResult> {
  return api.post<SocialMediaBackfillResult>('/admin/social-media/backfill', body ?? {});
}

/**
 * The OCR fallback's availability and effective configuration.
 *
 * @stability experimental
 */
export interface SocialMediaOcrStatus {
  /** True when the OCR fallback is switched on. */
  ocrEnabled: boolean;
  /** True when the OCR engine and its language data are usable on the server. */
  ocrAvailable: boolean;
  /** True when detection runs on metadata and filename rules alone. */
  degraded: boolean;
  /** Where the OCR language data is read from. */
  modelPath: string;
  /** The loaded language codes. */
  languages: string[];
  /** The decision threshold. */
  minConfidence: number;
  /** The cap on frames read per video. */
  ocrMaxFrames: number;
  /** The soft timeout of the OCR phase. */
  ocrTimeoutSeconds: number;
}

/**
 * Reads the OCR fallback status (admin only).
 *
 * @returns the status document
 * @stability experimental
 */
export async function getSocialMediaStatus(): Promise<SocialMediaOcrStatus> {
  return api.get<SocialMediaOcrStatus>('/admin/social-media/status');
}
