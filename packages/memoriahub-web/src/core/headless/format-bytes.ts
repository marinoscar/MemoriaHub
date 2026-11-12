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
