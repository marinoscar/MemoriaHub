/**
 * PublicLinkViewService (RETRO-I4, #578): the metadata-stripping contract of a public link,
 * unchanged from `media_shares`, now with presigned URLs instead of a byte proxy.
 */
import { NotFoundException } from '@nestjs/common';
import type { LinkGrantsService, ResolvedLinkGrant } from '@marinoscar/platform-api/sharing';

import type { StorageProviderResolver } from '../platform/storage/storage-provider.resolver';
import { PUBLIC_LINK_URL_TTL_SECONDS, PublicLinkViewService, thumbnailKeyOf } from './public-link-view.service';

const MEDIA_LINK: ResolvedLinkGrant = { grantId: 'g-1', orgId: 'org-1', resourceType: 'media_item', resourceId: 'item-1', role: 'viewer', expiresAt: null };
const ALBUM_LINK: ResolvedLinkGrant = {
  grantId: 'g-2',
  orgId: 'org-1',
  resourceType: 'album',
  resourceId: 'album-1',
  role: 'viewer',
  expiresAt: new Date('2026-12-01T00:00:00Z'),
};

/** A media row as the select returns it, plus fields the select must never surface. */
function row(over: Record<string, unknown> = {}) {
  return {
    type: 'photo',
    width: 4000,
    height: 3000,
    metadata: { thumbnailStorageKey: 'thumbnails/obj-1-abc.jpg', exif: { GPSLatitude: 9.9 } },
    storageObject: { storageKey: 'originals/obj-1.jpg', storageProvider: 's3', bucket: 'bucket-a' },
    ...over,
  };
}

describe('PublicLinkViewService', () => {
  let tx: {
    mediaItem: { findFirst: jest.Mock };
    albumItem: { findMany: jest.Mock };
    storageObject: { findMany: jest.Mock };
  };
  let driver: { getSignedDownloadUrl: jest.Mock };
  let storage: { getProviderFor: jest.Mock };
  let service: PublicLinkViewService;

  beforeEach(() => {
    tx = {
      mediaItem: { findFirst: jest.fn().mockResolvedValue(row()) },
      albumItem: { findMany: jest.fn().mockResolvedValue([]) },
      storageObject: { findMany: jest.fn().mockResolvedValue([{ storageKey: 'thumbnails/obj-1-abc.jpg', storageProvider: 'r2', bucket: 'thumbs' }]) },
    };
    const links = { withLinkScope: jest.fn((_link: ResolvedLinkGrant, fn: (t: unknown) => unknown) => fn(tx)) };
    driver = { getSignedDownloadUrl: jest.fn(async (key: string) => `https://storage.example.test/${key}?sig=x`) };
    storage = { getProviderFor: jest.fn().mockResolvedValue(driver) };
    service = new PublicLinkViewService(links as unknown as LinkGrantsService, storage as unknown as StorageProviderResolver);
  });

  it('returns a metadata-stripped media view with presigned, inline, short-lived URLs', async () => {
    const view = await service.mediaView(MEDIA_LINK);

    expect(view).toEqual({
      type: 'media_item',
      expiresAt: null,
      media: {
        mediaType: 'photo',
        width: 4000,
        height: 3000,
        url: 'https://storage.example.test/originals/obj-1.jpg?sig=x',
        thumbnailUrl: 'https://storage.example.test/thumbnails/obj-1-abc.jpg?sig=x',
      },
    });
    expect(JSON.stringify(view)).not.toMatch(/GPS|exif|bucket|storageKey|originals\/obj-1\.jpg"/);
    expect(driver.getSignedDownloadUrl).toHaveBeenCalledWith('originals/obj-1.jpg', {
      expiresIn: PUBLIC_LINK_URL_TTL_SECONDS,
      responseContentDisposition: 'inline',
    });
    // The original through its recorded driver, the thumbnail through ITS row's driver.
    expect(storage.getProviderFor).toHaveBeenCalledWith('s3', 'bucket-a');
    expect(storage.getProviderFor).toHaveBeenCalledWith('r2', 'thumbs');
    expect(tx.mediaItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item-1', deletedAt: null } }));
  });

  it('reports a video as a video and leaves thumbnailUrl null without a thumbnail', async () => {
    tx.mediaItem.findFirst.mockResolvedValue(row({ type: 'video', metadata: null }));

    const view = await service.mediaView(MEDIA_LINK);

    expect(view.media).toMatchObject({ mediaType: 'video', thumbnailUrl: null });
  });

  it('a thumbnail with no row of its own is signed beside its original', async () => {
    tx.storageObject.findMany.mockResolvedValue([]);

    await service.mediaView(MEDIA_LINK);

    expect(storage.getProviderFor).toHaveBeenCalledTimes(2);
    expect(storage.getProviderFor).toHaveBeenNthCalledWith(2, 's3', 'bucket-a');
  });

  it('a media item trashed after the guard ran is the same 404', async () => {
    tx.mediaItem.findFirst.mockResolvedValue(null);

    await expect(service.mediaView(MEDIA_LINK)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a driver that cannot sign leaves that URL null instead of failing the view', async () => {
    driver.getSignedDownloadUrl.mockRejectedValue(new Error('driver gone'));

    const view = await service.mediaView(MEDIA_LINK);

    expect(view.media).toMatchObject({ url: null, thumbnailUrl: null });
  });

  it('lists only non-trashed album members, in album order, stripped', async () => {
    tx.albumItem.findMany.mockResolvedValue([{ mediaItem: row() }, { mediaItem: row({ type: 'video', width: 1920, height: 1080, metadata: {} }) }]);

    const view = await service.albumView(ALBUM_LINK);

    expect(tx.albumItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { albumId: 'album-1', mediaItem: { deletedAt: null } },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(view.type).toBe('album');
    expect(view.expiresAt).toBe('2026-12-01T00:00:00.000Z');
    expect(view.itemCount).toBe(2);
    expect(view.items.map((i) => Object.keys(i).sort())).toEqual([
      ['height', 'mediaType', 'thumbnailUrl', 'url', 'width'],
      ['height', 'mediaType', 'thumbnailUrl', 'url', 'width'],
    ]);
    expect(view.items[1]).toMatchObject({ mediaType: 'video', thumbnailUrl: null });
    // Archived members are NOT filtered (archive is not a privacy control).
    expect(JSON.stringify(tx.albumItem.findMany.mock.calls[0][0].where)).not.toContain('archivedAt');
  });

  it('reads the thumbnail key only from a string in the metadata', () => {
    expect(thumbnailKeyOf({ thumbnailStorageKey: 'k' })).toBe('k');
    expect(thumbnailKeyOf({ thumbnailStorageKey: 3 })).toBeNull();
    expect(thumbnailKeyOf(null)).toBeNull();
    expect(thumbnailKeyOf(['k'])).toBeNull();
  });
});
