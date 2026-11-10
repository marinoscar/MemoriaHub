import { randomUUID } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

// =============================================================================
// Stream helpers for slices that move media bytes (RETRO-J6, #615)
// =============================================================================
//
// `streamToBuffer` for a bounded image, `downloadToTempFile` for a video: a
// constant-memory download to a temp file behind a disk-space pre-flight. Moved
// here from the web app's media processing so a slice that downloads a video
// (face detection today; tagging and social-media detection next) shares one
// implementation instead of three copies that could drift.
// =============================================================================

/** Headroom factor applied on top of the object size for the disk-space guard. */
const DISK_GUARD_HEADROOM = 1.2;

/**
 * Consumes a stream and returns its full contents. Use only for a bounded object
 * (an image); a video goes through {@link downloadToTempFile}.
 *
 * @param stream - the source stream.
 * @returns every byte of the stream.
 * @stability experimental
 */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Writes a stream to a file with constant memory (never buffers the whole object).
 *
 * @param stream - the source stream.
 * @param filePath - the file to write.
 * @stability experimental
 */
export async function streamToTempFile(stream: Readable, filePath: string): Promise<void> {
  await pipeline(stream, createWriteStream(filePath));
}

/**
 * Pre-flight disk-space guard for a large download: throws a clear error when the
 * filesystem holding `dirPath` lacks `sizeBytes` plus 20% headroom, so a full disk
 * fails fast through the caller's normal retry path instead of filling up with a
 * partial temp file.
 *
 * @param sizeBytes - the object size.
 * @param dirPath - the directory the file will be written to.
 * @stability experimental
 */
export async function assertDiskSpaceForDownload(sizeBytes: bigint | number, dirPath: string): Promise<void> {
  const size = Number(sizeBytes);
  const stats = await fs.statfs(dirPath);
  const freeBytes = stats.bavail * stats.bsize;
  const neededBytes = Math.ceil(size * DISK_GUARD_HEADROOM);
  if (freeBytes < neededBytes) {
    const toMb = (b: number): number => Math.round(b / (1024 * 1024));
    throw new Error(
      `insufficient disk space for video download: need ${toMb(neededBytes)} MB, have ${toMb(freeBytes)} MB`,
    );
  }
}

/** Options of {@link downloadToTempFile}. @stability experimental */
export interface DownloadToTempFileOptions {
  /** Opens the source stream. Called INSIDE the guarded section. */
  getStream: () => Promise<Readable>;
  /** Object size in bytes, for the disk-space pre-flight. */
  sizeBytes: bigint | number;
  /** Temp filename prefix, e.g. `memoriahub-job-vtag-dl-`. */
  prefix: string;
  /** File extension including the dot, for ffmpeg container detection. */
  extension?: string;
  /** Directory for the temp file. Defaults to the OS temp dir. */
  dir?: string;
}

/**
 * Downloads an object to a temp file behind the disk-space pre-flight and returns
 * the path plus a cleanup function. The caller MUST call `cleanup()` in a `finally`.
 *
 * @param opts - the source, the size and the file name.
 * @returns the temp file path and its cleanup.
 * @stability experimental
 */
export async function downloadToTempFile(
  opts: DownloadToTempFileOptions,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = opts.dir ?? tmpdir();
  const filePath = join(dir, `${opts.prefix}${randomUUID()}${opts.extension ?? ''}`);
  const cleanup = async (): Promise<void> => {
    await fs.unlink(filePath).catch(() => {});
  };

  await assertDiskSpaceForDownload(opts.sizeBytes, dir);

  try {
    const stream = await opts.getStream();
    await streamToTempFile(stream, filePath);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { path: filePath, cleanup };
}
