/**
 * export/xlsx-format.ts — Shared Excel number/date formatting for report exports.
 *
 * Kept in one place so the scan and sync workbooks format sizes and dates
 * identically.
 */

/** Excel datetime number format applied to date columns/cells. */
export const DATE_FMT = 'yyyy-mm-dd hh:mm:ss';

/** Excel number format for megabyte sizes: thousands separator + 2 decimals. */
export const MB_FMT = '#,##0.00';

/** Excel integer format with thousands separators. */
export const INT_FMT = '#,##0';

/** Convert a byte count to megabytes, rounded to 2 decimals (null passes through). */
export function bytesToMb(bytes: number | null | undefined): number | null {
  if (bytes === null || bytes === undefined) return null;
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/** Parse an ISO string to a Date, or null when missing/unparseable. */
export function isoToDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}
