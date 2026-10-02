/**
 * Media Sync devices as the web manages them (issue #515, epic #498).
 *
 * Mirrors the #505 DTOs in `apps/api/src/media-sync/dto/media-sync.dto.ts`.
 * The web (JWT) can list, read, configure, command and unpair the caller's
 * own phones; reads need `media:read`, writes `media:write`. Another user's
 * device answers 404. Errors carry `details.reason` (spec §17.1).
 */
import { api, ApiError } from './api';

export type MediaSyncNetworkPolicy = 'wifi' | 'any';
export type MediaSyncUploadExisting = 'all' | 'from_pairing';
export type MediaSyncPermission = 'full' | 'partial' | 'denied';
export type MediaSyncNetworkState = 'wifi' | 'cellular' | 'none';
export type MediaSyncDeviceStatus = 'active' | 'revoked';
export type MediaSyncRunStatus = 'ok' | 'partial' | 'failed' | 'skipped' | 'paused';
export type MediaSyncTrigger = 'periodic' | 'content_trigger' | 'manual' | 'app_open' | 'initial';
export type MediaSyncCommand = 'pause' | 'resume' | 'retry_failed' | 'sync_now';

export interface MediaSyncFolder {
  bucketId: string;
  name: string;
}

/** The desired configuration the server holds for one phone (spec §5.1). */
export interface MediaSyncConfig {
  targetCircleId: string;
  folders: MediaSyncFolder[];
  includePhotos: boolean;
  includeVideos: boolean;
  network: MediaSyncNetworkPolicy;
  requireCharging: boolean;
  paused: boolean;
  uploadExisting: MediaSyncUploadExisting;
  retryFailedGeneration: number;
  syncNowGeneration: number;
}

/** One media folder the phone reported. */
export interface MediaSyncInventoryFolder {
  bucketId: string;
  name: string;
  relativePath?: string | null;
  photoCount: number;
  videoCount: number;
  bytes: number;
}

/** Counts from the phone's file ledger, authoritative per file. */
export interface MediaSyncStats {
  eligible: number;
  uploaded: number;
  deduplicated: number;
  pending: number;
  uploading: number;
  failed: number;
  blocked: number;
  bytesPending: number;
  bytesUploaded: number;
}

export interface MediaSyncDevice {
  id: string;
  installationId: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  androidVersion: string | null;
  sdkInt: number | null;
  appVersion: string | null;
  appVersionCode: number | null;
  packageName: string | null;
  timezone: string | null;
  latestVersionCode: number | null;
  updateAvailable: boolean;
  status: MediaSyncDeviceStatus;
  config: MediaSyncConfig;
  configVersion: number;
  appliedConfigVersion: number;
  configPending: boolean;
  inventory: MediaSyncInventoryFolder[] | null;
  stats: MediaSyncStats | null;
  permission: MediaSyncPermission | null;
  networkState: MediaSyncNetworkState | null;
  batteryOptimized: boolean | null;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: MediaSyncRunStatus | null;
  lastError: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The editable part of the config (commands own `paused` and the generations). */
export interface MediaSyncConfigPatch {
  targetCircleId?: string;
  folders?: MediaSyncFolder[];
  includePhotos?: boolean;
  includeVideos?: boolean;
  network?: MediaSyncNetworkPolicy;
  requireCharging?: boolean;
  uploadExisting?: MediaSyncUploadExisting;
}

export interface MediaSyncConfigResult {
  config: MediaSyncConfig;
  configVersion: number;
}

export interface MediaSyncFailedFile {
  name: string;
  relativePath?: string | null;
  sizeBytes: number;
  attempts: number;
  lastError?: string | null;
}

export interface MediaSyncRun {
  id: string;
  deviceId: string;
  trigger: MediaSyncTrigger;
  status: MediaSyncRunStatus;
  startedAt: string;
  finishedAt: string;
  filesUploaded: number;
  filesFailed: number;
  filesDeduplicated: number;
  /** Decimal string (64-bit counter). */
  bytesUploaded: string;
  errorCode: string | null;
  details: {
    failedSample?: MediaSyncFailedFile[];
    perFolder?: Array<{ bucketId: string; uploaded?: number; failed?: number; deduplicated?: number }>;
  } | null;
  createdAt: string;
}

export interface MediaSyncReportSummary {
  id: string;
  deviceId: string;
  summary: string | null;
  createdAt: string;
}

export interface MediaSyncReport extends MediaSyncReportSummary {
  report: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const BASE = '/media-sync/devices';
const id = (deviceId: string) => encodeURIComponent(deviceId);

export function listDevices(): Promise<MediaSyncDevice[]> {
  return api.get<MediaSyncDevice[]>(BASE);
}

export function getDevice(deviceId: string): Promise<MediaSyncDevice> {
  return api.get<MediaSyncDevice>(`${BASE}/${id(deviceId)}`);
}

export function updateDeviceConfig(
  deviceId: string,
  patch: MediaSyncConfigPatch,
): Promise<MediaSyncConfigResult> {
  return api.patch<MediaSyncConfigResult>(`${BASE}/${id(deviceId)}/config`, patch);
}

export function sendDeviceCommand(
  deviceId: string,
  action: MediaSyncCommand,
): Promise<MediaSyncConfigResult> {
  return api.post<MediaSyncConfigResult>(`${BASE}/${id(deviceId)}/commands`, { action });
}

export function listDeviceRuns(deviceId: string, limit = 50): Promise<MediaSyncRun[]> {
  return api.get<MediaSyncRun[]>(`${BASE}/${id(deviceId)}/runs?limit=${limit}`);
}

export function listDeviceDiagnostics(
  deviceId: string,
  limit = 20,
): Promise<MediaSyncReportSummary[]> {
  return api.get<MediaSyncReportSummary[]>(`${BASE}/${id(deviceId)}/diagnostics?limit=${limit}`);
}

export function getDeviceDiagnostic(deviceId: string, reportId: string): Promise<MediaSyncReport> {
  return api.get<MediaSyncReport>(
    `${BASE}/${id(deviceId)}/diagnostics/${encodeURIComponent(reportId)}`,
  );
}

export async function unpairDevice(deviceId: string): Promise<void> {
  await api.delete<void>(`${BASE}/${id(deviceId)}`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `details.reason` of a Media Sync refusal, or null. */
export function mediaSyncErrorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { reason?: unknown } | undefined;
  return typeof details?.reason === 'string' ? details.reason : null;
}

/** `details.bucketIds` of a 400 `UNKNOWN_FOLDER`. */
export function unknownFolderIds(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const details = err.details as { bucketIds?: unknown } | undefined;
  return Array.isArray(details?.bucketIds)
    ? details.bucketIds.filter((v): v is string => typeof v === 'string')
    : [];
}

export function mediaSyncErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to do this.';
    if (mediaSyncErrorReason(err) === 'DEVICE_REVOKED') {
      return 'This phone was unpaired. Pair it again from the app.';
    }
    return err.message || fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Derived values (presentation only)
// ---------------------------------------------------------------------------

export interface SyncCounts {
  /** uploaded + deduplicated */
  synced: number;
  /** pending + uploading + failed + blocked */
  missing: number;
  failed: number;
  blocked: number;
  eligible: number;
  bytesPending: number;
  /** synced / eligible as 0–100, or null when nothing is eligible. */
  percent: number | null;
}

export function syncCounts(stats: MediaSyncStats | null | undefined): SyncCounts | null {
  if (!stats) return null;
  const synced = stats.uploaded + stats.deduplicated;
  const missing = stats.pending + stats.uploading + stats.failed + stats.blocked;
  const percent =
    stats.eligible > 0 ? Math.min(100, Math.round((synced / stats.eligible) * 100)) : null;
  return {
    synced,
    missing,
    failed: stats.failed,
    blocked: stats.blocked,
    eligible: stats.eligible,
    bytesPending: stats.bytesPending,
    percent,
  };
}

/** Whole days until an ISO instant (negative when past), or null. */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

/** Below this many days left, the pairing expiry is a warning. */
export const PAIRING_WARN_DAYS = 14;

export type DeviceStatusKey =
  | 'paused'
  | 'waiting_for_wifi'
  | 'partial_access'
  | 'no_access'
  | 'battery_restricted'
  | 'config_pending';

export interface DeviceStatusLine {
  key: DeviceStatusKey;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export const CONFIG_PENDING_MESSAGE =
  'Changes pending — will apply next time the phone checks in.';

/** The status lines a device card shows, most important first. */
export function deviceStatusLines(device: MediaSyncDevice): DeviceStatusLine[] {
  const lines: DeviceStatusLine[] = [];
  if (device.config.paused) {
    lines.push({ key: 'paused', severity: 'warning', message: 'Paused — the phone is not syncing.' });
  }
  const pendingFiles = (device.stats?.pending ?? 0) + (device.stats?.uploading ?? 0);
  if (device.config.network === 'wifi' && device.networkState === 'cellular' && pendingFiles > 0) {
    lines.push({
      key: 'waiting_for_wifi',
      severity: 'info',
      message: 'Waiting for Wi-Fi — the phone is on mobile data and sync is set to Wi-Fi only.',
    });
  }
  if (device.permission === 'partial') {
    lines.push({
      key: 'partial_access',
      severity: 'warning',
      message: 'Partial photo access — only the photos you selected on the phone can sync.',
    });
  } else if (device.permission === 'denied') {
    lines.push({
      key: 'no_access',
      severity: 'error',
      message: 'No photo access — allow photo and video access in the app.',
    });
  }
  if (device.batteryOptimized === true) {
    lines.push({
      key: 'battery_restricted',
      severity: 'warning',
      message: 'Battery restricted — Android may delay background sync. Exempt the app from battery optimization.',
    });
  }
  if (device.configPending) {
    lines.push({ key: 'config_pending', severity: 'info', message: CONFIG_PENDING_MESSAGE });
  }
  return lines;
}
