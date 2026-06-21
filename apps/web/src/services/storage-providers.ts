import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StorageProviderKey = 's3' | 'r2' | 'local';

export type MigrationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StorageProviderRow {
  provider: StorageProviderKey;
  label: string;
  configured: boolean;
  enabled: boolean;
  requiresCredentials: boolean;
  accessKeyId: string | null;
  region: string | null;
  bucket: string | null;
  endpoint: string | null;
  last4: string | null;
  updatedAt?: string;
}

export interface StorageSettingsResponse {
  providers: StorageProviderRow[];
  knownProviders: StorageProviderRow[];
  activeProvider: string;
}

export interface StorageProviderDescriptor {
  key: StorageProviderKey;
  label: string;
  requiresCredentials: boolean;
  fields: string[];
  endpointRequired: boolean;
}

export interface StorageTestResult {
  ok: boolean;
  bucket?: string;
  region?: string;
  endpoint?: string;
  error?: string;
}

export interface MigrationRun {
  id: string;
  sourceProvider: string;
  targetProvider: string;
  status: MigrationStatus;
  totalCount: number;
  migratedCount: number;
  failedCount: number;
  skippedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  counts?: { byStatus: Record<string, number> };
}

export interface MigrationRunsResponse {
  items: MigrationRun[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
  };
}

export interface TriggerMigrationResult {
  runId: string;
  totalCount: number;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getStorageSettings(): Promise<StorageSettingsResponse> {
  return api.get<StorageSettingsResponse>('/storage-settings');
}

export async function getStorageProviderDescriptors(): Promise<StorageProviderDescriptor[]> {
  return api.get<StorageProviderDescriptor[]>('/storage-settings/providers');
}

export async function putStorageCredentials(
  provider: string,
  body: {
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    region?: string;
    endpoint?: string;
    enabled?: boolean;
  },
): Promise<StorageProviderRow> {
  return api.put<StorageProviderRow>(`/storage-settings/credentials/${provider}`, body);
}

export async function deleteStorageCredentials(provider: string): Promise<void> {
  await api.delete<void>(`/storage-settings/credentials/${provider}`);
}

export async function testStorageProvider(body: {
  provider: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
}): Promise<StorageTestResult> {
  return api.post<StorageTestResult>('/storage-settings/test', body);
}

export async function setActiveStorageProvider(provider: string): Promise<{ activeProvider: string }> {
  return api.put<{ activeProvider: string }>('/storage-settings/active', { provider });
}

export async function triggerMigration(body: {
  sourceProvider: string;
  targetProvider: string;
}): Promise<TriggerMigrationResult> {
  return api.post<TriggerMigrationResult>('/storage-settings/migrate', body);
}

export async function listMigrationRuns(): Promise<MigrationRunsResponse> {
  return api.get<MigrationRunsResponse>('/storage-settings/migrate');
}

export async function getMigrationRun(runId: string): Promise<MigrationRun> {
  return api.get<MigrationRun>(`/storage-settings/migrate/${runId}`);
}

export async function cancelMigration(runId: string): Promise<MigrationRun> {
  return api.post<MigrationRun>(`/storage-settings/migrate/${runId}/cancel`);
}
