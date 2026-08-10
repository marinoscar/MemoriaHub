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
 * ## Restore / rollback (#344, merged)
 *
 * The restore half is typed against `DatabaseRestoreService`'s exported types
 * verbatim — `StartRestoreResult`, `RestorePreflightReport`, `PreflightCheck`,
 * `GuidedRestorePayload`, `RollbackResult`.
 *
 * **There is NO read-only pre-flight endpoint.** `POST /runs/:id/restore` is
 * the only way to obtain a `RestorePreflightReport`, and it requires the typed
 * `confirmation` literal. It is nonetheless safe to call: a failed CAPABILITY
 * gate returns `mode:'guided'` and a failed schema gate returns `mode:'blocked'`
 * — in both cases NOTHING is created, nothing is renamed, and the live database
 * is untouched. Only `mode:'running'` actually starts work. The dialog is built
 * around that fact rather than pretending a dry run exists.
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
  /** #344 lifecycle marker; see `DbRestoreStatus`. */
  restoreStatus: DbRestoreStatus | null;
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
// Restore / rollback (#344)
// ---------------------------------------------------------------------------

/** The literal the API's Zod schema demands. Anything else is a 400. */
export const RESTORE_CONFIRMATION = 'RESTORE';
export const ROLLBACK_CONFIRMATION = 'ROLLBACK';

/** `docs/runbooks/database-restore.md` (#346), as the guided payload names it. */
export const RESTORE_RUNBOOK_PATH = 'docs/runbooks/database-restore.md';
export const RESTORE_RUNBOOK_URL = `https://github.com/marinoscar/MemoriaHub/blob/main/${RESTORE_RUNBOOK_PATH}`;

export type DbRestorePreflightStatus = 'ok' | 'warning' | 'blocked';

export interface DbRestorePreflightCheck {
  key: string;
  label: string;
  status: DbRestorePreflightStatus;
  message: string;
  actionItem?: string;
}

export interface DbRestorePreflightReport {
  /**
   * `ok` — proceed. `guided` — a CAPABILITY gate failed and the app cannot
   * drive the restore at all. `blocked` — a gate the admin may consciously
   * override (today: schema compatibility).
   */
  status: 'ok' | 'guided' | 'blocked';
  checks: DbRestorePreflightCheck[];
  /** The mode actually in force, AFTER any automatic downgrade. */
  rollbackMode: DbBackupRollbackMode;
  /** What `databaseBackup.restoreRollbackMode` asked for. */
  rollbackModeRequested: DbBackupRollbackMode;
  rollbackModeDowngraded: boolean;
  downgradeReason: string | null;
  scratchDatabase: string;
  oldDatabase: string;
}

export interface DbGuidedRestorePayload {
  reason: string;
  runbook: string;
  commands: string[];
  notes: string[];
}

/**
 * Three NORMAL outcomes. `guided` and `blocked` are designed paths, not errors:
 * neither starts anything, so the dialog renders them as results rather than
 * failures.
 */
export type StartDbRestoreResult =
  | {
      mode: 'running';
      runId: string;
      scratchDatabase: string;
      oldDatabase: string;
      rollbackMode: DbBackupRollbackMode;
      rollbackModeDowngraded: boolean;
      preflight: DbRestorePreflightReport;
    }
  | {
      mode: 'guided';
      runId: string;
      guided: DbGuidedRestorePayload;
      preflight: DbRestorePreflightReport;
    }
  | {
      mode: 'blocked';
      runId: string;
      reason: string;
      preflight: DbRestorePreflightReport;
    };

export type DbRollbackResult =
  | { mode: 'renamed'; runId: string; restoredDatabase: string }
  | { mode: 'restore_started'; runId: string; preRestoreBackupId: string }
  | { mode: 'unavailable'; runId: string; reason: string };

/**
 * Lifecycle of a restore, as written to `DbBackupRunDto.restoreStatus`.
 *
 * `guided` / `blocked` are PERSISTED terminal-ish markers for an attempt that
 * never started, so a reload after either still shows what happened.
 */
export type DbRestoreStatus =
  | 'restoring'
  | 'verifying'
  | 'swapping'
  | 'completed'
  | 'failed'
  | 'guided'
  | 'blocked';

/** Restore phases during which `GET /runs/:id` is expected to keep answering. */
export const RESTORE_ACTIVE_STATUSES: readonly string[] = [
  'restoring',
  'verifying',
  'swapping',
];

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

/**
 * Start a restore FROM this backup — or, when a gate fails, learn why.
 *
 * Returns once the cheap pre-flight gates have run. `mode:'running'` means the
 * multi-hour scratch-database rebuild has begun IN THE BACKGROUND with the app
 * still fully serving; poll `getDbBackupRun` and watch `restoreStatus`.
 *
 * `overrideSchemaCheck` unblocks the compatibility gate ONLY — it can never
 * bypass a capability gate, which is why a `guided` result has no "try anyway".
 */
export async function startDbRestore(
  id: string,
  opts: { overrideSchemaCheck?: boolean } = {},
): Promise<StartDbRestoreResult> {
  return api.post<StartDbRestoreResult>(`/admin/db-backup/runs/${id}/restore`, {
    confirmation: RESTORE_CONFIRMATION,
    ...(opts.overrideSchemaCheck ? { overrideSchemaCheck: true } : {}),
  });
}

/**
 * Roll a completed restore back.
 *
 * `retain_database` mode renames the retained pre-swap database back — seconds,
 * then a process restart. `pre_restore_dump` mode has no database to rename, so
 * the API starts a full restore of the safety dump instead: hours. `mode` in
 * the response says which actually happened.
 */
export async function rollbackDbRestore(id: string): Promise<DbRollbackResult> {
  return api.post<DbRollbackResult>(`/admin/db-backup/runs/${id}/rollback`, {
    confirmation: ROLLBACK_CONFIRMATION,
  });
}
