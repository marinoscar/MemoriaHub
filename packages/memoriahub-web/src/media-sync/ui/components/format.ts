/**
 * Labels and colours for the Media Sync settings (issue #515). Display only:
 * every status is the API's.
 */
import type { MediaSyncRunStatus, MediaSyncTrigger } from '../../headless/services/mediaSync.js';

/**
 * The chip colours a status maps to.
 *
 * @stability experimental
 */
export type ChipColor = 'success' | 'warning' | 'error' | 'default' | 'info';

/**
 * The label of each run status.
 *
 * @stability experimental
 */
export const RUN_STATUS_LABELS: Record<MediaSyncRunStatus, string> = {
  ok: 'OK',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
  paused: 'Paused',
};

/**
 * The chip colour of each run status.
 *
 * @stability experimental
 */
export const RUN_STATUS_COLORS: Record<MediaSyncRunStatus, ChipColor> = {
  ok: 'success',
  partial: 'warning',
  failed: 'error',
  skipped: 'default',
  paused: 'default',
};

/**
 * The label of each run trigger.
 *
 * @stability experimental
 */
export const TRIGGER_LABELS: Record<MediaSyncTrigger, string> = {
  periodic: 'Scheduled',
  content_trigger: 'New photos',
  manual: 'Manual',
  app_open: 'App opened',
  initial: 'First sync',
};

/**
 * The status of one diagnostic check.
 *
 * @stability experimental
 */
export type DiagnosticCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/**
 * The label of each diagnostic check status.
 *
 * @stability experimental
 */
export const CHECK_STATUS_LABELS: Record<DiagnosticCheckStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skip: 'Skipped',
};

/**
 * Local date and time, or an em dash without one. Instants, so viewer-local.
 *
 * @stability experimental
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
