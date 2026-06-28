/**
 * format-duration.ts — Human-readable duration from milliseconds.
 *
 * Returns "—" for null/undefined, otherwise formats as:
 *   < 1 000 ms  → "450ms"
 *   < 60 000 ms → "45s"
 *   < 3 600 000 → "3m 12s"
 *   < 86 400 000 → "2h 5m"
 *   else        → "1d 3h"
 */

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 0) return '—';

  const totalSec = Math.floor(ms / 1000);
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${totalSec}s`;

  const totalMin = Math.floor(totalSec / 60);
  if (ms < 3_600_000) {
    const sec = totalSec % 60;
    return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  }

  const hours = Math.floor(totalMin / 60);
  if (ms < 86_400_000) {
    const min = totalMin % 60;
    return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}
