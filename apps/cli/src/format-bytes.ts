/**
 * format-bytes.ts — Human-readable byte size from a number of bytes.
 *
 * Uses binary units (1 KB = 1024 B) with adaptive precision:
 *   < 1 KB   → "512 B"
 *   < 1 MB   → "4.2 KB"
 *   < 1 GB   → "13.7 MB"
 *   < 1 TB   → "2.4 GB"
 *   else     → "1.1 TB"
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // One decimal below 100, none at/above (e.g. "4.2 KB" but "137 MB").
  const decimals = value >= 100 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
