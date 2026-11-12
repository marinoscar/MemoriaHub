/**
 * Media Sync devices as the web manages them (issue #515, epic #498).
 *
 * Mirrors the #505 DTOs in `packages/memoriahub-api/src/media/media-sync/media-sync.dto.ts`.
 * The web (JWT) can list, read, configure, command and unpair the caller's
 * own phones; reads need `media:read`, writes `media:write`. Another user's
 * device answers 404. Errors carry `details.reason` (spec §17.1).
 */
import { api, MemoriahubApiError as ApiError } from '../../../core/headless/index.js';

import type { MediaSyncErrorReason } from '@marinoscar/memoriahub-contract/errors';
import type {
  ConfigResult,
  DeviceView,
  InventoryFolder,
  MediaSyncCommand,
  MediaSyncConfig,
  MediaSyncDeviceStatus,
  MediaSyncFailedFile,
  MediaSyncNetworkPolicy,
  MediaSyncNetworkState,
  MediaSyncPerFolder,
  MediaSyncPermission,
  MediaSyncRunStatus,
  MediaSyncStats,
  MediaSyncTrigger,
  MediaSyncUploadExisting,
  ReportSummaryView,
  ReportView,
  RunView,
  UpdateConfigInput,
} from '@marinoscar/memoriahub-contract/media-sync';

// The vocabulary and the device, config, run and report shapes are the wire
// schemas of `@marinoscar/memoriahub-contract/media-sync`; this file only adds the client calls.
export type {
  MediaSyncCommand,
  MediaSyncConfig,
  MediaSyncDeviceStatus,
  MediaSyncFailedFile,
  MediaSyncNetworkPolicy,
  MediaSyncNetworkState,
  MediaSyncPermission,
  MediaSyncRunStatus,
  MediaSyncStats,
  MediaSyncTrigger,
  MediaSyncUploadExisting,
};

/**
 * One folder of a device's desired config.
 *
 * @stability experimental
 */
export type MediaSyncFolder = MediaSyncConfig['folders'][number];

/**
 * One media folder the phone reported.
 *
 * @stability experimental
 */
export type MediaSyncInventoryFolder = InventoryFolder;

/**
 * One device as the API lists it.
 *
 * @stability experimental
 */
export type MediaSyncDevice = DeviceView;

/**
 * The editable part of the config (commands own `paused` and the generations). The contract's
 * `UpdateConfigInput` minus `inventory`, which only the phone's own PAT may send.
 *
 * @stability experimental
 */
export type MediaSyncConfigPatch = Omit<UpdateConfigInput, 'inventory'>;

/**
 * The config and version a config or command call answers with.
 *
 * @stability experimental
 */
export type MediaSyncConfigResult = ConfigResult;

/**
 * One sync pass; `details` narrows the wire's generic JSON object to what a check-in reports.
 *
 * @stability experimental
 */
export type MediaSyncRun = Omit<RunView, 'details'> & {
  details: { failedSample?: MediaSyncFailedFile[]; perFolder?: MediaSyncPerFolder[] } | null;
};

/**
 * One diagnostic report as the list shows it.
 *
 * @stability experimental
 */
export type MediaSyncReportSummary = ReportSummaryView;

/**
 * One diagnostic report in full.
 *
 * @stability experimental
 */
export type MediaSyncReport = ReportView;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

const BASE = '/media-sync/devices';
const id = (deviceId: string) => encodeURIComponent(deviceId);

/**
 * Lists the caller's paired phones.
 *
 * @returns the devices
 *
 * @stability experimental
 */
export function listDevices(): Promise<MediaSyncDevice[]> {
  return api.get<MediaSyncDevice[]>(BASE);
}

/**
 * Reads one of the caller's devices; another user's device is a 404.
 *
 * @param deviceId - the device id
 * @returns the device
 *
 * @stability experimental
 */
export function getDevice(deviceId: string): Promise<MediaSyncDevice> {
  return api.get<MediaSyncDevice>(`${BASE}/${id(deviceId)}`);
}

/**
 * Patches the desired config of a device (folders, network policy, target circle, charging, upload scope).
 *
 * @param deviceId - the device id
 * @param patch - the fields to change
 * @returns the new config and its version
 *
 * @stability experimental
 */
export function updateDeviceConfig(
  deviceId: string,
  patch: MediaSyncConfigPatch,
): Promise<MediaSyncConfigResult> {
  return api.patch<MediaSyncConfigResult>(`${BASE}/${id(deviceId)}/config`, patch);
}

/**
 * Sends a command (`pause`, `resume`, `retry_failed` or `sync_now`) the phone acts on at its next check-in.
 *
 * @param deviceId - the device id
 * @param action - the command
 * @returns the new config and its version
 *
 * @stability experimental
 */
export function sendDeviceCommand(
  deviceId: string,
  action: MediaSyncCommand,
): Promise<MediaSyncConfigResult> {
  return api.post<MediaSyncConfigResult>(`${BASE}/${id(deviceId)}/commands`, { action });
}

/**
 * Lists a device's recent sync runs, newest first.
 *
 * @param deviceId - the device id
 * @param limit - the page size (default 50)
 * @returns the runs
 *
 * @stability experimental
 */
export function listDeviceRuns(deviceId: string, limit = 50): Promise<MediaSyncRun[]> {
  return api.get<MediaSyncRun[]>(`${BASE}/${id(deviceId)}/runs?limit=${limit}`);
}

/**
 * Lists a device's recent diagnostic report summaries.
 *
 * @param deviceId - the device id
 * @param limit - the page size
 * @returns the summaries
 *
 * @stability experimental
 */
export function listDeviceDiagnostics(
  deviceId: string,
  limit = 20,
): Promise<MediaSyncReportSummary[]> {
  return api.get<MediaSyncReportSummary[]>(`${BASE}/${id(deviceId)}/diagnostics?limit=${limit}`);
}

/**
 * Reads one diagnostic report in full.
 *
 * @param deviceId - the device id
 * @param reportId - the report id
 * @returns the report
 *
 * @stability experimental
 */
export function getDeviceDiagnostic(deviceId: string, reportId: string): Promise<MediaSyncReport> {
  return api.get<MediaSyncReport>(
    `${BASE}/${id(deviceId)}/diagnostics/${encodeURIComponent(reportId)}`,
  );
}

/**
 * Unpairs a device: revokes it and its token.
 *
 * @param deviceId - the device id
 *
 * @stability experimental
 */
export async function unpairDevice(deviceId: string): Promise<void> {
  await api.delete<void>(`${BASE}/${id(deviceId)}`);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * `details.reason` of a Media Sync refusal, or null.
 *
 * @stability experimental
 */
export function mediaSyncErrorReason(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { reason?: unknown } | undefined;
  return typeof details?.reason === 'string' ? details.reason : null;
}

/**
 * `details.bucketIds` of a 400 `UNKNOWN_FOLDER`.
 *
 * @stability experimental
 */
export function unknownFolderIds(err: unknown): string[] {
  if (!(err instanceof ApiError)) return [];
  const details = err.details as { bucketIds?: unknown } | undefined;
  return Array.isArray(details?.bucketIds)
    ? details.bucketIds.filter((v): v is string => typeof v === 'string')
    : [];
}

/**
 * A message for a failed Media Sync call, keyed off `details.reason` where the API sent one.
 *
 * @param err - the thrown value
 * @param fallback - the message when nothing better is known
 * @returns the message
 *
 * @stability experimental
 */
export function mediaSyncErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to do this.';
    if (mediaSyncErrorReason(err) === ('DEVICE_REVOKED' satisfies MediaSyncErrorReason)) {
      return 'This phone was unpaired. Pair it again from the app.';
    }
    return err.message || fallback;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Derived values (presentation only)
// ---------------------------------------------------------------------------

/**
 * The headline counts of a device: eligible, uploaded, waiting and failed files.
 *
 * @stability experimental
 */
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

/**
 * The headline counts of a device's last reported stats.
 *
 * @param stats - the reported stats, or none
 * @returns the counts, or `null` when the phone has not reported
 *
 * @stability experimental
 */
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

/**
 * Whole days until an ISO instant (negative when past), or null.
 *
 * @stability experimental
 */
export function daysUntil(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now) / 86_400_000);
}

/**
 * Below this many days left, the pairing expiry is a warning.
 *
 * @stability experimental
 */
export const PAIRING_WARN_DAYS = 14;

/**
 * The state a device status line reports (paired, stale, blocked, permission and so on).
 *
 * @stability experimental
 */
export type DeviceStatusKey =
  | 'paused'
  | 'waiting_for_wifi'
  | 'partial_access'
  | 'no_access'
  | 'battery_restricted'
  | 'config_pending';

/**
 * One line of a device's status summary.
 *
 * @stability experimental
 */
export interface DeviceStatusLine {
  key: DeviceStatusKey;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * The note shown while the phone has not applied the latest config.
 *
 * @stability experimental
 */
export const CONFIG_PENDING_MESSAGE =
  'Changes pending — will apply next time the phone checks in.';

/**
 * The status lines a device card shows, most important first.
 *
 * @stability experimental
 */
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
