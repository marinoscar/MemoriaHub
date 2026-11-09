import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { Controller, Get, GoneException, Headers, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '@marinoscar/platform-api/identity';

import {
  LocalDiskStorageProvider,
  resolveLocalObjectPath,
  verifyLocalDownloadToken,
} from './local-disk.driver';

// =============================================================================
// `GET /api/storage/local/objects/:token` — the `local` driver's signed downloads (RETRO-D1, #563)
// =============================================================================
//
// The other half of `LocalDiskStorageProvider.getSignedDownloadUrl`. The token is
// the credential (HMAC under a sub-key of `SECRETS_ENCRYPTION_KEY`, minutes-long
// expiry), so the route is public, like an S3 presigned GET: a browser `<img>`,
// a video element, the CLI and the Android app follow it without a bearer.
//
//   * The token names the ROOT and the KEY it was signed for; the key is resolved
//     under that root and refused if it would escape it. Only this deployment can
//     sign, so only roots this deployment wrote to are ever read.
//   * 404 for a bad signature or a missing file, 410 for an expired link: the
//     same split as the Android download link.
//   * `Range: bytes=a-b` is honoured (206), so a video can seek.
// =============================================================================

@ApiTags('Storage')
@Controller('storage/local/objects')
export class LocalStorageDownloadController {
  @Get(':token')
  @Public()
  @ApiOperation({
    summary: 'Download an object stored by the local storage driver',
    description:
      'Serves the bytes behind a signed link the `local` storage driver issued (the token is the credential). ' +
      'Honours a single `Range: bytes=start-end` (206). 404 for an invalid link or a missing object, 410 once it expired.',
  })
  @ApiParam({ name: 'token', description: 'The signed token from the download URL' })
  @ApiResponse({ status: 200, description: 'The object bytes' })
  @ApiResponse({ status: 206, description: 'Partial bytes (Range request)' })
  @ApiResponse({ status: 404, description: 'Invalid link or missing object' })
  @ApiResponse({ status: 410, description: 'The link expired' })
  async download(
    @Param('token') token: string,
    @Headers('range') range: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const verdict = verifyLocalDownloadToken(token);
    if (!verdict.ok) {
      if (verdict.reason === 'expired') throw new GoneException('This download link has expired');
      throw new NotFoundException('Object not found');
    }

    let fullPath: string;
    try {
      fullPath = resolveLocalObjectPath(verdict.root, verdict.key);
    } catch {
      throw new NotFoundException('Object not found');
    }
    const info = await stat(fullPath).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException('Object not found');

    const contentType = await new LocalDiskStorageProvider(verdict.root).contentTypeOf(verdict.key);
    const size = info.size;
    void reply.header('Content-Type', contentType);
    void reply.header('Accept-Ranges', 'bytes');
    void reply.header('X-Content-Type-Options', 'nosniff');
    void reply.header('Cache-Control', 'private, max-age=300');
    if (verdict.disposition) void reply.header('Content-Disposition', verdict.disposition);

    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (match && (match[1] !== '' || match[2] !== '') && size > 0) {
      let start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
      let end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2]);
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end) {
        void reply.header('Content-Range', `bytes */${size}`);
        await reply.status(416).send();
        return;
      }
      void reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
      void reply.header('Content-Length', String(end - start + 1));
      await reply.status(206).send(createReadStream(fullPath, { start, end }));
      return;
    }

    void reply.header('Content-Length', String(size));
    await reply.status(200).send(createReadStream(fullPath));
  }
}
