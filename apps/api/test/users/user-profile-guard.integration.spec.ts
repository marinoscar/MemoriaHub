/**
 * Regression coverage for issue #406 (the actual root cause).
 *
 * PATCH /api/users/me/profile carries a bare `@Auth()` (authenticate-only, no
 * roles/permissions — see the doc comment at the top of
 * `user-profile.controller.ts`). Before the fix, `RolesGuard`/`PermissionsGuard`
 * only computed and attached `request.requestUser` when a role/permission check
 * actually ran; on a route requiring neither, `@CurrentUser()` fell back to the
 * RAW `AuthenticatedUser` (no `.permissions` field at all). That raw object,
 * mistyped as `RequestUser`, flowed into
 * `UserAvatarService.updateProfile` -> `assertPersonLinkable` ->
 * `CircleMembershipService.assertCircleAccess(..., user.permissions, ...)`,
 * where `permissions.includes(...)` threw `TypeError: Cannot read properties
 * of undefined (reading 'includes')`. `assertPersonLinkable`'s own try/catch
 * (there to collapse a genuine ForbiddenException into an enumeration-resistant
 * 404) swallowed that TypeError too, so linking ANY person for ANY user on
 * this route always 404'd.
 *
 * This spec exercises the REAL guard chain (JwtAuthGuard -> RolesGuard ->
 * PermissionsGuard), unlike `user-avatar.service.spec.ts`'s unit tests, which
 * construct their `RequestUser` fixture directly and so never touch the guard
 * layer where this bug actually lived.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockViewerUser, authHeader } from '../helpers/auth-mock.helper';

describe('PATCH /api/users/me/profile — bare @Auth() guard regression (issue #406)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  it('links a person in a circle the caller actually belongs to, without the TypeError-as-404 regression', async () => {
    const user = await createMockViewerUser(context);
    const circleId = randomUUID();
    const personId = randomUUID();

    // Real circle membership at (at least) viewer rank — this is the path
    // that used to blow up on `permissions.includes(...)`.
    context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
    context.prismaMock.circleMember.findUnique.mockResolvedValue({
      circleId,
      userId: user.id,
      role: 'viewer',
      joinedAt: new Date(),
    });
    context.prismaMock.person.findUnique.mockResolvedValue({
      id: personId,
      name: 'Jane Doe',
      circleId,
      deletedAt: null,
      circle: { name: 'Family' },
    });

    const response = await request(context.app.getHttpServer())
      .patch('/api/users/me/profile')
      .set(authHeader(user.accessToken))
      // avatarSource is set explicitly so the request takes the
      // assertPersonLinkable -> writeAvatarState -> applyAvatarSource('oauth')
      // path without also exercising the person-rendering pipeline, which is
      // unrelated to this guard-layer bug.
      .send({ linkedPersonId: personId, avatarSource: 'oauth' })
      .expect(200);

    expect(response.body.data.id).toBe(user.id);

    // Proves the request actually reached the real circle-access check
    // (and therefore real `user.permissions`, not undefined) rather than
    // short-circuiting into the old TypeError-swallowed-as-404 path.
    expect(context.prismaMock.person.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: personId } }),
    );
    expect(context.prismaMock.circleMember.findUnique).toHaveBeenCalled();
  });

  it('still 404s for a person in a circle the caller is NOT a member of (genuine denial, not masked by the guard fix)', async () => {
    const user = await createMockViewerUser(context);
    const circleId = randomUUID();
    const personId = randomUUID();

    context.prismaMock.circle.findUnique.mockResolvedValue({ id: circleId });
    // Caller has no CircleMember row for this circle.
    context.prismaMock.circleMember.findUnique.mockResolvedValue(null);
    context.prismaMock.person.findUnique.mockResolvedValue({
      id: personId,
      name: 'Jane Doe',
      circleId,
      deletedAt: null,
      circle: { name: 'Someone Else’s Family' },
    });

    const response = await request(context.app.getHttpServer())
      .patch('/api/users/me/profile')
      .set(authHeader(user.accessToken))
      .send({ linkedPersonId: personId, avatarSource: 'oauth' })
      .expect(404);

    // Enumeration-resistant: the same generic message regardless of why
    // linking failed (issue #406's earlier, already-merged hardening fix).
    expect(response.body.message).toContain('no longer available to link');
  });
});
