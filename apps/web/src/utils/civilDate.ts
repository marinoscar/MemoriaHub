/**
 * Rendering helpers for **civil timestamps** (issue #442, epic #440).
 *
 * See `docs/specs/date-model.md`. The one-paragraph version:
 *
 * MemoriaHub stores two kinds of value in `timestamptz` columns with nothing
 * in the type distinguishing them.
 *
 * - A **civil timestamp** is the wall clock *at the place and moment of
 *   capture*, re-encoded as UTC (`packages/enrichment-compute/src/metadata`
 *   builds it with `Date.UTC(...)` from the tz-naive EXIF fields). The `Z` is
 *   a storage costume, not a real offset. `capturedAt`, `originalCreatedAt`,
 *   a burst/duplicate group's `capturedAt`, and a memory's
 *   `periodStart`/`periodEnd` are all civil.
 * - An **instant** is a real point in time: `importedAt`, `createdAt`,
 *   `updatedAt`, run timestamps, token expiry, and so on.
 *
 * **A photo's date is a fact about where it was taken, not about where the
 * viewer is standing.** A photo shot in Tokyo must not re-file itself to a
 * different day when its owner travels to Miami. So a civil timestamp is
 * always rendered in **UTC** — reading the stored components back out
 * unchanged yields the photographer's own clock. Applying the viewer's zone
 * (or the user's timezone preference) to one applies an offset a *second*
 * time and files a band of hours near midnight under the wrong day, which is
 * exactly the bug these helpers exist to prevent.
 *
 * ⚠️ These helpers are for civil values ONLY. Instants must keep rendering on
 * the ordinary browser-local path (`toLocaleString()` with no `timeZone`), or
 * the user's stored timezone once one is applied — pinning an instant to UTC
 * is the mirror-image bug.
 */

/** Locale-independent `YYYY-MM-DD` for a civil timestamp, read in UTC. */
export function civilDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'undated';
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format a civil timestamp's date. Locale stays browser-derived
 * (`undefined`); only the *zone* is pinned, so a user still sees their own
 * date order and month names.
 */
export function formatCivilDate(
  iso: string,
  opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

/**
 * Format a civil timestamp's date *and* time — the photographer's wall clock.
 */
export function formatCivilDateTime(
  iso: string,
  opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { ...opts, timeZone: 'UTC' });
}

/**
 * Value for a `<input type="datetime-local">` bound to a civil timestamp.
 *
 * `datetime-local` has no zone, which makes it the right control for a civil
 * value — but only if both directions read and write the SAME zone. Reading
 * the UTC components back out is what puts the photographer's clock in the
 * box.
 */
export function isoToCivilInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16);
}

/**
 * The inverse of {@link isoToCivilInput}: a `datetime-local` value back to a
 * stored civil timestamp.
 *
 * ⚠️ `new Date('2026-06-20T20:16')` parses a zone-less string as **browser
 * local** time, so the obvious `new Date(value).toISOString()` shifts the
 * value by the viewer's offset on every save — round-tripping the edit form
 * without changing anything silently moved a photo by six hours. Appending
 * the `Z` re-encodes the wall clock as UTC, matching how ingest stores it.
 */
export function civilInputToIso(value: string): string | null {
  if (!value) return null;
  // `YYYY-MM-DDTHH:mm` (browsers may include `:ss`); normalise to full ISO.
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const d = new Date(`${withSeconds}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * The viewer-local `YYYY-MM-DD` for an **instant**.
 *
 * Lives beside the civil helpers deliberately: day-grouping mixes the two
 * kinds (see `groupByDay`), and having both spellings in one file makes the
 * choice at each call site explicit rather than accidental.
 */
export function instantDayKey(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'undated';
  // `en-CA` yields ISO-ordered `YYYY-MM-DD` regardless of the user's locale.
  try {
    return d.toLocaleDateString('en-CA', timeZone ? { timeZone } : undefined);
  } catch {
    return d.toLocaleDateString('en-CA');
  }
}
