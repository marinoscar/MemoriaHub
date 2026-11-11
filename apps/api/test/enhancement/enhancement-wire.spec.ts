/**
 * The over-the-cap 400 of the enhancement slice's by-filter bulk enhance, run through the REAL app-wide
 * `HttpExceptionFilter` (RETRO-J10, #624).
 *
 * `MediaEnhancementService` lives in `@marinoscar/memoriahub-api/enhancement`, which cannot import the
 * platform; its own spec mirrors the filter's allowlist. This spec is the proof against the real thing: the
 * filter rebuilds every body from a fixed key allowlist, so a top-level `matchedCount` would never reach the
 * wire and both numbers must be nested under `details` (issue #424).
 */
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from '@marinoscar/platform-api/core';
import { MediaEnhancementService } from '@marinoscar/memoriahub-api/enhancement';

function sendThroughFilter(exception: unknown): any {
  const response = { code: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/api/media/bulk/enhance/by-filter', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return response.send.mock.calls[0][0];
}

describe('MediaEnhancementService.startBatchByFilter 400 on the wire', () => {
  it('carries matchedCount and maxBatchSize under `details`', async () => {
    const documents: Record<string, unknown> = {
      features: { pictureEnhancement: true },
      ai: { features: { enhance: { provider: 'openai', model: 'gpt-image-1' } } },
      pictureEnhancement: { maxBatchSize: 3 },
    };
    const prisma = {
      mediaItem: {
        count: jest.fn().mockResolvedValue(7),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new MediaEnhancementService(
      prisma as never,
      { requireOwnerRole: jest.fn().mockResolvedValue({ role: 'editor', isSuperAdmin: false }) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { enqueue: jest.fn() } as never,
      { readSystem: async (name: string) => ({ value: documents[name], version: 1 }) } as never,
      { get: jest.fn() } as never,
      {} as never,
    );

    let thrown: unknown;
    try {
      await service.startBatchByFilter(
        { circleId: '00000000-0000-4000-8000-0000000000c1', params: {}, peopleMatch: 'any' } as never,
        { id: 'user-1', roles: [], permissions: ['media:write'], activeOrgId: null },
      );
    } catch (err) {
      thrown = err;
    }

    expect(sendThroughFilter(thrown)).toMatchObject({
      statusCode: 400,
      message: '7 photos match this filter; the limit is 3 per batch.',
      details: { matchedCount: 7, maxBatchSize: 3 },
    });
  });
});
