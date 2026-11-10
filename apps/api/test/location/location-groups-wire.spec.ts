/**
 * The cross-group member 409 of the location slice's `LocationGroupsService`, run through the REAL
 * app-wide `HttpExceptionFilter` (RETRO-J10, #624).
 *
 * The service lives in `@marinoscar/memoriahub-api/location`, which cannot import the platform; its own
 * spec mirrors the filter's allowlist. This spec is the proof against the real thing: the filter rebuilds
 * every body from a fixed key allowlist, so a top-level `groupId` would never reach the wire and the owner
 * must be nested under `details`.
 */
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '@marinoscar/platform-api/core';
import { LocationGroupsService } from '@marinoscar/memoriahub-api/location';

function sendThroughFilter(exception: unknown): any {
  const response = { code: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/api/location-groups', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return response.send.mock.calls[0][0];
}

describe('LocationGroupsService 409 on the wire', () => {
  it('reports the owning group at details.groupId / details.groupName', async () => {
    const prisma = {
      locationGroup: { findUnique: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
      locationGroupAlias: {
        findMany: jest.fn().mockResolvedValue([
          { normalizedValue: 'heredia province', groupId: 'owner-group', group: { canonicalName: 'Heredia' } },
        ]),
      },
      $transaction: jest.fn(),
    };
    const service = new LocationGroupsService(
      prisma as never,
      { readSystem: async () => ({ value: {}, version: 1 }) } as never,
      { invalidate: jest.fn() } as never,
      { enqueueRebuild: jest.fn() } as never,
      {} as never,
    );

    let thrown: unknown;
    try {
      await service.create(
        { level: 'region', canonicalName: 'Provincia de Heredia', countryCode: 'CR', memberValues: ['Heredia Province'], enabled: true } as never,
        'user-1',
      );
    } catch (err) {
      thrown = err;
    }

    expect(sendThroughFilter(thrown)).toMatchObject({ statusCode: 409, details: { groupId: 'owner-group', groupName: 'Heredia' } });
    expect(prisma.locationGroup.create).not.toHaveBeenCalled();
  });
});
