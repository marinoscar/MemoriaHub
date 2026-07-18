// ---------------------------------------------------------------------------
// Cron helpers for the workflow scheduler (pure, never throw).
//
// The builder only needs standard 5-field cron (`min hour dom month dow`) with a
// minimum interval of one hour (the epic's stated floor — no sub-hourly runs).
// `cronToText` for human rendering already lives in `workflowFormat.ts`; this
// module adds validation + the preset catalog.
// ---------------------------------------------------------------------------

export interface CronPreset {
  id: string;
  label: string;
  expression: string;
}

/** Ready-made schedules surfaced as quick-pick buttons. */
export const CRON_PRESETS: CronPreset[] = [
  { id: 'nightly', label: 'Nightly (3:00 AM)', expression: '0 3 * * *' },
  { id: 'weekly', label: 'Weekly (Sun 4:00 AM)', expression: '0 4 * * 0' },
  { id: 'monthly', label: 'Monthly (1st, 5:00 AM)', expression: '0 5 1 * *' },
];

/** Static hint shown when the settings-derived minimum interval is unavailable. */
export const CRON_MIN_INTERVAL_HINT =
  'Scheduled workflows run at most once per hour — sub-hourly schedules are not allowed.';

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both = Sunday)
];

/**
 * Validate a single cron field token against its numeric range. Supports the
 * wildcard, step (`slash n`), range (`a-b`), list (`a,b`), and single-number forms.
 */
function isValidField(token: string, min: number, max: number): boolean {
  if (token === '*') return true;

  // Step: */n or a-b/n
  if (token.includes('/')) {
    const [range, stepStr] = token.split('/');
    const step = Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) return false;
    return range === '*' || isValidField(range, min, max);
  }

  // List: a,b,c
  if (token.includes(',')) {
    return token.split(',').every((part) => isValidField(part, min, max));
  }

  // Range: a-b
  if (token.includes('-')) {
    const [aStr, bStr] = token.split('-');
    const a = Number(aStr);
    const b = Number(bStr);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    return a >= min && b <= max && a <= b;
  }

  // Single number
  const n = Number(token);
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * True when `expr` is a syntactically valid 5-field cron expression that also
 * runs no more often than hourly (the minute field must be a single fixed value,
 * so a wildcard or every-N-minutes minute field is rejected as sub-hourly).
 */
export function isValidCron(expr: string): boolean {
  if (!expr || typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  for (let i = 0; i < 5; i++) {
    const [min, max] = FIELD_RANGES[i];
    if (!isValidField(parts[i], min, max)) return false;
  }

  // Enforce the hourly floor: the minute field must be a single fixed number.
  const minuteField = parts[0];
  if (!/^\d+$/.test(minuteField)) return false;

  return true;
}
