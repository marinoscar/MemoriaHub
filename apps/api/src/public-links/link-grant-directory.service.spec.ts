/**
 * LinkGrantDirectory (RETRO-I4, #578): the read-only, link-only, org-scoped listing of link
 * grants the `share_expiring` sweep and the admin page use.
 */
import { createMockPrismaService } from '../../test/mocks/prisma.mock';
import type { DefaultOrgId } from '../common/tenancy/default-org-id';
import type { PrismaService } from '../prisma/prisma.service';
import { LinkGrantDirectory, linkStatusOf, linkStatusWhere } from './link-grant-directory.service';

const NOW = new Date('2026-08-05T12:00:00Z');
const ORG = 'org-default';

describe('LinkGrantDirectory', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let directory: LinkGrantDirectory;

  beforeEach(() => {
    prisma = createMockPrismaService();
    prisma.runInOrg = jest.fn();
    (prisma.runInOrg as jest.Mock).mockImplementation((_org: string, fn: (tx: unknown) => unknown) => fn(prisma));
    directory = new LinkGrantDirectory(prisma as unknown as PrismaService, { get: async () => ORG } as unknown as DefaultOrgId);
  });

  it('pages active media and album links expiring in (now, horizon] in the default organization', async () => {
    const horizon = new Date(NOW.getTime() + 7 * 86_400_000);
    (prisma.grant.findMany as jest.Mock).mockResolvedValue([
      { id: 'g-1', resourceType: 'album', resourceId: 'a-1', grantedById: 'u-1', expiresAt: horizon },
    ]);

    const page = await directory.expiringPage(NOW, horizon, 200, 'g-0');

    expect(prisma.runInOrg).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect((prisma.grant.findMany as jest.Mock).mock.calls[0][0]).toEqual({
      where: {
        granteeKind: 'link',
        resourceType: { in: ['media_item', 'album'] },
        revokedAt: null,
        expiresAt: { gt: NOW, lte: horizon },
        id: { gt: 'g-0' },
      },
      orderBy: { id: 'asc' },
      take: 200,
      select: { id: true, resourceType: true, resourceId: true, grantedById: true, expiresAt: true },
    });
    expect(page).toEqual([{ id: 'g-1', resourceType: 'album', resourceId: 'a-1', grantedById: 'u-1', expiresAt: horizon }]);
  });

  it('lists links for the admin page with status, a re-derived URL and no token material', async () => {
    (prisma.grant.count as jest.Mock).mockResolvedValue(1);
    (prisma.grant.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'g-1',
        orgId: ORG,
        resourceType: 'media_item',
        resourceId: 'i-1',
        granteeKind: 'link',
        granteeUserId: null,
        granteeGroupId: null,
        granteeRef: null,
        role: 'viewer',
        linkTokenHash: 'h'.repeat(64),
        linkTokenCiphertext: 'not-decryptable',
        linkLabel: null,
        expiresAt: new Date('2026-01-01T00:00:00Z'),
        revokedAt: null,
        revokedById: null,
        grantedById: 'u-1',
        metadata: null,
        createdAt: new Date('2025-12-01T00:00:00Z'),
        updatedAt: new Date('2025-12-01T00:00:00Z'),
      },
    ]);

    const { items, total } = await directory.adminPage({ status: 'expired', resourceType: 'media_item', page: 2, pageSize: 10 }, NOW);

    const call = (prisma.grant.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ granteeKind: 'link', resourceType: 'media_item', revokedAt: null, expiresAt: { lte: NOW } });
    expect(call.skip).toBe(10);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ id: 'g-1', status: 'expired', role: 'viewer', grantedById: 'u-1' });
    expect(JSON.stringify(items)).not.toMatch(/hhhh|not-decryptable/);
  });

  it('derives a status and its filter consistently', () => {
    expect(linkStatusOf({ revokedAt: NOW, expiresAt: null }, NOW)).toBe('revoked');
    expect(linkStatusOf({ revokedAt: null, expiresAt: NOW }, NOW)).toBe('expired');
    expect(linkStatusOf({ revokedAt: null, expiresAt: null }, NOW)).toBe('active');
    expect(linkStatusWhere('active', NOW)).toEqual({ revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] });
    expect(linkStatusWhere(undefined, NOW)).toEqual({});
  });
});
