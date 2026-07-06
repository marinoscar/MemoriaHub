import { IncomingMessage } from 'http';
import { Readable } from 'stream';
import { Logger } from '@nestjs/common';
import { FastifyReply } from 'fastify';

/**
 * Minimal provider surface needed for streaming. Both S3StorageProvider and
 * LocalDiskStorageProvider satisfy this.
 */
export interface StreamableProvider {
  download(key: string): Promise<Readable>;
  getMetadata(key: string): Promise<Record<string, string> | null>;
}

export interface StreamStorageObjectOptions {
  provider: StreamableProvider;
  storageKey: string;
  mimeType: string;
  res: FastifyReply;
  /** Value for the Cache-Control response header. */
  cacheControl: string;
  logger?: Logger;
}

/**
 * Stream a storage object to a Fastify reply, honoring HTTP Range requests for
 * video seeking (206 Partial Content) and falling back to full-file streaming
 * otherwise.
 *
 * This logic is mirrored from PublicShareController.proxyMedia / serveRange so
 * that the authenticated same-origin media byte-proxy shares identical Range
 * behaviour without altering the public-share controller.
 */
export async function streamStorageObject(
  opts: StreamStorageObjectOptions,
): Promise<void> {
  const { provider, storageKey, mimeType, res, cacheControl, logger } = opts;

  // Security / caching headers
  void res.header('Content-Type', mimeType);
  void res.header('Content-Disposition', 'inline');
  void res.header('X-Content-Type-Options', 'nosniff');
  void res.header('Referrer-Policy', 'no-referrer');
  void res.header('Cache-Control', cacheControl);

  // Attempt to honor Range header for video seeking
  const rawRequest = res.request as unknown as IncomingMessage & {
    headers: Record<string, string | undefined>;
  };
  const rangeHeader = rawRequest?.headers?.range;

  if (rangeHeader && mimeType.startsWith('video/')) {
    try {
      await serveRange(provider, storageKey, mimeType, rangeHeader, res);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger?.warn(
        `Range request failed for key=${storageKey}: ${msg} — falling back to full-file`,
      );
    }
  }

  // Full-file streaming
  void res.header('Accept-Ranges', 'bytes');
  const stream: Readable = await provider.download(storageKey);
  res.send(stream);
}

/**
 * Serve a Range request using the provider's download + getMetadata methods.
 * The StorageProvider interface only exposes a full `download(key)` stream, so
 * we obtain the object size via getMetadata and trim bytes in-stream.
 */
async function serveRange(
  provider: StreamableProvider,
  storageKey: string,
  mimeType: string,
  rangeHeader: string,
  res: FastifyReply,
): Promise<void> {
  const meta = await provider.getMetadata(storageKey);
  const contentLength = meta
    ? parseInt(meta['content-length'] || meta['Content-Length'] || '0', 10)
    : 0;

  if (!contentLength || isNaN(contentLength)) {
    throw new Error('Object size unknown; cannot serve Range');
  }

  const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!rangeMatch) {
    throw new Error('Unsupported Range format');
  }

  const startStr = rangeMatch[1];
  const endStr = rangeMatch[2];

  const start = startStr
    ? parseInt(startStr, 10)
    : contentLength - parseInt(endStr || '0', 10);
  const end = endStr ? parseInt(endStr, 10) : contentLength - 1;

  if (start > end || end >= contentLength) {
    throw new Error('Range not satisfiable');
  }

  const chunkSize = end - start + 1;

  void res.header('Content-Range', `bytes ${start}-${end}/${contentLength}`);
  void res.header('Accept-Ranges', 'bytes');
  void res.header('Content-Length', String(chunkSize));
  void res.header('Content-Type', mimeType);
  res.statusCode = 206;

  const fullStream: Readable = await provider.download(storageKey);

  let bytesSkipped = 0;
  let bytesWritten = 0;
  let finished = false;

  fullStream.on('data', (chunk: Buffer) => {
    if (finished) return;

    const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    if (bytesSkipped < start) {
      const toSkip = Math.min(start - bytesSkipped, chunkBuf.length);
      bytesSkipped += toSkip;
      if (toSkip >= chunkBuf.length) return;

      const sliced = chunkBuf.slice(toSkip);
      const toWrite = Math.min(sliced.length, chunkSize - bytesWritten);
      if (toWrite > 0) {
        res.raw.write(sliced.slice(0, toWrite));
        bytesWritten += toWrite;
      }
    } else {
      const toWrite = Math.min(chunkBuf.length, chunkSize - bytesWritten);
      if (toWrite > 0) {
        res.raw.write(chunkBuf.slice(0, toWrite));
        bytesWritten += toWrite;
      }
    }

    if (bytesWritten >= chunkSize) {
      finished = true;
      fullStream.destroy();
      res.raw.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    fullStream.on('end', () => {
      if (!finished) res.raw.end();
      resolve();
    });
    fullStream.on('error', reject);
    fullStream.on('close', resolve);
  });
}
