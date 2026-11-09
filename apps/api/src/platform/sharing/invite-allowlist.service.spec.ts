import { InviteAllowlistService } from './invite-allowlist.service';

// RETRO-I5 (#583): an invitation to a group allowlists the invitee, idempotently, never throwing.

describe('InviteAllowlistService', () => {
  const build = () => {
    const prisma = { allowedEmail: { upsert: jest.fn().mockResolvedValue({}) } };
    return { service: new InviteAllowlistService(prisma as never), prisma };
  };

  it('upserts the lower-cased address and leaves an existing entry untouched', async () => {
    const { service, prisma } = build();

    await service.ensureAllowed('  Person-B@Example.TEST ', 'admin-1');

    expect(prisma.allowedEmail.upsert).toHaveBeenCalledWith({
      where: { email: 'person-b@example.test' },
      update: {},
      create: { email: 'person-b@example.test', notes: 'Invited to a group', addedById: 'admin-1' },
    });
  });

  it('records no adder when the invite has no actor', async () => {
    const { service, prisma } = build();

    await service.ensureAllowed('person-b@example.test');

    expect(prisma.allowedEmail.upsert.mock.calls[0][0].create).toEqual({
      email: 'person-b@example.test',
      notes: 'Invited to a group',
    });
  });

  it('never throws: a failed write is logged', async () => {
    const { service, prisma } = build();
    prisma.allowedEmail.upsert.mockRejectedValue(new Error('db down'));

    await expect(service.ensureAllowed('person-b@example.test')).resolves.toBeUndefined();
  });

  it('ignores a blank address', async () => {
    const { service, prisma } = build();
    await service.ensureAllowed('   ');
    expect(prisma.allowedEmail.upsert).not.toHaveBeenCalled();
  });
});
