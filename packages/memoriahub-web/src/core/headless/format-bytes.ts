/**
 * Formats a byte count as a human-readable size (`1.50 MB`).
 *
 * @remarks
 * Uses BigInt arithmetic, so a count the API serialises as a string (a `BigInt` column) never loses precision.
 *
 * @param bytes - the count, as the API's string or a bigint.
 * @returns the size with the largest unit that keeps the value at least 1.
 *
 * @stability experimental
 */
export function formatBytes(bytes: string | bigint): string {
  const val = typeof bytes === 'string' ? BigInt(bytes) : bytes;
  if (val === 0n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unitIndex = 0;
  let reduced = val;
  while (reduced >= 1024n && unitIndex < units.length - 1) {
    reduced = reduced / 1024n;
    unitIndex++;
  }
  const divisor = 1024n ** BigInt(unitIndex);
  const whole = Number(val / divisor);
  const remainder = Number(val % divisor) / Number(divisor);
  const display = (whole + remainder).toFixed(unitIndex === 0 ? 0 : 2);
  return `${display} ${units[unitIndex]}`;
}

/**
 * Formats a count compactly: `4,217` stays whole, `12480` becomes `12.5K`.
 *
 * @param n - the count.
 * @returns the formatted count (compact notation from 10,000).
 *
 * @stability experimental
 */
export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: n >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n);
}

/**
 * The ratio `part / whole` as a percentage from 0 to 100, computed in BigInt so a count the API serialises as a string never loses precision.
 *
 * @param part - the numerator, as the API's string or a number.
 * @param whole - the denominator; `0` yields `0`.
 * @returns the percentage with two decimals.
 *
 * @stability experimental
 */
export function percent(part: string | number, whole: string | number): number {
  const w = BigInt(whole);
  if (w === 0n) return 0;
  const p = BigInt(part);
  // Scale before dividing so the integer division does not truncate the fraction.
  return Number((p * 10000n) / w) / 100;
}

/**
 * Converts a BigInt string to a number, for chart proportions (a single media type's byte count is far inside the safe integer range).
 *
 * @param bytes - the count as the API's string.
 * @returns the number.
 *
 * @stability experimental
 */
export function bytesToNumber(bytes: string): number {
  return Number(BigInt(bytes));
}

/**
 * A short relative time (`just now`, `5m ago`, `3h ago`, `2d ago`).
 *
 * @param isoString - the instant, ISO 8601.
 * @returns the relative time.
 *
 * @stability experimental
 */
export function relativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
