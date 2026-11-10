/**
 * AdminPublicLinksService: the admin page's rows come from the slice's organization-wide link
 * listing (`LinkGrantsService.listForOrg`, #1136); this service adds status, creator and preview.
 */
import type { Principal } from '@marinoscar/platform-api/core';
import type { LinkGrantsService } from '@marinoscar/platform-api/sharing';

import { createMockPrismaService } from '../../test/mocks/prisma.mock';
import type { MediaThumbnailService } from '@marinoscar/memoriahub-api/media';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminPublicLinksService, linkStatusOf } from './admin-public-links.service';

const NOW = new Date('2026-08-05T12:00:00Z');

function view(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    resourceType: 'media_item',
    resourceId: 'i-1',
    role: 'viewer',
    label: null,
    url: 'http://localhost:3535/s#lnk_abc',
    expiresAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
    grantedById: 'u-1',
    createdAt: '2025-12-01T00:00:00.000Z',
    ...over,
  };
}

describe('AdminPublicLinksService', () => {
  it('lists through listForOrg and derives status, creator and preview', async () => {
    const prisma = createMockPrismaService();
    (prisma.mediaItem.findMany as jest.Mock).mockResolvedValue([{ id: 'i-1', originalFilename: 'beach.jpg', metadata: null }]);
    (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: 'u-1', email: 'person.a@example.test', displayName: 'Person A' }]);
    const links = { listForOrg: jest.fn().mockResolvedValue({ items: [view()], total: 1, page: 2, pageSize: 10, totalPages: 1 }) };
    const thumbnails = { extractThumbKey: jest.fn().mockReturnValue(null), signThumbsBatched: jest.fn().mockResolvedValue(new Map()) };
    const service = new AdminPublicLinksService(
      links as unknown as LinkGrantsService,
      prisma as unknown as PrismaService,
      thumbnails as unknown as MediaThumbnailService,
    );
    const principal = { userId: 'u-admin' } as unknown as Principal;

    const page = await service.list(principal, { status: 'expired', resourceType: 'media_item', page: 2, pageSize: 10 }, NOW);

    expect(links.listForOrg).toHaveBeenCalledWith(principal, { page: 2, pageSize: 10, status: 'expired', resourceType: 'media_item' });
    expect(page.items[0]).toMatchObject({
      id: 'g-1',
      status: 'expired',
      url: 'http://localhost:3535/s#lnk_abc',
      grantedBy: { id: 'u-1', displayName: 'Person A' },
      preview: { type: 'media_item', title: 'beach.jpg' },
    });
    expect(page.meta).toEqual({ page: 2, pageSize: 10, totalItems: 1, totalPages: 1 });
  });

  it('derives the status of a link', () => {
    expect(linkStatusOf({ revokedAt: '2026-01-01T00:00:00Z', expiresAt: null }, NOW)).toBe('revoked');
    expect(linkStatusOf({ revokedAt: null, expiresAt: '2026-01-01T00:00:00Z' }, NOW)).toBe('expired');
    expect(linkStatusOf({ revokedAt: null, expiresAt: null }, NOW)).toBe('active');
  });
});
