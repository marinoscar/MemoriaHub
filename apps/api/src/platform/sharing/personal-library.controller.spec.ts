import { PERSONAL_LIBRARY_NAME, PersonalLibraryService } from './personal-library.controller';
import { ACTIVE_OWNER_SCOPE_USER_SETTINGS, activeOwnerScopeSchema } from '../../settings/registry/namespaces/user/active-owner-scope';

describe('PersonalLibraryService (RETRO-I6, #588)', () => {
  it("returns the caller's personal library id", async () => {
    const idOf = jest.fn().mockResolvedValue('lib-1');
    const service = new PersonalLibraryService({ idOf } as never);
    await expect(service.forUser('user-1')).resolves.toEqual({ id: 'lib-1', name: PERSONAL_LIBRARY_NAME });
    expect(idOf).toHaveBeenCalledWith('user-1');
  });

  it('returns a null id when the account has no personal library', async () => {
    const service = new PersonalLibraryService({ idOf: jest.fn().mockResolvedValue(null) } as never);
    await expect(service.forUser('user-1')).resolves.toEqual({ id: null, name: PERSONAL_LIBRARY_NAME });
  });
});

describe('activeOwnerScope user setting (RETRO-I6, #588)', () => {
  const groupId = '22222222-2222-4222-8222-222222222222';

  it('accepts me and a group, and refuses anything else', () => {
    expect(activeOwnerScopeSchema.safeParse({ kind: 'me' }).success).toBe(true);
    expect(activeOwnerScopeSchema.safeParse({ kind: 'group', groupId }).success).toBe(true);
    expect(activeOwnerScopeSchema.safeParse({ kind: 'group', groupId: 'not-a-uuid' }).success).toBe(false);
    expect(activeOwnerScopeSchema.safeParse({ kind: 'circle', id: groupId }).success).toBe(false);
    expect(activeOwnerScopeSchema.safeParse({ kind: 'me', groupId }).success).toBe(false);
  });

  it('merges as a scalar: absent keeps, a value replaces, null clears', () => {
    const merge = ACTIVE_OWNER_SCOPE_USER_SETTINGS.merge;
    expect(merge({ kind: 'me' }, undefined)).toEqual({ kind: 'me' });
    expect(merge({ kind: 'me' }, { kind: 'group', groupId })).toEqual({ kind: 'group', groupId });
    expect(merge({ kind: 'group', groupId }, null)).toBeUndefined();
  });
});
