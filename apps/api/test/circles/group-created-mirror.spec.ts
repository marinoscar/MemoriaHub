/**
 * RETRO-I6 (#684): a group created through `/api/groups` is mirrored into `circles`
 * (same id, creator as `circle_admin`), idempotently, so media can be stored in it.
 */
import { GroupMemberMirrorListener } from '../../src/circles/group-member-mirror.listener';

const ORG = '00000000-0000-4000-8000-0000000000d0';
const GROUP = '6f3a8a2e-1111-4a6b-9c1d-0000000000a1';
const CREATOR = '6f3a8a2e-2222-4a6b-9c1d-0000000000a2';
const ACTOR = '6f3a8a2e-3333-4a6b-9c1d-0000000000a3';

function build(group: { name: string; description: string | null; createdById: string | null } | null) {
  const groups = { get: jest.fn(async () => (group ? group : Promise.reject(new Error('404')))) };
  const prisma = {
    circle: { upsert: jest.fn().mockResolvedValue({}) },
    circleMember: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const listener = new GroupMemberMirrorListener(prisma as never, { notifyAddress: jest.fn() } as never, groups as never);
  return { prisma, groups, listener };
}

describe('GroupMemberMirrorListener.onGroupCreated (#684)', () => {
  it('creates the circle with the group id and the creator as circle_admin', async () => {
    const { prisma, groups, listener } = build({ name: 'Group Alpha', description: 'Shared', createdById: CREATOR });
    await listener.onGroupCreated({ orgId: ORG, groupId: GROUP, actorUserId: ACTOR });

    expect(groups.get).toHaveBeenCalledWith(expect.objectContaining({ userId: ACTOR, activeOrgId: ORG }), GROUP);
    expect(prisma.circle.upsert).toHaveBeenCalledWith({
      where: { id: GROUP },
      update: {},
      create: { id: GROUP, name: 'Group Alpha', description: 'Shared', ownerId: CREATOR, isPersonal: false },
    });
    expect(prisma.circleMember.upsert).toHaveBeenCalledWith({
      where: { circleId_userId: { circleId: GROUP, userId: CREATOR } },
      update: { role: 'circle_admin' },
      create: { circleId: GROUP, userId: CREATOR, role: 'circle_admin' },
    });
  });

  it('falls back to the acting user when the group has no creator', async () => {
    const { prisma, listener } = build({ name: 'Group Beta', description: null, createdById: null });
    await listener.onGroupCreated({ orgId: ORG, groupId: GROUP, actorUserId: ACTOR });
    expect(prisma.circle.upsert.mock.calls[0][0].create.ownerId).toBe(ACTOR);
  });

  it('does nothing when the group is gone, and never throws on a write failure', async () => {
    const gone = build(null);
    await gone.listener.onGroupCreated({ orgId: ORG, groupId: GROUP, actorUserId: ACTOR });
    expect(gone.prisma.circle.upsert).not.toHaveBeenCalled();

    const failing = build({ name: 'Group Alpha', description: null, createdById: CREATOR });
    failing.prisma.circle.upsert.mockRejectedValue(new Error('boom'));
    await expect(failing.listener.onGroupCreated({ orgId: ORG, groupId: GROUP, actorUserId: ACTOR })).resolves.toBeUndefined();
  });
});
