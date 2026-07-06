/**
 * convert/plan.ts — Pure planning helpers for the `convert` command.
 *
 * Decides WHICH files are convertible and WHERE each `.mp4` should be written,
 * without touching ffmpeg or moving anything.  The only side effect is reading
 * the filesystem to check for name collisions (fs.existsSync).  Keeping this
 * pure makes it trivially unit-testable and lets the engine own the real I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MIME_BY_EXT } from '../files.js';

/**
 * Extensions that are already MP4 containers — converting them adds no value,
 * so they are never treated as convertible sources even though `.m4v` maps to a
 * `video/` MIME.
 */
export const MP4_CONTAINER_EXTS: ReadonlySet<string> = new Set(['mp4', 'm4v']);

/** Lowercased extension (no leading dot) of a path, or '' when there is none. */
export function extOf(filePath: string): string {
  return path.extname(filePath).replace('.', '').toLowerCase();
}

/**
 * Is `filePath` a convertible video?
 *
 * Convertible when its extension maps to a `video/*` MIME (per the shared
 * `MIME_BY_EXT` map) AND it is not already an MP4 container.  When `restrict`
 * is supplied (from `--formats`), the extension must also be a member.
 */
export function isConvertibleVideo(filePath: string, restrict?: ReadonlySet<string>): boolean {
  const ext = extOf(filePath);
  if (!ext) return false;
  if (MP4_CONTAINER_EXTS.has(ext)) return false;
  const mime = MIME_BY_EXT[ext];
  if (!mime || !mime.startsWith('video/')) return false;
  if (restrict && !restrict.has(ext)) return false;
  return true;
}

/**
 * Parse a `--formats mov,mts,avi` list into a lowercased extension set, or
 * `undefined` when the input is empty (meaning "all convertible videos").
 */
export function parseFormats(raw?: string): ReadonlySet<string> | undefined {
  if (!raw) return undefined;
  const exts = raw
    .split(',')
    .map((s) => s.trim().replace(/^\./, '').toLowerCase())
    .filter((s) => s.length > 0);
  return exts.length > 0 ? new Set(exts) : undefined;
}

/**
 * The desired `.mp4` output path for a source file: same directory, same
 * basename, `.mp4` extension.  Pure — does not touch disk.
 */
export function targetPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  return path.join(dir, `${base}.mp4`);
}

/**
 * Resolve a collision-free `.mp4` destination path.
 *
 * If nothing exists at `desiredPath` it is returned unchanged.  Otherwise a
 * ` (1)`, ` (2)`, … suffix is appended before the extension until a free name is
 * found.  Unlike organize's `resolveCollision`, the source and target always
 * differ by extension here, so there is no "is it the source" branch.
 */
export function resolveConvertCollision(desiredPath: string): string {
  if (!fs.existsSync(desiredPath)) return desiredPath;

  const dir = path.dirname(desiredPath);
  const ext = path.extname(desiredPath);
  const base = path.basename(desiredPath, ext);

  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
