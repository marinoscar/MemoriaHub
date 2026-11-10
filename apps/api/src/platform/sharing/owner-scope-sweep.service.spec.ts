/**
 * OwnerScopeSweepService (RETRO-N29): every owner scope for an admin sweep = every group the slice lists
 * under the registered reason, then every personal library from `circles`, each id once.
 */
import type { GroupsService } from '@marinoscar/platform-api/sharing';

import { OwnerScopeSweepService } from './owner-scope-sweep.service';

describe('OwnerScopeSweepService', () => {
  it('pages the groups through listForSystem, then adds the personal libraries, without duplicates', async () => {
    const groups = {
      listForSystem: jest
        .fn()
        .mockResolvedValueOnce({ items: [{ id: 'g-1' }, { id: 'g-2' }], nextCursor: 'g-2' })
        .mockResolvedValueOnce({ items: [{ id: 'g-3' }], nextCursor: null }),
    };
    const prisma = { circle: { findMany: jest.fn().mockResolvedValue([{ id: 'p-1' }, { id: 'g-3' }]) } };
    const service = new OwnerScopeSweepService(groups as unknown as GroupsService, prisma as never);

    const ids = await service.allScopeIds('owner-scope-sweep');

    expect(groups.listForSystem).toHaveBeenNthCalledWith(1, { reason: 'owner-scope-sweep', cursor: undefined, limit: 500 });
    expect(groups.listForSystem).toHaveBeenNthCalledWith(2, { reason: 'owner-scope-sweep', cursor: 'g-2', limit: 500 });
    expect(prisma.circle.findMany.mock.calls[0][0].where).toEqual({ isPersonal: true });
    expect(ids).toEqual(['g-1', 'g-2', 'g-3', 'p-1']);
  });
});
