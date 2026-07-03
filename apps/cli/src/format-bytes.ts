/**
 * format-bytes.ts — Human-readable byte sizes.
 *
 * Base 1024. Bytes are shown as a whole number; KB and larger use one decimal.
 *   formatBytes(0)     → "0 B"
 *   formatBytes(512)   → "512 B"
 *   formatBytes(1536)  → "1.5 KB"
 *   formatBytes(1048576) → "1.0 MB"
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Bytes: whole number. Everything else: one decimal.
  const formatted = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${UNITS[unit]}`;
}
