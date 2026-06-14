import { api } from './api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupRunRequest {
  circleId?: string;
  all?: boolean;
}

export interface BackupRunResult {
  runId: string;
  scope: string;
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface BackupRun {
  runId: string;
  scope: string; // circleId or 'all'
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
  startedAt: string; // ISO timestamp
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function triggerBackup(dto: BackupRunRequest): Promise<BackupRunResult> {
  return api.post<BackupRunResult>('/admin/backup', dto);
}

export async function listBackupRuns(): Promise<BackupRun[]> {
  return api.get<BackupRun[]>('/admin/backup/runs');
}

export async function getBackupRun(runId: string): Promise<BackupRun> {
  return api.get<BackupRun>(`/admin/backup/runs/${runId}`);
}
