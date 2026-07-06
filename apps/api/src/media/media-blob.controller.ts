import {
  Controller,
  Get,
  Query,
  Res,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiExcludeEndpoint,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { StorageProviderResolver } from '../storage/providers/storage-provider.resolver';
import { StorageProvider } from '../storage/providers/storage-provider.interface';
import { MediaUrlSigningService } from './signing/media-url-signing.service';
import { streamStorageObject } from '../storage/streaming/media-stream.util';

/**
 * MediaBlobController
 *
 * Same-origin, HMAC-authenticated byte-proxy for BROWSER-FACING media
 * (thumbnails + full-res originals). Introduced so that browsers behind a
 * Zscaler-style corporate proxy — which injects query params (e.g. `_sm_nck`)
 * that break AWS SigV4 R2 presigned URLs — only ever talk to our own domain.
 *
 * The endpoint is @Public() (no JWT guard) because `<img>` / `<video>` tags
 * cannot send an Authorization header and the app's access token lives in
 * memory (not a cookie). Authorization is instead enforced by the HMAC token
 * embedded in the URL (see MediaUrlSigningService), which binds to the exact
 * storage key and carries a short expiry.
 *
 * Declared on the static path `media/blob`; Fastify's router (find-my-way)
 * always prefers static routes over the parametric `media/:id` in
 * MediaController, so it is never shadowed.
 */
@ApiTags('Media')
@Controller('media')
export class MediaBlobController {
  private readonly logger = new Logger(MediaBlobController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: StorageProviderResolver,
    private readonly config: ConfigService,
    private readonly signer: MediaUrlSigningService,
  ) {}

  /**
   * GET /api/media/blob?k=<storageKey>&exp=<unix>&sig=<hex>
   *
   * Streams the bytes of the object identified by the signed storage key.
   * Reads ONLY the three named params — any extra injected param is ignored.
   */
  @Get('blob')
  @Public()
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Same-origin HMAC-signed media byte-proxy (no JWT required)',
  })
  @ApiQuery({ name: 'k', required: true, type: String, description: 'Storage key' })
  @ApiQuery({ name: 'exp', required: true, type: Number, description: 'Unix expiry (seconds)' })
  @ApiQuery({ name: 'sig', required: true, type: String, description: 'HMAC-SHA256 signature (hex)' })
  @ApiResponse({ status: 200, description: 'Raw media bytes' })
  @ApiResponse({ status: 206, description: 'Partial media bytes (Range request)' })
  @ApiResponse({ status: 403, description: 'Invalid or expired signature' })
  @ApiResponse({ status: 404, description: 'Storage object not found' })
  async serveBlob(
    @Query('k') storageKey: string | undefined,
    @Query('exp') expStr: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: FastifyReply,
  ): Promise<void> {
    if (!storageKey || !expStr || !sig) {
      throw new ForbiddenException('Missing signature parameters');
    }

    const exp = parseInt(expStr, 10);
    if (!this.signer.verify(storageKey, exp, sig)) {
      throw new ForbiddenException('Invalid or expired media signature');
    }

    // Resolve the StorageObject row to find provider + bucket + mime type.
    const obj = await this.prisma.storageObject.findUnique({
      where: { storageKey },
      select: { storageProvider: true, bucket: true, mimeType: true },
    });

    let storageProvider: string;
    let bucket: string | null;
    let mimeType: string;

    if (obj) {
      storageProvider = obj.storageProvider;
      bucket = obj.bucket;
      mimeType = obj.mimeType;
    } else {
      // No row (thumbnail still in-flight / legacy key). Fall back to the
      // static provider token and infer mime from the key extension.
      storageProvider = this.config.get<string>('storage.provider', 's3');
      bucket = null;
      mimeType = inferMimeFromKey(storageKey);
    }

    let provider: StorageProvider;
    try {
      provider = await this.resolver.getProviderFor(
        storageProvider,
        bucket ?? undefined,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to resolve provider for key=${storageKey}: ${msg}`);
      throw new NotFoundException('Media not found');
    }

    await streamStorageObject({
      provider,
      storageKey,
      mimeType,
      res,
      cacheControl: `private, max-age=${this.signer.ttlSeconds}`,
      logger: this.logger,
    });
  }
}

/**
 * Best-effort MIME inference for keys with no StorageObject row.
 */
function inferMimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}
