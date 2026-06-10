/**
 * Media fixture helpers for processor unit tests.
 *
 * Strategy:
 *   - Real images are generated programmatically with `sharp` (small 4x4 JPEG).
 *     This gives valid binaries for dimension and hash tests without committing
 *     binary files to the repository.
 *   - EXIF tags are NOT written by these helpers; instead, `exifr.parse` is
 *     mocked in tests that need EXIF metadata.  Writing EXIF into a buffer at
 *     test time would require `piexifjs` which is not in the project's
 *     dependencies, and using a pre-committed binary fixture would couple tests
 *     to an opaque blob.  Mocking `exifr` is the deterministic, zero-dependency
 *     alternative recommended by the Phase 02 spec.
 */
import { Readable } from 'stream';

let _plainJpegBuffer: Buffer | null = null;

/**
 * Returns a minimal valid JPEG buffer (4x4 red pixels) generated with sharp.
 * Result is cached — the image is only created once per test run.
 */
export async function getPlainJpegBuffer(): Promise<Buffer> {
  if (_plainJpegBuffer) return _plainJpegBuffer;

  const sharp = (await import('sharp')).default;
  _plainJpegBuffer = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg({ quality: 60 })
    .toBuffer();

  return _plainJpegBuffer;
}

/** Wraps a Buffer in a Node.js Readable stream. */
export function bufferToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

/** Returns a getStream callback that yields the supplied buffer. */
export function makeGetStream(buf: Buffer): () => Promise<Readable> {
  return () => Promise.resolve(bufferToStream(buf));
}
