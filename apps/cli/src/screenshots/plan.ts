/**
 * screenshots/plan.ts — Pure matching + path-planning helpers for the
 * `screenshots` command.
 *
 * A file is considered a "screenshot" purely by filename: the case-insensitive
 * substring "screenshot" anywhere in the base filename (e.g. `Screenshot
 * 2024-01-02.png`, `img_screenshot_01.jpg`, `SCREENSHOT.HEIC`). Unlike
 * `enumerateFiles` (files.ts), this walker does NOT restrict to known media
 * extensions — a screenshot could carry any extension — so every regular file
 * is inspected by name.
 *
 * `findScreenshotFiles` is the only function here with a filesystem side
 * effect (reading directory entries + file sizes); it never moves or deletes
 * anything. Collision-free destination resolution is reused from
 * organize/plan.ts, which is generic path-planning logic with no
 * organize-specific coupling.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { OVERRIDE_FILENAME } from '../override.js';

export { resolveCollision } from '../organize/plan.js';

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** True when the file's base name contains "screenshot", case-insensitively. */
export function isScreenshotFile(filePath: string): boolean {
  return /screenshot/i.test(path.basename(filePath));
}

export interface ScreenshotMatch {
  filePath: string;
  /** File size in bytes; 0 if the size could not be read (e.g. a race with deletion). */
  size: number;
}

/**
 * Walk `folderPath` (optionally recursive) and collect every regular file
 * whose name matches `isScreenshotFile`. Unreadable directories are logged as
 * warnings and skipped, mirroring `enumerateFiles`'s behavior — one bad
 * sub-directory never aborts the walk.
 */
export function findScreenshotFiles(folderPath: string, recursive: boolean): ScreenshotMatch[] {
  const matches: ScreenshotMatch[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(
        `Warning: cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === OVERRIDE_FILENAME) continue;
      if (!isScreenshotFile(entry.name)) continue;

      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        // Unreadable (e.g. deleted mid-walk) — still record it with size 0
        // rather than silently dropping a match the user asked to see.
      }
      matches.push({ filePath: full, size });
    }
  }

  walk(path.resolve(folderPath));
  return matches;
}
