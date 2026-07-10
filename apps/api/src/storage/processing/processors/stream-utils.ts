import { Readable } from 'stream';
import { createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';

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
