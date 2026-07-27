import type { RunStatus } from '../types/runs';

// ---------------------------------------------------------------------------
// Pure formatting helpers shared by every async-run surface (issue #190).
//
// These previously lived in `utils/workflowFormat.ts` typed against
// `WorkflowRunStatus`; they are now generalised onto the `RunStatus` superset
// so the workflow, trash-empty, location-suggestion and review-run pages all
// use one implementation. `workflowFormat.ts` re-exports every symbol here, so
// existing workflow imports keep working unchanged.
//
// No React, never throw.
// ---------------------------------------------------------------------------

/** MUI color token for a run-status chip. */
export function runStatusColor(
  status: RunStatus,
): 'default' | 'info' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'evaluating':
    case 'running':
      return 'info';
    case 'awaiting_approval':
      return 'warning';
    case 'completed':
      return 'success';
    case 'completed_with_errors':
      return 'warning';
    case 'failed':
      return 'error';
    case 'cancelled':
    case 'expired':
      return 'default';
    default:
      return 'default';
  }
}

/** Title-cased, space-separated label for a run status. */
export function runStatusLabel(status: RunStatus): string {
  const words = status.split('_');
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** The set of run statuses that are final (no more polling). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'expired',
]);

/** True when the run has reached a final state and polling can stop. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Format an integer with locale thousands separators, e.g. 2481 → "2,481". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

/**
 * Format an ISO timestamp as a coarse relative time ("just now", "N minutes
 * ago", …), falling back to a localized date for anything older than a day.
 * Returns '' for null. Defensive — never throws.
 */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffMs = Date.now() - then;

    if (diffMs < 0) return 'just now';

    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

    return new Date(iso).toLocaleDateString();
  } catch {
    return '';
  }
}

/** Safe short date for a capture timestamp. Never throws. */
export function formatCaptureDate(iso: string | null): string {
  if (!iso) return 'No date';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'No date';
    return d.toLocaleDateString();
  } catch {
    return 'No date';
  }
}

/**
 * Completion percentage for a run, clamped to 0–100.
 *
 * Clamping is load-bearing, not defensive noise: `processedCount` is
 * incremented by concurrent batch jobs and `matchedCount` can shrink when
 * subjects cascade away mid-run, so the raw ratio can exceed 1.
 * Returns `null` when there is nothing to divide by (render indeterminate).
 */
export function runProgressPercent(
  processedCount: number,
  matchedCount: number,
): number | null {
  if (!Number.isFinite(matchedCount) || matchedCount <= 0) return null;
  if (!Number.isFinite(processedCount)) return 0;
  return Math.min(100, Math.max(0, (processedCount / matchedCount) * 100));
}
