// formatBytes, formatCompactNumber, percent, bytesToNumber and relativeTime live in the packaged core
// (`@marinoscar/memoriahub-web/core/headless`); this re-export keeps the app's imports unchanged.
export {
  formatBytes,
  formatCompactNumber,
  percent,
  bytesToNumber,
  relativeTime,
} from '@marinoscar/memoriahub-web/core/headless';

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHr = Math.floor(totalMin / 60);
  const totalDay = Math.floor(totalHr / 24);
  if (totalDay >= 1) {
    const hrs = totalHr % 24;
    return hrs > 0 ? `${totalDay}d ${hrs}h` : `${totalDay}d`;
  }
  if (totalHr >= 1) {
    const mins = totalMin % 60;
    return mins > 0 ? `${totalHr}h ${mins}m` : `${totalHr}h`;
  }
  if (totalMin >= 1) {
    const secs = totalSec % 60;
    return secs > 0 ? `${totalMin}m ${secs}s` : `${totalMin}m`;
  }
  return `${totalSec}s`;
}
