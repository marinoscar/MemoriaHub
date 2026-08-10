// =============================================================================
// Database Backup schedule translation (issue #342, epic #339)
// =============================================================================
//
// The admin UI (#345) exposes a friendly frequency + day + time picker, NOT raw
// cron syntax — deliberately, and unlike `workflows.cronExpression`. This module
// is the single translation point from those fields to the 5-field cron string
// the scheduler evaluates, kept pure and dependency-free so it is exhaustively
// unit-testable without a Nest context, a clock, or a database.
//
// Everything downstream (`DatabaseBackupScheduleTask`) consumes only the string
// produced here and the shared `nextCronDate`/`isValidCron` helpers in
// `workflows/util/cron.util.ts` — there is no second cron implementation.
// =============================================================================

export type DatabaseBackupFrequency = 'daily' | 'weekly' | 'monthly';

/** Mirrors the `databaseBackup.timeOfDay` schema regex (#340). */
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Used only when a stored value is somehow unparseable; the schema default. */
const FALLBACK_HOUR = 2;
const FALLBACK_MINUTE = 0;

/**
 * Translate the stored `databaseBackup.*` schedule fields into a 5-field cron
 * expression (`minute hour day-of-month month day-of-week`).
 *
 *   daily,   02:00                → `0 2 * * *`
 *   weekly,  Monday    @ 02:00    → `0 2 * * 1`
 *   monthly, day 1     @ 02:00    → `0 2 1 * *`
 *
 * The irrelevant field is `*` for each frequency: a weekly schedule does not
 * constrain day-of-month, and a monthly one does not constrain day-of-week —
 * setting both would AND them in some cron implementations and OR them in
 * others, which is exactly the ambiguity this picker exists to avoid.
 *
 * Inputs are clamped rather than rejected. The Zod schema already validates
 * every one of them on the write path (`dayOfWeek` 0–6, `dayOfMonth` 1–28,
 * `timeOfDay` HH:mm), so a bad value here can only come from hand-edited JSON —
 * and a scheduler that silently produces a *valid* cron is strictly better than
 * one that throws inside a cron tick. `dayOfMonth` is capped at 28 for the same
 * reason the schema caps it: days 29–31 do not exist in every month, so a
 * "monthly" backup on the 31st would silently skip February.
 */
export function buildCronExpression(
  frequency: DatabaseBackupFrequency,
  dayOfWeek: number,
  dayOfMonth: number,
  timeOfDay: string,
): string {
  const { hour, minute } = parseTimeOfDay(timeOfDay);

  switch (frequency) {
    case 'weekly':
      return `${minute} ${hour} * * ${clampInt(dayOfWeek, 0, 6, 0)}`;
    case 'monthly':
      return `${minute} ${hour} ${clampInt(dayOfMonth, 1, 28, 1)} * *`;
    case 'daily':
    default:
      return `${minute} ${hour} * * *`;
  }
}

/**
 * Split `"HH:mm"` into numeric cron fields. Returns them as numbers so the
 * emitted expression is the canonical `0 2 * * *` rather than `00 02 * * *` —
 * both parse identically, but the canonical form is what the UI, the docs and
 * every test in this repo show.
 */
export function parseTimeOfDay(timeOfDay: string): {
  hour: number;
  minute: number;
} {
  const match =
    typeof timeOfDay === 'string' ? TIME_OF_DAY_RE.exec(timeOfDay.trim()) : null;
  if (!match) {
    return { hour: FALLBACK_HOUR, minute: FALLBACK_MINUTE };
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
