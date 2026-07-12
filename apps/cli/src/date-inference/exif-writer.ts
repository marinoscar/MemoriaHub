/**
 * date-inference/exif-writer.ts — ExifTool-backed capture-date writer.
 *
 * `exiftool-vendored` is an OPTIONAL dependency (see apps/cli/package.json) —
 * only the `apply` phase of Date Inference needs it, so it is dynamically
 * imported here and never pulled in by the read-only `diagnose` phase.
 *
 * It vendors the ExifTool script itself (`exiftool-vendored.pl` on
 * macOS/Linux — needs a `perl` interpreter on PATH, which ships by default on
 * virtually every POSIX system; `exiftool-vendored.exe` — a self-contained
 * compiled binary — on Windows), so this is NOT "please go install ExifTool
 * yourself". Detection still has to be defensive: the optional install may
 * have been skipped (`--no-optional`), or `perl` may be missing.
 *
 * Mirrors convert/ffmpeg.ts's detectFfmpeg() memoization/failure-shape
 * discipline.
 */

import type { FilenameDateMatch } from './filename-date.js';

// Loaded lazily; typed loosely to avoid a hard compile-time dependency on the
// optional package's types when it isn't installed.
type ExiftoolModule = {
  exiftool: {
    version(): Promise<string>;
    write(
      file: string,
      tags: Record<string, unknown>,
      options?: { writeArgs?: string[] },
    ): Promise<unknown>;
    end(): Promise<unknown>;
  };
};

let _mod: Promise<ExiftoolModule | null> | null = null;

/** Dynamically import exiftool-vendored, resolving `null` if unavailable. */
function loadExiftool(): Promise<ExiftoolModule | null> {
  if (!_mod) {
    _mod = import('exiftool-vendored').then(
      (m) => m as unknown as ExiftoolModule,
      () => null,
    );
  }
  return _mod;
}

export interface ExiftoolInfo {
  available: boolean;
  version?: string;
}

let cachedDetect: Promise<ExiftoolInfo> | null = null;

/**
 * Detect whether ExifTool is usable (package installed AND, on POSIX, `perl`
 * on PATH to run the vendored script). Never throws — resolves
 * `{ available: false }` on any failure. Memoized for the process lifetime.
 */
export function detectExiftool(): Promise<ExiftoolInfo> {
  if (cachedDetect) return cachedDetect;

  cachedDetect = (async () => {
    try {
      const mod = await loadExiftool();
      if (!mod) return { available: false };
      const version = await mod.exiftool.version();
      return { available: true, version };
    } catch {
      return { available: false };
    }
  })();

  return cachedDetect;
}

/** Per-platform install/recovery hint shown when ExifTool is unavailable. */
export function exiftoolInstallHint(): string {
  return (
    'ExifTool is bundled with the CLI as an optional dependency and could not be loaded. ' +
    'Reinstall with optional dependencies included (`npm install --include=optional -g @memoriahub/cli`), ' +
    'and on Linux/macOS make sure a `perl` interpreter is on your PATH (it ships by default on almost every system).'
  );
}

function formatExifDateTime(match: FilenameDateMatch): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${match.year}:${p(match.month)}:${p(match.day)} ${p(match.hour)}:${p(match.minute)}:${p(match.second)}`;
}

export interface WriteCapturedDateResult {
  ok: boolean;
  error?: string;
}

/**
 * Write `match` into `filePath`'s capture-date metadata via ExifTool's
 * `AllDates` shortcut tag, which ExifTool maps to the correct tag group per
 * file format automatically — EXIF `DateTimeOriginal`/`CreateDate`/
 * `ModifyDate` for photos, QuickTime/MP4 `CreateDate`/`ModifyDate` atoms for
 * videos — so this one call covers both media kinds.
 *
 * `-overwrite_original` is passed explicitly (ExifTool's default leaves a
 * `<file>_original` backup copy next to every file, which this tool does not
 * want — the local mutation is intentional).
 *
 * Never throws: any failure (permission denied, corrupt file, a format
 * ExifTool can't write) resolves `{ ok: false, error }` so one bad file never
 * aborts a batch.
 */
export async function writeCapturedDate(
  filePath: string,
  match: FilenameDateMatch,
): Promise<WriteCapturedDateResult> {
  try {
    const mod = await loadExiftool();
    if (!mod) {
      return { ok: false, error: 'ExifTool is not available' };
    }
    await mod.exiftool.write(
      filePath,
      { AllDates: formatExifDateTime(match) },
      { writeArgs: ['-overwrite_original'] },
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Shut down the shared ExifTool child process. `exiftool-vendored` keeps a
 * single long-lived process alive across every `write()` call (much faster
 * than spawning one per file), so callers should invoke this exactly once
 * after a whole `apply` run finishes — never per file. Safe to call even if
 * ExifTool was never loaded (no-op).
 */
export async function endExiftool(): Promise<void> {
  if (!_mod) return;
  const mod = await _mod;
  if (mod) await mod.exiftool.end();
}
