/**
 * OwnerScopeSweepService (RETRO-N29, RETRO-K1): every owner scope for a sweep = every group the slice lists
 * under the registered reason, then every personal library from the store, each id once; members of a
 * scope come from the slice (a personal library's only member is its owner, as admin).
 */
import type { GroupMembershipService, GroupsService } from '@marinoscar/platform-api/sharing';

import { OwnerScopeSweepService } from './owner-scope-sweep.service';

function build(personalRows: Array<{ id: string; ownerId: string; ownerName: string | null; ownerEmail: string }> = []) {
  const groups = {
    listForSystem: jest
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 'g-1', name: 'Group A', createdById: 'u-1' },
          { id: 'g-2', name: 'Group B', createdById: null },
        ],
        nextCursor: 'g-2',
      })
      .mockResolvedValueOnce({ items: [{ id: 'g-3', name: 'Group C', createdById: 'u-2' }], nextCursor: null }),
    get: jest.fn(),
  };
  const membership = { membersForSystem: jest.fn() };
  const personal = {
    page: jest.fn().mockResolvedValue(personalRows),
    get: jest.fn(),
    ownerOf: jest.fn().mockResolvedValue(null),
  };
  const service = new OwnerScopeSweepService(
    groups as unknown as GroupsService,
    membership as unknown as GroupMembershipService,
    personal as never,
    {} as never,
    { get: jest.fn().mockResolvedValue('org-1') } as never,
  );
  return { service, groups, membership, personal };
}

describe('OwnerScopeSweepService', () => {
  it('pages the groups through listForSystem, then adds the personal libraries, without duplicates', async () => {
    const { service, groups, personal } = build([
      { id: 'p-1', ownerId: 'u-3', ownerName: 'Person A', ownerEmail: 'a@example.test' },
      { id: 'g-3', ownerId: 'u-4', ownerName: null, ownerEmail: 'b@example.test' },
    ]);

    const ids = await service.allScopeIds('owner-scope-sweep');

    expect(groups.listForSystem).toHaveBeenNthCalledWith(1, { reason: 'owner-scope-sweep', cursor: undefined, limit: 500 });
    expect(groups.listForSystem).toHaveBeenNthCalledWith(2, { reason: 'owner-scope-sweep', cursor: 'g-2', limit: 500 });
    expect(personal.page).toHaveBeenCalledWith(undefined, 500);
    expect(ids).toEqual(['g-1', 'g-2', 'g-3', 'p-1']);
  });

  it('names a personal library after its owner and keeps the group kind and creator', async () => {
    const { service } = build([{ id: 'p-1', ownerId: 'u-3', ownerName: 'Person A', ownerEmail: 'a@example.test' }]);
    const scopes = await service.allScopes();
    expect(scopes.find((s) => s.id === 'p-1')).toMatchObject({ kind: 'personal', ownerId: 'u-3', name: "Person A's Library" });
    expect(scopes.find((s) => s.id === 'g-1')).toMatchObject({ kind: 'group', createdById: 'u-1', name: 'Group A' });
  });

  it('reads group members through membersForSystem and a personal library as its owner (admin)', async () => {
    const { service, membership, personal } = build();
    personal.ownerOf.mockImplementation(async (id: string) => (id === 'p-1' ? 'u-3' : null));
    membership.membersForSystem.mockResolvedValue([{ userId: 'u-1', role: 'editor' }]);

    expect(await service.membersOf('g-1', ['editor'])).toEqual([{ userId: 'u-1', role: 'editor' }]);
    expect(membership.membersForSystem).toHaveBeenCalledWith('g-1', { reason: 'owner-scope-members', roles: ['editor'] });
    expect(await service.membersOf('p-1')).toEqual([{ userId: 'u-3', role: 'admin' }]);
    expect(await service.membersOf('p-1', ['editor'])).toEqual([]);
  });

  it('proves a group exists by its (always present) admin', async () => {
    const { service, membership } = build();
    membership.membersForSystem.mockResolvedValueOnce([{ userId: 'u-1', role: 'admin' }]).mockResolvedValueOnce([]);
    expect(await service.exists('g-1')).toBe(true);
    expect(await service.exists('missing')).toBe(false);
  });
});
