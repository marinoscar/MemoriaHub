import { Injectable } from '@nestjs/common';
import type { MemoriesAlbumsPort } from '@marinoscar/memoriahub-api/memories';

import { MediaService } from '../../media/media.service';

// =============================================================================
// MemoriesAlbumsAdapter: save-as-album over the web app's album code (RETRO-J8, #619)
// =============================================================================
//
// Every mutation goes through the EXISTING album service path (`MediaService.createAlbum` /
// `addAlbumItems` / `updateAlbum`) rather than writing album rows directly, so the memories slice
// inherits their owner checks, their `MediaTouchService` backup-feed bookkeeping and their cover
// validation, and cannot drift from them.
// =============================================================================

@Injectable()
export class MemoriesAlbumsAdapter implements MemoriesAlbumsPort {
  constructor(private readonly media: MediaService) {}

  async createAlbum(
    input: { circleId: string; name: string },
    userId: string,
    permissions: string[],
  ): Promise<{ id: string }> {
    const album = await this.media.createAlbum(input, userId, permissions);
    return { id: album.id };
  }

  async addAlbumItems(albumId: string, mediaItemIds: string[], userId: string, permissions: string[]): Promise<void> {
    await this.media.addAlbumItems(albumId, { mediaItemIds }, userId, permissions);
  }

  async setAlbumCover(
    albumId: string,
    coverMediaItemId: string,
    userId: string,
    permissions: string[],
  ): Promise<void> {
    await this.media.updateAlbum(albumId, { coverMediaItemId }, userId, permissions);
  }
}
