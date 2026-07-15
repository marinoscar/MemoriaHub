import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiProvider {
  provider: string; // 'openai' | 'anthropic'
  configured: boolean;
  enabled: boolean;
  last4: string | null;
  baseUrl: string | null;
}

export interface AiSettingsResponse {
  providers: AiProvider[];
  knownProviders: AiProvider[];
  features: {
    search: { provider: string | null; model: string | null } | null;
    tagging: { provider: string | null; model: string | null } | null;
    embedding: { provider: string | null; model: string | null } | null;
    enhance?: { provider: string | null; model: string | null } | null;
  };
  conversations: {
    archiveAfterDays: number;
    deleteAfterArchiveDays: number;
  };
}

export interface AiTestResult {
  ok: boolean;
  error?: string;
}

export interface AiEmbeddingTestResult {
  ok: boolean;
  provider?: string;
  model?: string;
  dimensions?: number;
  warning?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getAiSettings(): Promise<AiSettingsResponse> {
  return api.get<AiSettingsResponse>('/ai/settings');
}

export async function putAiCredentials(
  provider: string,
  body: { apiKey: string; baseUrl?: string; enabled?: boolean },
): Promise<void> {
  await api.put<void>(`/ai/credentials/${provider}`, body);
}

export async function deleteAiCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/ai/credentials/${provider}`);
}

export async function testAiProvider(body: {
  provider: string;
  model: string;
}): Promise<AiTestResult> {
  return api.post<AiTestResult>('/ai/test', body);
}

export async function getAiModels(provider: string): Promise<string[]> {
  return api.get<string[]>(`/ai/models?provider=${encodeURIComponent(provider)}`);
}

export async function putAiSearchFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/ai/features/search', body);
}

export async function putAiTaggingFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/ai/features/tagging', body);
}

export async function putAiEmbeddingFeature(body: {
  provider: string | null;
  model: string | null;
}): Promise<void> {
  await api.put<void>('/ai/features/embedding', body);
}

export async function getAiEmbeddingModels(provider: string): Promise<string[]> {
  return api.get<string[]>(
    `/ai/models?provider=${encodeURIComponent(provider)}&capability=embedding`,
  );
}

export async function putAiEnhanceFeature(body: {
  provider: string;
  model: string;
}): Promise<void> {
  await api.put<void>('/ai/features/enhance', body);
}

export async function getAiImageModels(provider: string): Promise<string[]> {
  return api.get<string[]>(
    `/ai/models?provider=${encodeURIComponent(provider)}&capability=image`,
  );
}

export async function testAiEmbedding(body: {
  provider?: string;
  model?: string;
}): Promise<AiEmbeddingTestResult> {
  return api.post<AiEmbeddingTestResult>('/ai/test/embedding', body);
}
