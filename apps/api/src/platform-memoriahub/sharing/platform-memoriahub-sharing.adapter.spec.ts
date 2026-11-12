import { PlatformMemoriahubSharingAdapter } from './platform-memoriahub-sharing.adapter';

describe('PlatformMemoriahubSharingAdapter (RETRO-J10, #624)', () => {
  it('lists the expiring link grants of the default organization as expiring links', async () => {
    const expiresAt = new Date('2026-08-08T12:00:00Z');
    const listExpiring = jest.fn(async () => ({
      items: [{ grantId: 'g1', orgId: 'org-1', resourceType: 'album', resourceId: 'a1', role: 'viewer', label: null, expiresAt, grantedById: 'u1', createdAt: new Date() }],
      nextCursor: 'g1',
    }));
    const adapter = new PlatformMemoriahubSharingAdapter({ listExpiring } as never, { get: async () => 'org-1' } as never);

    await expect(adapter.listExpiringLinks({ within: 1000, cursor: 'c0', limit: 5 })).resolves.toEqual({
      items: [{ id: 'g1', resourceType: 'album', resourceId: 'a1', grantedById: 'u1', expiresAt }],
      nextCursor: 'g1',
    });
    expect(listExpiring).toHaveBeenCalledWith({ orgId: 'org-1', within: 1000, cursor: 'c0', limit: 5 });
  });
});
