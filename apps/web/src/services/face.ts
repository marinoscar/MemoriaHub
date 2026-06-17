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
