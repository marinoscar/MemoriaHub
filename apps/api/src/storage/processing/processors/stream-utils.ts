import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

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
