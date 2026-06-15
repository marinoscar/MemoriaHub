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
