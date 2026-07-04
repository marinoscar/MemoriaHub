/**
 * sync/date-range.ts — Capture-date range parsing for the `sync` command.
 *
 * A small, dependency-free helper that turns the optional `--from` / `--to`
 * CLI options into an inclusive epoch-ms window the SyncEngine filters capture
 * dates against.  Bare `YYYY-MM-DD` inputs are interpreted in LOCAL time —
 * `from` snaps to the start of the day (00:00:00.000), `to` to the end of the
 * day (23:59:59.999) — so a same-day `--from`/`--to` covers the whole day the
 * user meant.  Full ISO 8601 datetimes are parsed as-is.
 *
 * Like the other files in this directory the engine stays UI-free: parsing
 * failures are surfaced as thrown Errors for the command layer to present.
 */

/** Inclusive epoch-ms bounds on capture date; undefined = unbounded that side. */
export interface DateRange {
  fromMs?: number;
  toMs?: number;
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a single bound. `which` selects the day-edge for bare dates. */
function parseBound(
  raw: string | undefined,
  which: 'from' | 'to',
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map((s) => parseInt(s, 10));
    // Construct in LOCAL time at the appropriate day edge.
    const dt =
      which === 'from'
        ? new Date(y, m - 1, d, 0, 0, 0, 0)
        : new Date(y, m - 1, d, 23, 59, 59, 999);
    const ms = dt.getTime();
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid --${which} date: "${raw}" (expected YYYY-MM-DD)`);
    }
    return ms;
  }

  // Full ISO 8601 datetime — parse as-is.
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --${which} date: "${raw}" (expected YYYY-MM-DD)`);
  }
  return ms;
}

/**
 * Parse `--from` / `--to` into an inclusive epoch-ms range.
 *
 * @throws Error on unparseable input, or when `fromMs > toMs`.
 */
export function parseDateRange(from?: string, to?: string): DateRange {
  const fromMs = parseBound(from, 'from');
  const toMs = parseBound(to, 'to');

  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new Error('--from must be on or before --to');
  }

  return { fromMs, toMs };
}

/** Format epoch-ms as `YYYY-MM-DD` in LOCAL time. */
function ymdLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Human-readable one-line description of a range for informational output.
 * `"all dates"` when unbounded; `"A → B"`, `"on/after A"`, or `"on/before B"`.
 */
export function describeRange(r: DateRange): string {
  const hasFrom = r.fromMs !== undefined;
  const hasTo = r.toMs !== undefined;

  if (!hasFrom && !hasTo) return 'all dates';
  if (hasFrom && hasTo) return `${ymdLocal(r.fromMs!)} → ${ymdLocal(r.toMs!)}`;
  if (hasFrom) return `on/after ${ymdLocal(r.fromMs!)}`;
  return `on/before ${ymdLocal(r.toMs!)}`;
}
