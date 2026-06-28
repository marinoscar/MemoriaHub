import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { IncomingMessage } from 'http';

import { Public } from '../auth/decorators/public.decorator';
import { ShareService } from './share.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { Readable } from 'stream';

@ApiTags('Public Sharing')
@Controller('public/shares')
export class PublicShareController {
  private readonly logger = new Logger(PublicShareController.name);

  constructor(
    private readonly shareService: ShareService,
    private readonly storageResolver: StorageProviderResolver,
  ) {}

  /**
   * GET /api/public/shares/:token
   *
   * Returns minimal, metadata-stripped info about a shared item or album.
   * No filenames, descriptions, tags, dates, geo, camera info, or internal IDs
   * are exposed — only the data needed for rendering.
   */
  @Get(':token')
  @Public()
  @ApiOperation({ summary: 'Get public share info (no auth required)' })
  @ApiParam({ name: 'token', description: 'Share token' })
  @ApiResponse({
    status: 200,
    description: 'Share info (media dimensions / album item list only)',
  })
  @ApiResponse({ status: 404, description: 'Share not found or expired' })
  async getPublicShare(@Param('token') token: string) {
    const resolved = await this.shareService.resolvePublicShare(token);

    if (resolved.mediaItem) {
      return {
        data: {
          type: 'media_item',
          media: {
            mediaType: resolved.mediaItem.type === 'photo' ? 'photo' : 'video',
            width: resolved.mediaItem.width,
            height: resolved.mediaItem.height,
          },
        },
      };
    }

    // Album
    const items = (resolved.albumItems ?? []).map((item) => ({
      mediaType: item.type === 'photo' ? 'photo' : 'video',
      width: item.width,
      height: item.height,
    }));

    return {
      data: {
        type: 'album',
        itemCount: items.length,
        items,
      },
    };
  }

  /**
   * GET /api/public/shares/:token/media/:idx
   *
   * Byte-proxy: streams the raw bytes of the item at zero-based index `idx`.
   * For media_item shares, idx must be 0.
   * For album shares, idx is the position in the non-deleted, ordered item list.
   *
   * Optional ?variant=thumb streams the thumbnail instead of the original
   * when the item has a thumbnailStorageKey (album shares only; silently falls
   * back to original if thumbnail key is absent).
   *
   * Supports HTTP Range header for video seeking (206 Partial Content).
   * If the storage provider does not expose a size/range API, falls back to
   * full-file streaming without Range support.
   */
  @Get(':token/media/:idx')
  @Public()
  @ApiOperation({ summary: 'Proxy media bytes (no auth required)' })
  @ApiParam({ name: 'token', description: 'Share token' })
  @ApiParam({ name: 'idx', description: 'Zero-based item index', type: Number })
  @ApiQuery({ name: 'variant', required: false, enum: ['original', 'thumb'] })
  @ApiResponse({ status: 200, description: 'Raw media bytes' })
  @ApiResponse({ status: 206, description: 'Partial media bytes (Range request)' })
  @ApiResponse({ status: 404, description: 'Share or item not found' })
  async proxyMedia(
    @Param('token') token: string,
    @Param('idx') idxStr: string,
    @Query('variant') variant: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    const idx = parseInt(idxStr, 10);
    if (isNaN(idx) || idx < 0) {
      throw new NotFoundException('Invalid media index');
    }

    const resolved = await this.shareService.resolvePublicShare(token);

    // Resolve the storage object for the requested index
    let storageKey: string;
    let storageProvider: string;
    let bucket: string | null;
    let mimeType: string;
    let thumbnailStorageKey: string | null = null;

    if (resolved.mediaItem) {
      // media_item share: only index 0 is valid
      if (idx !== 0) throw new NotFoundException('Item index out of range');
      storageKey = resolved.mediaItem.storageObject.storageKey;
      storageProvider = resolved.mediaItem.storageObject.storageProvider;
      bucket = resolved.mediaItem.storageObject.bucket;
      mimeType = resolved.mediaItem.storageObject.mimeType;
    } else {
      // album share
      const items = resolved.albumItems ?? [];
      if (idx >= items.length) throw new NotFoundException('Item index out of range');
      const item = items[idx];
      storageKey = item.storageObject.storageKey;
      storageProvider = item.storageObject.storageProvider;
      bucket = item.storageObject.bucket;
      mimeType = item.storageObject.mimeType;
      thumbnailStorageKey = item.thumbnailStorageKey;
    }

    // Variant: serve thumbnail if requested and available
    if (variant === 'thumb' && thumbnailStorageKey) {
      storageKey = thumbnailStorageKey;
      mimeType = 'image/jpeg'; // thumbnails are always JPEG
    }

    // Resolve the storage provider
    const provider = await this.storageResolver.getProviderFor(
      storageProvider,
      bucket ?? undefined,
    );

    // Set security / caching headers
    void res.header('Content-Type', mimeType);
    void res.header('Content-Disposition', 'inline');
    void res.header('X-Content-Type-Options', 'nosniff');
    void res.header('Referrer-Policy', 'no-referrer');
    void res.header('Cache-Control', 'private, max-age=300');

    // Attempt to honor Range header for video seeking
    const rawRequest = res.request as unknown as IncomingMessage & { headers: Record<string, string | undefined> };
    const rangeHeader = rawRequest?.headers?.range;

    if (rangeHeader && mimeType.startsWith('video/')) {
      try {
        await this.serveRange(provider, storageKey, mimeType, rangeHeader, res);
        return;
      } catch (err) {
        // If ranged serving fails, fall through to full-file streaming
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Range request failed for key=${storageKey}: ${msg} — falling back to full-file`);
      }
    }

    // Full-file streaming
    void res.header('Accept-Ranges', 'bytes');
    const stream: Readable = await provider.download(storageKey);
    res.send(stream);
  }

  /**
   * Attempt to serve a Range request using the provider's download method.
   *
   * The StorageProvider interface only exposes `download(key)` (full stream).
   * For Range support we need the object size; we attempt to obtain it via
   * `getMetadata` and then parse the Range header to set Content-Range.
   * We then stream the full file but pipe only the requested bytes.
   *
   * TODO: ranged video requests — when providers expose a native range
   * download method (e.g. S3 GetObject with ByteRange), use that to avoid
   * buffering the whole file for large byte ranges.
   */
  private async serveRange(
    provider: { download: (key: string) => Promise<Readable>; getMetadata: (key: string) => Promise<Record<string, string> | null> },
    storageKey: string,
    mimeType: string,
    rangeHeader: string,
    res: FastifyReply,
  ): Promise<void> {
    // Try to get object size from metadata
    const meta = await provider.getMetadata(storageKey);
    const contentLength = meta ? parseInt(meta['content-length'] || meta['Content-Length'] || '0', 10) : 0;

    if (!contentLength || isNaN(contentLength)) {
      // Can't determine size — fall back to full-file streaming
      throw new Error('Object size unknown; cannot serve Range');
    }

    // Parse the Range header — only handle the common "bytes=start-end" form
    const rangeMatch = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!rangeMatch) {
      throw new Error('Unsupported Range format');
    }

    const startStr = rangeMatch[1];
    const endStr = rangeMatch[2];

    const start = startStr ? parseInt(startStr, 10) : contentLength - parseInt(endStr || '0', 10);
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

    // TODO: ranged video requests — use provider-native byte range download here
    // (e.g. S3 GetObject with Range header) to avoid streaming the full object.
    // Current implementation downloads the full object and skips/trims bytes in-stream.
    const fullStream: Readable = await provider.download(storageKey);

    let bytesSkipped = 0;
    let bytesWritten = 0;
    let finished = false;

    fullStream.on('data', (chunk: Buffer) => {
      if (finished) return;

      const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

      // Skip bytes before `start`
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
}
