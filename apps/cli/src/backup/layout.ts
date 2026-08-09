/**
 * backup/layout.ts — Backup root directory layout (issue #314, epic #308).
 *
 * Owns every decision about WHERE a backed-up file lives under a backup root:
 *
 *   <root>/media/YYYY/MM/          active items (bucketed by human-local capture date)
 *   <root>/media/unknown-date/     capturedAt null (NO fallback to upload date)
 *   <root>/archived/YYYY/MM/       archivedAt non-null — own tree, never mixed with media/
 *   <root>/archived/unknown-date/
 *   <root>/<file>.json             per-item sidecar next to each file
 *   <root>/_quarantine/            used by a later child; created here
 *   <root>/catalog/                albums/people/tags/manifest.json catalogs
 *   <root>/.memoriahub/backup.db   SQLite catalog
 *   <root>/.memoriahub/tmp/        in-flight .part downloads
 *
 * Pure planning helpers plus two writers (writeSidecar, moveItemFiles).
 * NOTHING here prints — this module returns typed results and throws typed
 * errors; all terminal output belongs to the command layer.
 *
 * Rel-path convention: catalog rel_paths ALWAYS use forward slashes ('/'),
 * regardless of platform, so a backup folder moved between OSes keeps a
 * consistent catalog. Convert to a native absolute path via absPathFor().
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { utcMonthBucket } from '../dates/month-bucket.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const MEDIA_DIR = 'media';
export const ARCHIVED_DIR = 'archived';
export const UNKNOWN_DATE_DIR = 'unknown-date';
export const QUARANTINE_DIR = '_quarantine';
export const CATALOG_DIR = 'catalog';
export const STATE_DIR = '.memoriahub';
export const TMP_DIR = `${STATE_DIR}/tmp`;
/** Rel path of the SQLite catalog — a PLAIN SQLite file users may query directly. */
export const CATALOG_DB_REL_PATH = `${STATE_DIR}/backup.db`;

/** Fallback base name when sanitization leaves an empty filename. */
const FALLBACK_BASENAME = 'file';

/** Maximum UTF-8 byte length of a backed-up filename. */
const MAX_FILENAME_BYTES = 200;

/** Windows-reserved device names (case-insensitive, also reserved WITH an extension). */
const WINDOWS_RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// ---------------------------------------------------------------------------
// Root skeleton
// ---------------------------------------------------------------------------

/**
 * Create the fixed directory skeleton under `root` (idempotent). The dated
 * YYYY/MM buckets are created lazily by the writers as items land.
 */
export function createRootSkeleton(root: string): void {
  for (const rel of [MEDIA_DIR, ARCHIVED_DIR, QUARANTINE_DIR, CATALOG_DIR, TMP_DIR]) {
    fs.mkdirSync(absPathFor(root, rel), { recursive: true });
  }
}

/** Convert a forward-slash rel path to a native absolute path under `root`. */
export function absPathFor(root: string, relPath: string): string {
  return path.join(root, ...relPath.split('/'));
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

/**
 * Date-bucket segments for an item: ['YYYY', 'MM'] from `capturedAt` shifted
 * by `capturedAtOffset` MINUTES (the human-local capture date), or
 * ['unknown-date'] when `capturedAt` is null. Deliberately NO fallback to an
 * upload/import date — an undated item must be findable in one place.
 */
export function bucketSegments(
  capturedAt: string | Date | null,
  capturedAtOffset: number | null,
): string[] {
  if (capturedAt === null) return [UNKNOWN_DATE_DIR];
  const instant = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  if (Number.isNaN(instant.getTime())) return [UNKNOWN_DATE_DIR];
  // Shift the UTC instant by the capture-time UTC offset (minutes); the UTC
  // fields of the shifted Date are exactly the human-local capture date.
  const shifted = new Date(instant.getTime() + (capturedAtOffset ?? 0) * 60_000);
  const bucket = utcMonthBucket(shifted);
  return [bucket.year, bucket.month];
}

/** Which tree an item's file belongs in. Trash does NOT move a file — see planRelPath. */
export type BackupTree = typeof MEDIA_DIR | typeof ARCHIVED_DIR;

/** Tree selection: archived items live under archived/, everything else under media/. */
export function treeFor(archivedAt: string | null): BackupTree {
  return archivedAt !== null ? ARCHIVED_DIR : MEDIA_DIR;
}

// ---------------------------------------------------------------------------
// Filename sanitization
// ---------------------------------------------------------------------------

/** Trim `value` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function trimUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = '';
  let bytes = 0;
  // Iterate by code point so surrogate pairs are never split.
  for (const ch of value) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

/**
 * Sanitize an original filename for use inside the backup tree:
 *  - control characters stripped;
 *  - path separators and invalid characters (<>:"/\|?*) replaced with '_';
 *  - leading/trailing dots and spaces trimmed (Windows compatibility);
 *  - Windows-reserved device names (CON, PRN, AUX, NUL, COM1..9, LPT1..9 —
 *    case-insensitive, including with an extension) prefixed with '_';
 *  - trimmed to 200 UTF-8 bytes, preserving the extension where possible;
 *  - falls back to 'file' when nothing usable remains.
 */
export function sanitizeFilename(original: string): string {
  // Strip control chars, then replace separators + Windows-invalid chars.
  let name = original
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_');

  // Windows disallows trailing dots/spaces; leading dots would hide the file.
  name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '');

  if (name.length === 0) return FALLBACK_BASENAME;

  // Split extension for the reserved-name guard and byte trimming.
  const ext = path.posix.extname(name);
  let stem = ext.length > 0 ? name.slice(0, -ext.length) : name;

  if (stem.length === 0) {
    // Input was only an extension, e.g. sanitization left ".jpg" → "file.jpg"
    // (the leading-dot trim above makes this unreachable in practice, but the
    // guard keeps the function total).
    stem = FALLBACK_BASENAME;
  }

  if (WINDOWS_RESERVED.has(stem.toUpperCase())) {
    stem = `_${stem}`;
  }

  // Enforce the byte cap, sacrificing the stem before the extension.
  const extBytes = Buffer.byteLength(ext, 'utf8');
  if (extBytes >= MAX_FILENAME_BYTES) {
    // Pathological extension longer than the whole budget — trim outright.
    return trimUtf8(stem + ext, MAX_FILENAME_BYTES) || FALLBACK_BASENAME;
  }
  const stemBudget = MAX_FILENAME_BYTES - extBytes;
  let trimmedStem = trimUtf8(stem, stemBudget);
  if (trimmedStem.length === 0) trimmedStem = FALLBACK_BASENAME;
  return trimmedStem + ext;
}

// ---------------------------------------------------------------------------
// Rel-path planning (collision policy)
// ---------------------------------------------------------------------------

/** Append `~suffix` to a filename before its extension. */
function withSuffix(fileName: string, suffix: string): string {
  const ext = path.posix.extname(fileName);
  const stem = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return `${stem}~${suffix}${ext}`;
}

export interface PlanRelPathInput {
  mediaItemId: string;
  originalFilename: string;
  /** ISO instant or null (no EXIF capture date). */
  capturedAt: string | Date | null;
  /** Capture-time UTC offset in MINUTES, or null (treated as UTC). */
  capturedAtOffset: number | null;
  /** ISO instant or null — selects the archived/ tree. */
  archivedAt: string | null;
}

/**
 * Returns the mediaItemId that already claims `relPath` in the catalog, or
 * null when the path is free. Injected so this module stays storage-agnostic.
 */
export type RelPathOwnerLookup = (relPath: string) => string | null;

/**
 * Plan the catalog rel_path for an item. Deterministic and stable: the same
 * item always plans the same path, and a path claimed by a DIFFERENT
 * mediaItemId gets a `~<first8ofMediaItemId>` suffix before the extension
 * (falling back to the full id in the astronomically-unlikely double
 * collision). The chosen rel_path is recorded in the catalog and is stable
 * forever — later renames of originalFilename do NOT move the local file.
 *
 * Note on Trash: a trashed item (deletedAt set) KEEPS its current rel_path
 * (status 'trashed', no move) — callers must not re-plan a path for it.
 */
export function planRelPath(item: PlanRelPathInput, ownerOf: RelPathOwnerLookup): string {
  const segments = [treeFor(item.archivedAt), ...bucketSegments(item.capturedAt, item.capturedAtOffset)];
  const fileName = sanitizeFilename(item.originalFilename);

  const claimedByOther = (relPath: string): boolean => {
    const owner = ownerOf(relPath);
    return owner !== null && owner !== item.mediaItemId;
  };

  const plain = path.posix.join(...segments, fileName);
  if (!claimedByOther(plain)) return plain;

  const short = path.posix.join(...segments, withSuffix(fileName, item.mediaItemId.slice(0, 8)));
  if (!claimedByOther(short)) return short;

  // Full-id suffix is unique per mediaItemId by construction.
  return path.posix.join(...segments, withSuffix(fileName, item.mediaItemId));
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

/** Sidecar rel path: the item's rel_path plus '.json', side by side. */
export function sidecarRelPathFor(relPath: string): string {
  return `${relPath}.json`;
}

/**
 * Atomically write the server-composed schemaVersion-1 sidecar payload next to
 * the item's file: a temp file in the SAME directory (same filesystem, so the
 * final rename is atomic) then rename over the destination. The payload is
 * written verbatim (serialized as-is, no re-derivation). Returns the sidecar
 * rel path.
 */
export function writeSidecar(root: string, relPath: string, sidecar: unknown): string {
  const sidecarRel = sidecarRelPathFor(relPath);
  const abs = absPathFor(root, sidecarRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2));
    fs.renameSync(tmp, abs);
  } catch (err) {
    // Never leave a temp file behind on failure.
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return sidecarRel;
}

// ---------------------------------------------------------------------------
// Archive / unarchive transitions
// ---------------------------------------------------------------------------

export interface TreeTransition {
  fromRelPath: string;
  toRelPath: string;
  /** False when the item is already in the right tree (nothing to move). */
  changed: boolean;
}

/**
 * Compute the move an archive/unarchive transition implies: the leading tree
 * segment flips between media/ and archived/ while the date bucket and
 * filename (the stable part of the rel_path) are preserved. A rel_path outside
 * both trees (e.g. _quarantine/) is left untouched.
 */
export function planTreeTransition(currentRelPath: string, archivedAt: string | null): TreeTransition {
  const targetTree = treeFor(archivedAt);
  const segments = currentRelPath.split('/');
  const currentTree = segments[0];

  if (
    (currentTree !== MEDIA_DIR && currentTree !== ARCHIVED_DIR) ||
    currentTree === targetTree
  ) {
    return { fromRelPath: currentRelPath, toRelPath: currentRelPath, changed: false };
  }

  const toRelPath = [targetTree, ...segments.slice(1)].join('/');
  return { fromRelPath: currentRelPath, toRelPath, changed: true };
}

/** Rename with a cross-device (EXDEV) fallback to copy + unlink. */
export function renameWithFallback(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

/**
 * Move an item's file AND its sidecar from one rel_path to another (an
 * archive/unarchive transition). The sidecar move is conditional on the
 * sidecar existing; the media file must exist. Returns the new rel_path so
 * callers can record it in the catalog.
 */
export function moveItemFiles(root: string, fromRelPath: string, toRelPath: string): string {
  if (fromRelPath === toRelPath) return toRelPath;

  const fromAbs = absPathFor(root, fromRelPath);
  const toAbs = absPathFor(root, toRelPath);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  renameWithFallback(fromAbs, toAbs);

  const fromSidecar = absPathFor(root, sidecarRelPathFor(fromRelPath));
  if (fs.existsSync(fromSidecar)) {
    renameWithFallback(fromSidecar, absPathFor(root, sidecarRelPathFor(toRelPath)));
  }
  return toRelPath;
}
