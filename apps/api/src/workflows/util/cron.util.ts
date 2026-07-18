/**
 * Lightweight 5-field cron validator for `trigger='scheduled'` workflows.
 *
 * Phase 1 only needs to reject a malformed cron at save time; the actual
 * scheduling engine (and minimum-interval enforcement via
 * `workflows.scheduleMinIntervalMinutes`) is Phase 4. This validates the classic
 * 5-field form: `minute hour day-of-month month day-of-week`, each field being a
 * `*`, a number, a range, a step, or a comma list of those, within field bounds.
 *
 * Phase 4 adds two pure date-math helpers (`nextCronDate`,
 * `cronMinIntervalMinutes`) built on the `cron` package's Luxon-backed
 * `CronTime`. `isValidCron` above stays the FORMAT gate (5-field only); `cron`
 * is used only for computing fire times, since it happily accepts 6-field crons
 * too.
 */

import { CronTime } from 'cron';

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

/**
 * Next fire time of `expr` strictly after `from`, as a plain `Date`. Pure — no
 * scheduling side effects. `expr` must already be a valid cron (guard with
 * `isValidCron` first at save time).
 */
export function nextCronDate(expr: string, from: Date): Date {
  return new CronTime(expr).getNextDateFrom(from).toJSDate();
}

/**
 * Minimum gap, in minutes, between consecutive fire times of `expr`. Samples the
 * next ~20 fires starting from now and returns the smallest interval — so a
 * dense schedule like `*​/5 * * * *`, a comma list (`0,30 * * * *`), or a burst
 * within an hour is caught even when most gaps are large. Pure.
 */
export function cronMinIntervalMinutes(expr: string): number {
  const cronTime = new CronTime(expr);
  let prev = cronTime.getNextDateFrom(new Date());
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 20; i++) {
    const next = cronTime.getNextDateFrom(prev.plus({ seconds: 1 }).toJSDate());
    const gap = next.diff(prev, 'minutes').minutes;
    if (gap < min) min = gap;
    prev = next;
  }
  return min;
}
