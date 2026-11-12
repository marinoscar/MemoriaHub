import { api } from '../../../core/headless/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a face provider can do: detect faces, compute embeddings.
 *
 * @stability experimental
 */
export interface FaceCapabilities {
  detect: boolean;
  embed: boolean;
}

/**
 * One face provider as the settings page lists it (the credential is never included, only its last four characters).
 *
 * @stability experimental
 */
export interface FaceProvider {
  provider: string; // 'compreface'
  configured: boolean;
  enabled: boolean;
  requiresCredentials?: boolean;
  last4: string | null;
  baseUrl: string | null;
  region: string | null;
  capabilities?: FaceCapabilities;
}

/**
 * The face settings document: the configured providers, every known provider and the selected detection feature.
 *
 * @stability experimental
 */
export interface FaceSettingsResponse {
  providers: FaceProvider[];
  knownProviders: FaceProvider[];
  features: {
    detection: { provider: string | null; model: string | null } | null;
  };
}

/**
 * The outcome of a provider connectivity test.
 *
 * @stability experimental
 */
export interface FaceTestResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Reads the face settings (face_settings:read).
 *
 * @stability experimental
 */
export async function getFaceSettings(): Promise<FaceSettingsResponse> {
  return api.get<FaceSettingsResponse>('/face/settings');
}

/**
 * Saves a provider's credentials, encrypted at rest (face_settings:write).
 *
 * @stability experimental
 */
export async function putFaceCredentials(
  provider: string,
  body: { apiKey?: string; baseUrl?: string; region?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/face/credentials/${provider}`, body);
}

/**
 * Removes a provider's credentials (face_settings:write).
 *
 * @stability experimental
 */
export async function deleteFaceCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/face/credentials/${provider}`);
}

/**
 * Tests a provider's connectivity (face_settings:read).
 *
 * @stability experimental
 */
export async function testFaceProvider(body: {
  provider: string;
  model?: string;
}): Promise<FaceTestResult> {
  return api.post<FaceTestResult>('/face/test', body);
}

/**
 * Lists the models of a provider (face_settings:read).
 *
 * @stability experimental
 */
export async function getFaceModels(provider: string): Promise<string[]> {
  return api.get<string[]>(`/face/models?provider=${encodeURIComponent(provider)}`);
}

/**
 * Selects the provider and model that detect faces (face_settings:write).
 *
 * @stability experimental
 */
export async function putFaceDetectionFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/face/features/detection', body);
}


// ---------------------------------------------------------------------------
// Global backfills (Admin + face_settings:write)
// ---------------------------------------------------------------------------

/**
 * The result of a global backfill: the jobs enqueued across the circles.
 *
 * @stability experimental
 */
export interface FaceBackfillResult {
  /** Jobs enqueued. */
  enqueued: number;
  /** Circles the backfill covered. */
  circles: number;
}

/**
 * Enqueues a face detection job for every eligible item of every circle.
 *
 * @param body - an optional `capturedAt` range (ISO 8601) and `force` to redo processed items.
 * @returns what was enqueued.
 *
 * @stability experimental
 */
export async function runGlobalFaceBackfill(body?: {
  from?: string;
  to?: string;
  force?: boolean;
}): Promise<FaceBackfillResult> {
  return api.post<FaceBackfillResult>('/admin/face/backfill', body ?? {});
}

/**
 * Enqueues one auto-archive sweep per circle that already has archived unassigned faces.
 *
 * @returns what was enqueued.
 *
 * @stability experimental
 */
export async function runGlobalFaceAutoArchiveBackfill(): Promise<FaceBackfillResult> {
  return api.post<FaceBackfillResult>('/admin/face/auto-archive/backfill', {});
}
