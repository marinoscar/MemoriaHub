/**
 * exif-carryover.service.ts — file-level EXIF carryover + AI-marker stamp for
 * AI-enhanced images (spec docs/specs/picture-enhancer.md §5.1(A) / §5.4).
 *
 * The OpenAI images.edit response is a freshly-synthesized JPEG carrying ZERO
 * metadata: a user who DOWNLOADS an enhanced photo would lose its capture date,
 * GPS, and camera info even though the in-app columns were copied. This service
 * closes that gap by copying the original file's metadata blocks onto the
 * enhanced bytes and stamping an honest "this was AI-modified" marker on top.
 *
 * `exiftool-vendored` vendors the ExifTool script itself — on POSIX that is
 * `exiftool-vendored.pl`, which needs a `perl` interpreter on PATH (installed in
 * apps/api/Dockerfile's base stage, in lockstep with apps/cli/Dockerfile). It is
 * imported LAZILY and defensively, mirroring apps/cli/src/date-inference/
 * exif-writer.ts, so a stripped install or a missing perl degrades to a no-op
 * instead of crashing the enrichment worker.
 *
 * STRICTLY BEST-EFFORT: every failure path returns the enhanced buffer
 * UNCHANGED. Nothing in here may throw — a metadata stamp must never fail an
 * enhancement job that otherwise produced good pixels.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Loaded lazily; typed loosely so the API compiles even when the (hoisted)
 * package is absent from a given install.
 */
type ExiftoolModule = {
  exiftool: {
    write(
      file: string,
      tags: Record<string, unknown>,
      options?: { writeArgs?: string[] },
    ): Promise<unknown>;
    end(): Promise<unknown>;
  };
};

/**
 * IPTC "digital source type" NewsCode for media produced by compositing real
 * content with trained-algorithmic (generative) output — the standard,
 * machine-readable marker for an AI-modified photograph. This is what makes the
 * downloaded file honestly self-describing to any conformant viewer.
 */
export const AI_DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

/** Metadata blocks copied wholesale from the ORIGINAL onto the enhanced file. */
const CARRIED_TAG_GROUPS = [
  '-EXIF:all',
  '-GPS:all',
  '-IPTC:all',
  '-XMP:all',
  '-ICC_Profile',
];

export interface ExifCarryoverOptions {
  /** Model id, embedded in the human-readable Software/CreatorTool strings. */
  model: string;
  /** ACTUAL pixel width of the enhanced output (NOT the requested canvas). */
  width?: number | null;
  /** ACTUAL pixel height of the enhanced output. */
  height?: number | null;
  /**
   * Extension hint for the temp copy of the original (e.g. `.heic`), so
   * ExifTool type-detects the source the same way it would in storage.
   */
  originalExtension?: string;
}

@Injectable()
export class ExifCarryoverService implements OnModuleDestroy {
  private readonly logger = new Logger(ExifCarryoverService.name);

  /**
   * Memoized dynamic import — resolves `null` when the package (or its perl
   * runtime) is unavailable. Instance-scoped rather than module-scoped so tests
   * get a clean slate per service instance.
   */
  private modPromise: Promise<ExiftoolModule | null> | null = null;

  /** Whether `end()` has anything to shut down (see onModuleDestroy). */
  private loaded = false;

  protected loadExiftool(): Promise<ExiftoolModule | null> {
    if (!this.modPromise) {
      this.modPromise = import('exiftool-vendored').then(
        (m) => {
          this.loaded = true;
          return m as unknown as ExiftoolModule;
        },
        () => null,
      );
    }
    return this.modPromise;
  }

  /**
   * Build the ExifTool argument vector.
   *
   * ORDER IS LOAD-BEARING. ExifTool applies arguments left-to-right, and an
   * assignment placed AFTER a `-TagsFromFile` copy overrides the copied value.
   * All of it goes through `writeArgs` (with an empty `tags` object at the call
   * site) precisely because exiftool-vendored emits the `tags` object's
   * assignments BEFORE `writeArgs` — putting the overrides in `tags` would let
   * the bulk copy clobber them.
   */
  buildWriteArgs(originalPath: string, opts: ExifCarryoverOptions): string[] {
    const software = `MemoriaHub AI Enhance (${opts.model})`;
    const args: string[] = [
      // Do not leave a `<file>_original` backup next to the temp output.
      '-overwrite_original',
      // ---- copy from the original -------------------------------------
      '-TagsFromFile',
      originalPath,
      ...CARRIED_TAG_GROUPS,
      // ---- overrides (must come AFTER the copy to win) ----------------
      // The pipeline hands OpenAI an already-upright image, so the enhanced
      // pixels are upright too. Carrying the original's orientation flag would
      // make viewers rotate an already-rotated image.
      //
      // The `#` suffix is MANDATORY here, not stylistic: it disables ExifTool's
      // PrintConv so the raw value 1 is stored. Written as plain
      // `-EXIF:Orientation=1`, ExifTool matches "1" against the PrintConv
      // *labels* and lands on "Rotate 180" — silently stamping orientation 3 and
      // upside-downing every enhanced photo. (Verified against ExifTool 13.59.)
      '-EXIF:Orientation#=1',
    ];

    // EXIF:ExifImageWidth/Height ARE the ExifIFD PixelXDimension/PixelYDimension
    // tags (ExifTool exposes both the EXIF and XMP copies under the
    // ExifImageWidth/Height names). Both are stamped with the REAL output size
    // so the dimensions copied off the original don't lie about the new file.
    if (opts.width && opts.height) {
      args.push(
        `-EXIF:ExifImageWidth#=${opts.width}`,
        `-EXIF:ExifImageHeight#=${opts.height}`,
        `-XMP-exif:ExifImageWidth#=${opts.width}`,
        `-XMP-exif:ExifImageHeight#=${opts.height}`,
      );
    }

    args.push(
      // Embedded previews copied from the original would still show the
      // PRE-enhancement image in thumbnail-reading viewers. Drop them.
      '-ThumbnailImage=',
      '-PreviewImage=',
      // ---- AI marker ---------------------------------------------------
      `-EXIF:Software=${software}`,
      `-XMP-xmp:CreatorTool=${software}`,
      `-XMP-iptcExt:DigitalSourceType=${AI_DIGITAL_SOURCE_TYPE}`,
    );

    return args;
  }

  /**
   * Copy the original's metadata onto `enhancedBuffer` and stamp the AI marker.
   *
   * Returns the stamped bytes, or — on ANY failure (ExifTool unavailable, perl
   * missing, unwritable tmpdir, corrupt input) — `enhancedBuffer` unchanged.
   * Never throws.
   */
  async applyCarryover(
    originalBuffer: Buffer,
    enhancedBuffer: Buffer,
    opts: ExifCarryoverOptions,
  ): Promise<Buffer> {
    let mod: ExiftoolModule | null = null;
    try {
      mod = await this.loadExiftool();
    } catch {
      mod = null;
    }
    if (!mod) {
      this.logger.warn(
        'ExifTool is unavailable (package missing, or no `perl` on PATH); ' +
          'skipping EXIF carryover — the enhanced image keeps no original metadata',
      );
      return enhancedBuffer;
    }

    const id = randomUUID();
    const originalExt = normalizeExtension(opts.originalExtension);
    // `memoriaHub-` prefix is REQUIRED: TempFileJanitorTask sweeps orphans of
    // that shape out of os.tmpdir() when a job is SIGKILLed before cleanup.
    const originalPath = join(tmpdir(), `memoriaHub-enhance-src-${id}${originalExt}`);
    const enhancedPath = join(tmpdir(), `memoriaHub-enhance-out-${id}.jpg`);

    try {
      await writeFile(originalPath, originalBuffer);
      await writeFile(enhancedPath, enhancedBuffer);

      // Empty tag map + everything in writeArgs — see buildWriteArgs's note on
      // argument ordering.
      await mod.exiftool.write(enhancedPath, {}, {
        writeArgs: this.buildWriteArgs(originalPath, opts),
      });

      const stamped = await readFile(enhancedPath);
      if (stamped.length === 0) {
        this.logger.warn('EXIF carryover produced an empty file; keeping unstamped bytes');
        return enhancedBuffer;
      }
      return stamped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`EXIF carryover failed (keeping unstamped bytes): ${message}`);
      return enhancedBuffer;
    } finally {
      await Promise.all([safeUnlink(originalPath), safeUnlink(enhancedPath)]);
    }
  }

  /**
   * `exiftool-vendored` keeps ONE long-lived ExifTool child process alive across
   * calls; shut it down with the Nest lifecycle so the API exits cleanly.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.modPromise || !this.loaded) return;
    try {
      const mod = await this.modPromise;
      await mod?.exiftool.end();
    } catch {
      // Best-effort shutdown — never block application teardown.
    }
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Already gone, or never written — the janitor is the backstop.
  }
}

/** Normalize a mime-derived extension hint to a safe `.ext` (or ''). */
function normalizeExtension(ext?: string): string {
  if (!ext) return '';
  const trimmed = ext.startsWith('.') ? ext.slice(1) : ext;
  return /^[a-zA-Z0-9]{1,8}$/.test(trimmed) ? `.${trimmed.toLowerCase()}` : '';
}
