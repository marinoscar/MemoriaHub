import { api } from './api';

// MemoriaHub's AI feature selections (RETRO-E4, #607). The AI administration itself (the switch,
// the key policy, the providers and their deployment keys) is the platform's `AiConfigPage` over
// `/api/admin/ai/*`; what it has no word for, which provider and model serve each MemoriaHub
// feature, is edited here, through `/api/admin/memoriahub-ai/*` (`ai_config:read|write`).
// Keys never go through these calls.
const BASE = '/admin/memoriahub-ai';

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
    /** Memories title/subtitle/narrative model (epic #300). */
    memories?: { provider: string | null; model: string | null } | null;
    /** Video tagging speech-to-text model (epic #452). */
    transcription?: { provider: string | null; model: string | null } | null;
  };
}

/** The model lists a MemoriaHub feature picks from. */
export type AiModelCapability = 'chat' | 'embedding' | 'image' | 'transcription';

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
  return api.get<AiSettingsResponse>(`${BASE}/features`);
}

export async function testAiProvider(body: {
  provider: string;
  model: string;
}): Promise<AiTestResult> {
  return api.post<AiTestResult>(`${BASE}/test`, body);
}

/** Model ids a provider offers for one kind of MemoriaHub feature (`chat` by default). */
export async function getAiModelsFor(
  provider: string,
  capability: AiModelCapability = 'chat',
): Promise<string[]> {
  const query = `provider=${encodeURIComponent(provider)}&capability=${capability}`;
  return api.get<string[]>(`${BASE}/models?${query}`);
}

export async function getAiModels(provider: string): Promise<string[]> {
  return getAiModelsFor(provider, 'chat');
}

export async function getAiEmbeddingModels(provider: string): Promise<string[]> {
  return getAiModelsFor(provider, 'embedding');
}

export async function getAiImageModels(provider: string): Promise<string[]> {
  return getAiModelsFor(provider, 'image');
}

/** The MemoriaHub features whose provider/model is selectable. */
export type AiFeatureKey = 'search' | 'tagging' | 'embedding' | 'enhance' | 'memories' | 'transcription';

/** Save one feature's selection; nulls clear it (the whole-or-null features). */
export async function putAiFeature(
  feature: AiFeatureKey,
  body: { provider: string | null; model: string | null },
): Promise<void> {
  await api.put<void>(`${BASE}/features/${feature}`, body);
}

export async function putAiSearchFeature(body: { provider: string; model: string }): Promise<void> {
  await putAiFeature('search', body);
}

export async function putAiTaggingFeature(body: { provider: string; model: string }): Promise<void> {
  await putAiFeature('tagging', body);
}

export async function putAiEmbeddingFeature(body: {
  provider: string | null;
  model: string | null;
}): Promise<void> {
  await putAiFeature('embedding', body);
}

export async function putAiEnhanceFeature(body: { provider: string; model: string }): Promise<void> {
  await putAiFeature('enhance', body);
}

/**
 * Set the chat-capable provider/model that writes memory titles, subtitles and
 * narratives (epic #300). Passing nulls clears the selection, in which case
 * memories fall back to deterministic template titles.
 */
export async function putAiMemoriesFeature(body: {
  provider: string | null;
  model: string | null;
}): Promise<void> {
  await putAiFeature('memories', body);
}

export async function testAiEmbedding(body: {
  provider?: string;
  model?: string;
}): Promise<AiEmbeddingTestResult> {
  return api.post<AiEmbeddingTestResult>(`${BASE}/test/embedding`, body);
}
