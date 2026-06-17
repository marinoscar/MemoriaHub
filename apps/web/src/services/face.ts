import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FaceCapabilities {
  detect: boolean;
  embed: boolean;
  delegatedRecognize: boolean;
}

export interface FaceProvider {
  provider: string; // 'compreface' | 'rekognition'
  configured: boolean;
  enabled: boolean;
  last4: string | null;
  baseUrl: string | null;
  region: string | null;
  capabilities?: FaceCapabilities;
}

export interface FaceSettingsResponse {
  providers: FaceProvider[];
  knownProviders: FaceProvider[];
  features: {
    detection: { provider: string | null; model: string | null } | null;
  };
}

export interface FaceTestResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getFaceSettings(): Promise<FaceSettingsResponse> {
  return api.get<FaceSettingsResponse>('/face/settings');
}

export async function putFaceCredentials(
  provider: string,
  body: { apiKey?: string; baseUrl?: string; region?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/face/credentials/${provider}`, body);
}

export async function deleteFaceCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/face/credentials/${provider}`);
}

export async function testFaceProvider(body: {
  provider: string;
  model: string;
}): Promise<FaceTestResult> {
  return api.post<FaceTestResult>('/face/test', body);
}

export async function getFaceModels(provider: string): Promise<string[]> {
  return api.get<string[]>(`/face/models?provider=${encodeURIComponent(provider)}`);
}

export async function putFaceDetectionFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/face/features/detection', body);
}

// ---------------------------------------------------------------------------
// Phase 2 Types — per-media face detection
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number; // normalized 0–1
  y: number;
  w: number;
  h: number;
}

export interface DetectedFaceDto {
  id: string;
  boundingBox: BoundingBox;
  confidence: number | null;
  personId: string | null;
  providerKey: string;
  modelVersion: string;
  manuallyAssigned: boolean;
  createdAt: string;
}

export type MediaFaceStatusType =
  | 'not_processed'
  | 'pending'
  | 'processing'
  | 'processed'
  | 'failed'
  | 'no_faces';

export interface MediaFaceStatusDto {
  status: MediaFaceStatusType;
  faceCount: number;
  providerKey: string | null;
  modelVersion: string | null;
  processedAt: string | null;
  lastError: string | null;
}

export interface RerunResult {
  jobId: string;
  status: string;
}

export interface BackfillResult {
  queued: number;
}

// ---------------------------------------------------------------------------
// Phase 2 API functions
// ---------------------------------------------------------------------------

export async function getMediaFaces(mediaId: string): Promise<DetectedFaceDto[]> {
  return api.get<DetectedFaceDto[]>(`/media/${mediaId}/faces`);
}

export async function getMediaFaceStatus(mediaId: string): Promise<MediaFaceStatusDto> {
  return api.get<MediaFaceStatusDto>(`/media/${mediaId}/faces/status`);
}

export async function rerunMediaFaces(mediaId: string): Promise<RerunResult> {
  return api.post<RerunResult>(`/media/${mediaId}/faces/rerun`);
}

export async function runFaceBackfill(circleId: string, force?: boolean): Promise<BackfillResult> {
  return api.post<BackfillResult>('/face/backfill', { circleId, force });
}
