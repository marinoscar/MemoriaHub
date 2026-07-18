import type {
  WorkflowTriggerType,
  WorkflowRunStatus,
  WorkflowActionInstance,
  WorkflowDefinition,
} from '../types/workflows';

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

// ---------------------------------------------------------------------------
// Run-page helpers
// ---------------------------------------------------------------------------

/** The set of run statuses that are final (no more polling). */
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'expired',
]);

/** True when the run has reached a final state and polling can stop. */
export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** Format an integer with locale thousands separators, e.g. 2481 → "2,481". */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString();
}

/**
 * The literal string the user must type to confirm a hard-delete run. Must
 * match the backend contract exactly: `DELETE {matchedCount}` where
 * matchedCount is the RAW integer (no thousands separators).
 */
export function hardDeleteConfirmationText(matchedCount: number): string {
  return `DELETE ${matchedCount}`;
}

/** True when a workflow definition contains a `hard_delete` action. */
export function definitionHasHardDelete(
  definition: WorkflowDefinition | null | undefined,
): boolean {
  if (!definition || !Array.isArray(definition.actions)) return false;
  return definition.actions.some((a) => a.type === 'hard_delete');
}

/** Coerce an unknown action param to a trimmed non-empty string, else null. */
function paramString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

/** Coerce an unknown action param to a string list (accepts string or string[]). */
function paramStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  }
  const single = paramString(value);
  return single ? [single] : [];
}

/**
 * Human-readable label for a single workflow action, derived from its `type`
 * and top-level param siblings. Best-effort and defensive — an unknown action
 * type falls back to a prettified version of its snake_case type. Never throws.
 *
 * Examples:
 *   { type: 'move_to_trash' }                              → "Move to Trash"
 *   { type: 'archive' }                                    → "Archive"
 *   { type: 'add_tags', names: ['screenshot'] }             → "Add tag 'screenshot'"
 *   { type: 'add_to_album', createAlbumNamed: 'Italy' }    → "Add to album 'Italy'"
 *   { type: 'resolve_duplicate_group', action: 'trash' }   → "Resolve duplicate groups: keep best, trash the rest"
 */
export function describeWorkflowAction(action: WorkflowActionInstance): string {
  const prettyType = action.type
    .split('_')
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');

  switch (action.type) {
    case 'move_to_trash':
      return 'Move to Trash';
    case 'archive':
      return 'Archive';
    case 'unarchive':
      return 'Unarchive';
    case 'set_favorite':
      return action.favorite === false ? 'Unmark favorite' : 'Mark favorite';
    case 'hard_delete':
      return 'Permanently delete';
    case 'move_to_circle': {
      const target = paramString(action.targetCircleName) ?? paramString(action.targetCircleId);
      return target ? `Move to circle '${target}'` : 'Move to circle';
    }
    case 'add_to_album': {
      const name =
        paramString(action.createAlbumNamed) ??
        paramString(action.albumName) ??
        paramString(action.albumId);
      return name ? `Add to album '${name}'` : 'Add to album';
    }
    case 'add_tags': {
      // `names` is the actual param key (see ACTION_PARAM_KIND in
      // workflowActionMeta.ts and the backend registry); `tags`/`tag`/
      // `tagName` are accepted defensively in case an older payload shape
      // is ever encountered, but `names` is always checked first.
      const tags = paramStringList(action.names ?? action.tags ?? action.tag ?? action.tagName);
      return tags.length > 0 ? `Add tag ${tags.map((t) => `'${t}'`).join(', ')}` : 'Add tag';
    }
    case 'remove_tags': {
      const tags = paramStringList(action.names ?? action.tags ?? action.tag ?? action.tagName);
      return tags.length > 0 ? `Remove tag ${tags.map((t) => `'${t}'`).join(', ')}` : 'Remove tag';
    }
    case 'set_location':
      return 'Set location';
    case 'clear_location':
      return 'Clear location';
    case 'set_capture_date':
      return 'Set capture date';
    case 'shift_capture_date':
      return 'Shift capture date';
    case 'clear_capture_date':
      return 'Clear capture date';
    case 'add_person': {
      const name = paramString(action.personName) ?? paramString(action.name);
      return name ? `Tag person '${name}'` : 'Tag person';
    }
    case 'resolve_duplicate_group': {
      const rest = action.action === 'archive' ? 'archive the rest' : 'trash the rest';
      return `Resolve duplicate groups: keep best, ${rest}`;
    }
    case 'resolve_burst_group': {
      const rest = action.action === 'archive' ? 'archive the rest' : 'trash the rest';
      return `Resolve burst groups: keep best, ${rest}`;
    }
    default:
      return prettyType;
  }
}

export interface WorkflowActionImpact {
  /** Stable key for React lists (action type + ordinal). */
  key: string;
  /** Human-readable action label. */
  label: string;
  /** Number of items this action will affect / has affected. */
  count: number;
}

/**
 * Derive the per-action impact list shown on the run page. For each action in
 * the run's `definitionSnapshot`, pair its human label with the count of items
 * it affects: the applied count from `byActionType` once the run has begun
 * applying, otherwise the effective matched count (matched minus exclusions)
 * for the awaiting-approval preview. Defensive — never throws.
 */
export function deriveActionImpacts(
  actions: WorkflowActionInstance[] | null | undefined,
  effectiveCount: number,
  byActionType?: Record<string, { applied: number; failed: number; skipped: number }>,
): WorkflowActionImpact[] {
  if (!Array.isArray(actions)) return [];
  return actions.map((action, index) => {
    const applied = byActionType?.[action.type]?.applied;
    const count = typeof applied === 'number' ? applied : Math.max(0, effectiveCount);
    return {
      key: `${action.type}-${index}`,
      label: describeWorkflowAction(action),
      count,
    };
  });
}
