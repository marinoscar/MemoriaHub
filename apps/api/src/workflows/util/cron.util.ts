/**
 * Lightweight 5-field cron validator for `trigger='scheduled'` workflows.
 *
 * Phase 1 only needs to reject a malformed cron at save time; the actual
 * scheduling engine (and minimum-interval enforcement via
 * `workflows.scheduleMinIntervalMinutes`) is Phase 4. This validates the classic
 * 5-field form: `minute hour day-of-month month day-of-week`, each field being a
 * `*`, a number, a range, a step, or a comma list of those, within field bounds.
 */

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 both = Sunday)
];

function isValidNumber(token: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(token)) return false;
  const n = Number(token);
  return n >= min && n <= max;
}

function isValidFieldPart(part: string, min: number, max: number): boolean {
  // step, e.g. "*/5" or "1-30/5"
  let base = part;
  if (part.includes('/')) {
    const [range, step] = part.split('/');
    if (!/^\d+$/.test(step) || Number(step) <= 0) return false;
    base = range;
  }
  if (base === '*') return true;
  if (base.includes('-')) {
    const [lo, hi] = base.split('-');
    return isValidNumber(lo, min, max) && isValidNumber(hi, min, max) && Number(lo) <= Number(hi);
  }
  return isValidNumber(base, min, max);
}

export function isValidCron(expr: string): boolean {
  if (typeof expr !== 'string') return false;
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, i) => {
    const [min, max] = FIELD_BOUNDS[i];
    return field.split(',').every((part) => part.length > 0 && isValidFieldPart(part, min, max));
  });
}
