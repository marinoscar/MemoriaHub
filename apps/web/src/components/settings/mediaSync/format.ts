/**
 * Labels and colours for the Media Sync settings (issue #515). Display only:
 * every status is the API's.
 */
import type { MediaSyncRunStatus, MediaSyncTrigger } from '../../../services/mediaSync';

export type ChipColor = 'success' | 'warning' | 'error' | 'default' | 'info';

export const RUN_STATUS_LABELS: Record<MediaSyncRunStatus, string> = {
  ok: 'OK',
  partial: 'Partial',
  failed: 'Failed',
  skipped: 'Skipped',
  paused: 'Paused',
};

export const RUN_STATUS_COLORS: Record<MediaSyncRunStatus, ChipColor> = {
  ok: 'success',
  partial: 'warning',
  failed: 'error',
  skipped: 'default',
  paused: 'default',
};

export const TRIGGER_LABELS: Record<MediaSyncTrigger, string> = {
  periodic: 'Scheduled',
  content_trigger: 'New photos',
  manual: 'Manual',
  app_open: 'App opened',
  initial: 'First sync',
};

export type DiagnosticCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export const CHECK_STATUS_LABELS: Record<DiagnosticCheckStatus, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  skip: 'Skipped',
};

/** Local date and time, or an em dash without one. Instants, so viewer-local. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
