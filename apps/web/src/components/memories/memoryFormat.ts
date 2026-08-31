import { memoryTypeMeta } from './memoryTypeMeta';
import type { MemoryCard } from '../../types/memories';
import { formatCivilDate } from '../../utils/civilDate';

/**
 * Human period for a memory ("March 2023", "Mar – Apr 2023", "2019 – 2025").
 *
 * Deliberately coarse: a memory covers a RANGE, and the day-level precision the
 * ISO timestamps carry is noise on a card. Same-month ranges collapse to one
 * label, cross-year ranges show both years.
 */
export function formatMemoryPeriod(
  periodStart: string,
  periodEnd: string,
): string {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';

  // periodStart/periodEnd are CIVIL timestamps — they cover the capture range,
  // so they are read in UTC (epic #440). The server generated this row's own
  // title with `timeZone: 'UTC'` (memory-title-templates.ts), so rendering the
  // period browser-locally made a memory's title and its period label disagree
  // for any viewer whose offset crossed a month boundary.
  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth();
  if (sameMonth) {
    return formatCivilDate(periodStart, { month: 'long', year: 'numeric' });
  }

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  if (sameYear) {
    const from = formatCivilDate(periodStart, { month: 'short' });
    const to = formatCivilDate(periodEnd, { month: 'short', year: 'numeric' });
    return `${from} – ${to}`;
  }

  return `${start.getUTCFullYear()} – ${end.getUTCFullYear()}`;
}

/**
 * Month header for the hub's scroll groups, keyed on `generatedAt`.
 *
 * `generatedAt` is a real INSTANT (when the curator ran), so it stays on the
 * viewer-local path — unlike the period above. See `docs/specs/date-model.md`.
 */
export function formatMemoryMonth(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return 'Earlier';
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Stable grouping key ("2026-08") so two months never collide by label. */
export function memoryMonthKey(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Screen-reader label for a card, per issue #309:
 * "Memory: Trip to Guanacaste, March 2023, 24 items, not yet viewed".
 *
 * The visual card conveys the same four facts through a badge, a scrim caption,
 * a count chip and a coloured ring — none of which an assistive technology can
 * read — so they are spelled out here rather than left to the title alone.
 */
export function memoryAriaLabel(memory: MemoryCard): string {
  const period = formatMemoryPeriod(memory.periodStart, memory.periodEnd);
  const parts = [`Memory: ${memory.title}`];
  if (period) parts.push(period);
  parts.push(`${memory.itemCount} ${memory.itemCount === 1 ? 'item' : 'items'}`);
  parts.push(memory.myState.seen ? 'viewed' : 'not yet viewed');
  if (memory.myState.favorited) parts.push('favorited');
  return `${parts.join(', ')} (${memoryTypeMeta(memory.type).label})`;
}
