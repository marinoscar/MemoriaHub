import { api } from './api';

export interface SocialMediaBackfillResult {
  enqueued: number;
  circles: number;
}

export async function backfillSocialMedia(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<SocialMediaBackfillResult> {
  return api.post<SocialMediaBackfillResult>('/admin/social-media/backfill', body ?? {});
}

export interface SocialMediaOcrStatus {
  ocrEnabled: boolean;
  ocrAvailable: boolean;
  degraded: boolean;
  modelPath: string;
  languages: string[];
  minConfidence: number;
  ocrMaxFrames: number;
  ocrTimeoutSeconds: number;
}

export async function getSocialMediaStatus(): Promise<SocialMediaOcrStatus> {
  return api.get<SocialMediaOcrStatus>('/admin/social-media/status');
}
