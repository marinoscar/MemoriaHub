import { Readable } from 'stream';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

/** Headroom factor applied on top of the object size for the disk-space guard. */
const DISK_GUARD_HEADROOM = 1.2;

/**
 * Consume a Readable stream and return its full contents as a Buffer.
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
 * Write a Readable stream to a file on disk with constant memory usage
 * (never buffers the full contents). Rejects on stream or write error.
 */
export async function streamToTempFile(stream: Readable, filePath: string): Promise<void> {
  await pipeline(stream, createWriteStream(filePath));
}

/**
 * Pre-flight disk-space guard for large (video) downloads: throws a clear
 * Error when the filesystem holding `dirPath` does not have `sizeBytes` plus
 * 20% headroom free. Callers route the error through the normal job retry
 * path, so a full disk fails fast and visibly instead of filling up with a
 * partial temp file.
 */
export async function assertDiskSpaceForDownload(
  sizeBytes: bigint | number,
  dirPath: string,
): Promise<void> {
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

/**
 * Download an object to a temp file, guarded by the disk-space pre-flight, and
 * return the path plus a cleanup function.
 *
 * Extracted (issue #456) from the byte-identical block that
 * `VideoFaceDetectionService`, `SocialMediaDetectionHandler` and
 * `VideoAutoTaggingService` each had inline. It is also the FALLBACK for the
 * streaming path, so the fallback has exactly one implementation rather than
 * three copies that could drift.
 *
 * The caller MUST call the returned `cleanup()` in a `finally` — a failed or
 * partial download still leaves a temp file, and it is the caller that knows
 * when the file stops being needed.
 */
export async function downloadToTempFile(opts: {
  /** Opens the source stream. Called INSIDE the guarded section. */
  getStream: () => Promise<Readable>;
  /** Object size in bytes, for the disk-space pre-flight. */
  sizeBytes: bigint | number;
  /** Temp filename prefix, e.g. 'memoriaHub-vtag-dl-'. */
  prefix: string;
  /** File extension including the dot, for ffmpeg container detection. */
  extension?: string;
  /** Directory for the temp file. Defaults to the OS temp dir. */
  dir?: string;
}): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = opts.dir ?? tmpdir();
  const filePath = join(dir, `${opts.prefix}${randomUUID()}${opts.extension ?? ''}`);
  const cleanup = async (): Promise<void> => {
    await fs.unlink(filePath).catch(() => {});
  };

  // Pre-flight BEFORE opening the stream: fail fast (through the caller's
  // normal retry/backoff path) when the filesystem cannot hold the download
  // plus headroom, rather than filling the disk with a partial file.
  await assertDiskSpaceForDownload(opts.sizeBytes, dir);

  try {
    const stream = await opts.getStream();
    await streamToTempFile(stream, filePath);
  } catch (err) {
    // A partial file from a failed streamToTempFile must not be left behind
    // for the caller to remember about.
    await cleanup();
    throw err;
  }

  return { path: filePath, cleanup };
}
