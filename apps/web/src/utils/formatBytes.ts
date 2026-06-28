// formatBytes: converts BigInt-safe string or bigint to human-readable storage
// Uses BigInt arithmetic to avoid precision loss
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
  // For decimal display: get the original in the chosen unit as a float
  const divisor = 1024n ** BigInt(unitIndex);
  const whole = Number(val / divisor);
  const remainder = Number(val % divisor) / Number(divisor);
  const display = (whole + remainder).toFixed(unitIndex === 0 ? 0 : 2);
  return `${display} ${units[unitIndex]}`;
}

// formatCompactNumber: e.g. 1234 → "1.2K", 4217 → "4,217"
export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: n >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(n);
}

// percent: BigInt-safe ratio Part/Whole → number 0-100
export function percent(part: string | number, whole: string | number): number {
  const w = typeof whole === 'string' ? BigInt(whole) : BigInt(whole);
  if (w === 0n) return 0;
  const p = typeof part === 'string' ? BigInt(part) : BigInt(part);
  // Scale to avoid int truncation: multiply by 10000n then divide
  return Number((p * 10000n) / w) / 100;
}

// bytesToNumber: safe BigInt-string → Number conversion for chart proportions.
// Raw byte counts for a single media type are always well within Number's
// safe integer range (2^53 ≈ 9 PB), so the donut can use raw byte counts
// for correct proportions without the integer-truncation-to-zero bug that
// bytesToMB() had for sub-1MB types.
export function bytesToNumber(bytes: string): number {
  return Number(BigInt(bytes));
}

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

// relativeTime: simple inline relative time (no date-fns dependency)
export function relativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
