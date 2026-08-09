import { memoryTypeMeta } from './memoryTypeMeta';
import type { MemoryCard } from '../../types/memories';

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

  const sameMonth =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth();
  if (sameMonth) {
    return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  const sameYear = start.getFullYear() === end.getFullYear();
  if (sameYear) {
    const from = start.toLocaleDateString(undefined, { month: 'short' });
    const to = end.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return `${from} – ${to}`;
  }

  return `${start.getFullYear()} – ${end.getFullYear()}`;
}

/** Month header for the hub's scroll groups, keyed on `generatedAt`. */
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
