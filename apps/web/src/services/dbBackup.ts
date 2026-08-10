import { api } from './api';

/**
 * Admin → Database Backup service client (issue #345, epic #339).
 *
 * Mirrors `/api/admin/db-backup/*` (#343) exactly.
 *
 * ## Every byte field is a STRING
 *
 * `bytesWritten` and `sizeBytes` are Prisma `BigInt` columns mapped explicitly
 * to decimal strings by the API's `toRunDto`. They are typed `string` here and
 * humanized with `formatBytes` (BigInt parsing) — never `Number()`-coerced.
 *
 * ## Restore / rollback are NOT here
 *
 * `POST /runs/:id/restore` and `POST /runs/:id/rollback` are issue #344 and do
 * not exist on the API yet. Nothing in this file guesses at their shape.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a database backup run — mirrors the Prisma
 * `DatabaseBackupStatus` enum EXACTLY, which is also the accepted set for the
 * `?status=` filter.
 *
 * Note there is deliberately no `verified` member: verification is recorded as
 * a `verifiedAt` TIMESTAMP on a `completed` row, not as a sixth status. The
 * table derives a "verified" display chip from `completed` + `verifiedAt`
 * (see `dbBackupTable.tsx`) rather than inventing a status the API can neither
 * return nor filter on.
 */
export type DbBackupRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stale';

/**
 * How a run was started.
 *
 * `pre_restore` is written by #344's restore flow (a safety dump taken before a
 * restore swaps the database). The value can already appear in history once
 * that lands, so the table distinguishes it now rather than falling through to
 * a generic chip later.
 */
export type DbBackupRunTrigger = 'manual' | 'scheduled' | 'pre_restore';

export type DbBackupFrequency = 'daily' | 'weekly' | 'monthly';

export type DbBackupRollbackMode = 'retain_database' | 'pre_restore_dump';

/** The `databaseBackup.*` settings namespace, as returned by `GET /config`. */
export interface DbBackupConfig {
  enabled: boolean;
  frequency: DbBackupFrequency;
  /** 0 = Sunday. Only meaningful when `frequency === 'weekly'`. */
  dayOfWeek: number;
  /** 1–28. Only meaningful when `frequency === 'monthly'`. */
  dayOfMonth: number;
  /** Local wall-clock time, `"HH:mm"`. */
  timeOfDay: string;
  /** IANA zone the schedule is evaluated in. */
  timezone: string;
  retentionCount: number;
  /** null = use the currently-active storage provider. */
  storageProvider: string | null;
  runStaleMinutes: number;
  compressionLevel: number;
  restoreRollbackMode: DbBackupRollbackMode;
  oldDatabaseRetentionHours: number;
}

/** `GET /api/admin/db-backup/config`. */
export interface DbBackupConfigResponse {
  config: DbBackupConfig;
  /** Server-computed next fire time (ISO 8601); null when disabled. */
  nextRunAt: string | null;
  /** The run currently holding the single-active-run slot, if any. */
  activeRunId: string | null;
}

/** Partial body for `PUT /api/admin/db-backup/config` — only sent keys change. */
export type UpdateDbBackupConfigDto = Partial<DbBackupConfig>;

/** One row of `GET /api/admin/db-backup/runs`, and `GET /runs/:id`. */
export interface DbBackupRunDto {
  id: string;
  status: DbBackupRunStatus;
  trigger: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastHeartbeatAt: string | null;
  verifiedAt: string | null;
  /** Wall time start→finish, or start→now while still running. */
  elapsedMs: number | null;
  /** BigInt-safe decimal string. */
  bytesWritten: string;
  /** BigInt-safe decimal string; null until the dump completes. */
  sizeBytes: string | null;
  storageProvider: string | null;
  storageKey: string | null;
  bucket: string | null;
  format: string | null;
  checksumSha256: string | null;
  dbVersion: string | null;
  appVersion: string | null;
  migrationName: string | null;
  lastError: string | null;
  createdById: string | null;
  restoreStatus: string | null;
  restoreError: string | null;
  restoredAt: string | null;
  restoredById: string | null;
  restoreScratchDb: string | null;
  restoreOldDb: string | null;
  swappedAt: string | null;
  preRestoreBackupId: string | null;
}

export interface DbBackupRunsResponse {
  items: DbBackupRunDto[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface StartDbBackupResponse {
  runId: string;
  status: string;
}

export interface DbBackupDownloadResponse {
  url: string;
  expiresIn: number;
}

export interface DeleteDbBackupResponse {
  deleted: true;
  objectDeleted: boolean;
}

export interface CancelDbBackupResponse {
  runId: string;
  signalled: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getDbBackupConfig(): Promise<DbBackupConfigResponse> {
  return api.get<DbBackupConfigResponse>('/admin/db-backup/config');
}

/** Partial update; the response is the same shape as the GET (fresh nextRunAt). */
export async function updateDbBackupConfig(
  dto: UpdateDbBackupConfigDto,
): Promise<DbBackupConfigResponse> {
  return api.put<DbBackupConfigResponse>('/admin/db-backup/config', dto);
}

/**
 * Trigger a manual backup. Returns immediately with the claimed run id; the
 * dump continues in the background. Throws an `ApiError` with `status === 409`
 * when a run is already in flight.
 */
export async function startDbBackupRun(): Promise<StartDbBackupResponse> {
  return api.post<StartDbBackupResponse>('/admin/db-backup/runs');
}

export async function listDbBackupRuns(params?: {
  status?: DbBackupRunStatus;
  page?: number;
  pageSize?: number;
}): Promise<DbBackupRunsResponse> {
  const search = new URLSearchParams();
  if (params?.status) search.set('status', params.status);
  if (params?.page) search.set('page', String(params.page));
  if (params?.pageSize) search.set('pageSize', String(params.pageSize));
  const qs = search.toString();
  return api.get<DbBackupRunsResponse>(
    `/admin/db-backup/runs${qs ? `?${qs}` : ''}`,
  );
}

/** Single-run detail — the progress-polling endpoint. */
export async function getDbBackupRun(id: string): Promise<DbBackupRunDto> {
  return api.get<DbBackupRunDto>(`/admin/db-backup/runs/${id}`);
}

/** Signed download URL, resolved against the provider RECORDED ON THE RUN. */
export async function getDbBackupDownloadUrl(
  id: string,
  expiresIn?: number,
): Promise<DbBackupDownloadResponse> {
  const qs = expiresIn ? `?expiresIn=${expiresIn}` : '';
  return api.get<DbBackupDownloadResponse>(
    `/admin/db-backup/runs/${id}/download${qs}`,
  );
}

export async function deleteDbBackupRun(
  id: string,
): Promise<DeleteDbBackupResponse> {
  return api.delete<DeleteDbBackupResponse>(`/admin/db-backup/runs/${id}`);
}

export async function cancelDbBackupRun(
  id: string,
): Promise<CancelDbBackupResponse> {
  return api.post<CancelDbBackupResponse>(`/admin/db-backup/runs/${id}/cancel`);
}
