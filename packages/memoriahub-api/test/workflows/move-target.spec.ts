import { BadRequestException, NotFoundException } from '@nestjs/common';

import { isMoveAction, moveTargetRefOf, resolveMoveTargetScope } from '../../src/workflows/actions/move-target.js';
import { moveToCircleParamsSchema, moveToOwnerParamsSchema } from '../../src/workflows/actions/action-params.schema.js';

const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const PERSONAL_ID = '44444444-4444-4444-8444-444444444444';

describe('move actions (RETRO-I6 #588)', () => {
  it('recognises both the new name and the deprecated alias', () => {
    expect(isMoveAction('move_to_owner')).toBe(true);
    expect(isMoveAction('move_to_circle')).toBe(true);
    expect(isMoveAction('archive')).toBe(false);
  });

  it('reads the new target forms and the legacy targetCircleId', () => {
    expect(moveTargetRefOf({ target: { kind: 'me' } })).toEqual({ kind: 'me' });
    expect(moveTargetRefOf({ target: { kind: 'group', groupId: GROUP_ID } })).toEqual({ kind: 'scope', scopeId: GROUP_ID });
    expect(moveTargetRefOf({ targetCircleId: GROUP_ID })).toEqual({ kind: 'scope', scopeId: GROUP_ID });
    expect(() => moveTargetRefOf({})).toThrow(BadRequestException);
  });

  it('resolves me to the actor personal library, and 404s without one', async () => {
    const access = { personalLibraryOf: jest.fn().mockResolvedValue(PERSONAL_ID) };
    await expect(resolveMoveTargetScope({ target: { kind: 'me' } }, 'user-a', access)).resolves.toBe(PERSONAL_ID);
    expect(access.personalLibraryOf).toHaveBeenCalledWith('user-a');
    access.personalLibraryOf.mockResolvedValue(null);
    await expect(resolveMoveTargetScope({ target: { kind: 'me' } }, 'user-a', access)).rejects.toThrow(NotFoundException);
    await expect(resolveMoveTargetScope({ targetCircleId: GROUP_ID }, 'user-a', access)).resolves.toBe(GROUP_ID);
  });

  it('keeps the legacy params schema valid and validates the new one strictly', () => {
    expect(moveToCircleParamsSchema.safeParse({ targetCircleId: GROUP_ID }).success).toBe(true);
    expect(moveToOwnerParamsSchema.safeParse({ target: { kind: 'me' } }).success).toBe(true);
    expect(moveToOwnerParamsSchema.safeParse({ target: { kind: 'group', groupId: GROUP_ID } }).success).toBe(true);
    expect(moveToOwnerParamsSchema.safeParse({ target: { kind: 'group' } }).success).toBe(false);
    expect(moveToOwnerParamsSchema.safeParse({ targetCircleId: GROUP_ID }).success).toBe(false);
  });
});
