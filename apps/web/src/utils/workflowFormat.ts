import type { WorkflowTriggerType, WorkflowRunStatus } from '../types/workflows';

// ---------------------------------------------------------------------------
// Pure formatting helpers for the Workflows UI. No React, never throw.
// ---------------------------------------------------------------------------

/** Human label for a workflow trigger type. */
export function triggerLabel(trigger: WorkflowTriggerType): string {
  switch (trigger) {
    case 'manual':
      return 'Manual';
    case 'on_media_enriched':
      return 'On new media';
    case 'scheduled':
      return 'Scheduled';
    default:
      return trigger;
  }
}

/** Zero-pad a number to two digits. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format an (hour, minute) 24h pair as a 12-hour clock string, e.g. "3:00 AM". */
function formatTime12(hour: number, minute: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${pad(minute)} ${period}`;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Human-readable text for the common cron presets used by workflow templates.
 * Falls back to `Cron: <expr>` for anything it can't confidently parse.
 * Defensive — never throws.
 */
export function cronToText(expr: string | null): string {
  if (!expr) return '';
  const fallback = `Cron: ${expr}`;
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return fallback;
    const [minStr, hourStr, dom, month, dow] = parts;

    const minute = Number(minStr);
    const hour = Number(hourStr);
    if (!Number.isInteger(minute) || !Number.isInteger(hour)) return fallback;
    if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return fallback;

    const time = formatTime12(hour, minute);

    // Daily: 'm h * * *'
    if (dom === '*' && month === '*' && dow === '*') {
      return `Daily at ${time}`;
    }

    // Weekly: 'm h * * D'
    if (dom === '*' && month === '*' && dow !== '*') {
      const dowNum = Number(dow);
      if (Number.isInteger(dowNum) && dowNum >= 0 && dowNum <= 7) {
        const weekday = WEEKDAYS[dowNum % 7];
        return `Weekly on ${weekday} at ${time}`;
      }
      return fallback;
    }

    // Monthly: 'm h D * *'
    if (dom !== '*' && month === '*' && dow === '*') {
      const domNum = Number(dom);
      if (Number.isInteger(domNum) && domNum >= 1 && domNum <= 31) {
        return `Monthly on day ${domNum} at ${time}`;
      }
      return fallback;
    }

    return fallback;
  } catch {
    return fallback;
  }
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

/** MUI color token for a run-status chip. */
export function runStatusColor(
  status: WorkflowRunStatus,
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
export function runStatusLabel(status: WorkflowRunStatus): string {
  const words = status.split('_');
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
