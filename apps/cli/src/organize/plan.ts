/**
 * organize/plan.ts — Pure path-planning helpers for the `organize` command.
 *
 * These functions decide WHERE a file should live once organized, without
 * moving anything themselves.  The only side effect any of them has is reading
 * the filesystem to check for name collisions (fs.existsSync) — they never
 * create, move, or delete files.  Keeping the planning logic pure makes it
 * trivially unit-testable and lets the engine own all the real I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Full English month names, index 0 = January. */
export const MONTH_NAMES: string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Compute the destination sub-folder segments for a capture date + GPS presence.
 *
 * A `null` date (no EXIF capture date — includes every video) buckets into a
 * single top-level `NODATE/` folder.  A real date buckets into
 * `YEAR/MM - Month/` (e.g. `2023/07 - July`).
 *
 * When `hasGps` is false, a final `NO-GPS/` segment is appended so files
 * missing EXIF location are grouped together WITHIN their date bucket — applied
 * uniformly, including under `NODATE`. The four resulting shapes are:
 *   has date + has GPS → `2023/07 - July`
 *   has date + no GPS  → `2023/07 - July/NO-GPS`
 *   no date  + has GPS → `NODATE`
 *   no date  + no GPS  → `NODATE/NO-GPS`
 *
 * LOCAL getters are used deliberately: EXIF capture dates are naive wall-clock
 * timestamps, so an item must bucket by the local date it was recorded, not the
 * UTC date (which can shift across a day boundary).
 */
export function bucketFor(date: Date | null, hasGps: boolean): string[] {
  const segments =
    date === null
      ? ['NODATE']
      : [
          String(date.getFullYear()),
          `${String(date.getMonth() + 1).padStart(2, '0')} - ${MONTH_NAMES[date.getMonth()]}`,
        ];
  if (!hasGps) {
    segments.push('NO-GPS');
  }
  return segments;
}

/**
 * Join a root directory, the bucket segments, and a file name into an absolute
 * target path.  Pure — does not touch disk.
 */
export function targetPathFor(rootDir: string, segments: string[], fileName: string): string {
  return path.join(rootDir, ...segments, fileName);
}

/**
 * Resolve a collision-free destination path.
 *
 * If nothing exists at `desiredPath` — or the file that exists there IS the
 * source file itself (comparing resolved absolute paths) — the desired path is
 * returned unchanged.  Otherwise a ` (1)`, ` (2)`, … suffix is appended before
 * the extension until a free name is found.  This never returns a path that
 * would overwrite a DIFFERENT existing file.
 */
export function resolveCollision(desiredPath: string, sourcePath: string): string {
  const sourceAbs = path.resolve(sourcePath);

  const isFree = (candidate: string): boolean => {
    if (!fs.existsSync(candidate)) return true;
    // An existing entry that IS the source file is not a real collision — it
    // means the file is already in place (idempotent re-run).
    return path.resolve(candidate) === sourceAbs;
  };

  if (isFree(desiredPath)) return desiredPath;

  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const base = path.basename(desiredPath, ext);

  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (isFree(candidate)) return candidate;
  }
}
