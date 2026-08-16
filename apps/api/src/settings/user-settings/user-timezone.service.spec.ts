import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../../test/mocks/prisma.mock';
import {
  DEFAULT_USER_TIME_ZONE,
  USER_TIMEZONE_CACHE_TTL_MS,
  UserTimeZoneService,
} from './user-timezone.service';

const USER = 'user-1';
const OTHER = 'user-2';

/** A stored `user_settings.value` blob carrying (or omitting) a zone. */
function blob(timezone?: unknown): any {
  const value: Record<string, unknown> = {
    theme: 'system',
    profile: { useProviderImage: true },
  };
  if (timezone !== undefined) value['timezone'] = timezone;
  return { userId: USER, value };
}

describe('UserTimeZoneService', () => {
  let service: UserTimeZoneService;
  let prisma: MockPrismaService;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserTimeZoneService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(UserTimeZoneService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // resolveUserTimeZone
  // ---------------------------------------------------------------------------

  describe('resolveUserTimeZone', () => {
    it('returns the stored zone when one is set', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(
        blob('America/Costa_Rica'),
      );

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'America/Costa_Rica',
      );
    });

    it('falls back to UTC when the key is absent', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(blob());

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        DEFAULT_USER_TIME_ZONE,
      );
    });

    it('falls back to UTC when the user has no settings row at all', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(null);

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
    });

    it('returns an explicit stored UTC — resolution never writes a row', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(blob('UTC'));

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
      // The read must stay a read: getSettings() would CREATE a default row,
      // which is exactly why this service goes to Prisma directly.
      expect(prisma.userSettings.create).not.toHaveBeenCalled();
      expect(prisma.userSettings.upsert).not.toHaveBeenCalled();
    });

    it('FAILS OPEN to UTC when the lookup throws', async () => {
      prisma.userSettings.findUnique.mockRejectedValue(new Error('db down'));

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
    });

    it('does not cache a failed lookup — the next call retries', async () => {
      prisma.userSettings.findUnique.mockRejectedValueOnce(new Error('db down'));
      prisma.userSettings.findUnique.mockResolvedValueOnce(blob('Europe/Paris'));

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'Europe/Paris',
      );
    });

    it('falls back to UTC for a stored zone this runtime does not know', async () => {
      // A zone written under one ICU build can be unknown to another; handing
      // it to Intl would throw at the formatter rather than here.
      prisma.userSettings.findUnique.mockResolvedValue(blob('Mars/Olympus'));

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
    });

    it('falls back to UTC for a malformed stored value', async () => {
      for (const bad of ['', 3600, null, {}, []]) {
        prisma.userSettings.findUnique.mockResolvedValue(blob(bad));
        service.invalidate(USER);
        await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
      }
    });

    it('falls back to UTC when the whole settings blob is not an object', async () => {
      prisma.userSettings.findUnique.mockResolvedValue({
        userId: USER,
        value: 'not-json-object',
      } as any);

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
    });
  });

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  describe('caching', () => {
    it('serves a second call from cache without re-reading', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(blob('Europe/Madrid'));

      await service.resolveUserTimeZone(USER);
      await service.resolveUserTimeZone(USER);

      expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
    });

    it('keys the cache per user — one user never serves another', async () => {
      prisma.userSettings.findUnique.mockImplementation((({ where }: any) =>
        Promise.resolve(
          where.userId === USER
            ? { userId: USER, value: { timezone: 'Europe/Madrid' } }
            : { userId: OTHER, value: { timezone: 'Pacific/Apia' } },
        )) as any,
      );

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'Europe/Madrid',
      );
      await expect(service.resolveUserTimeZone(OTHER)).resolves.toBe(
        'Pacific/Apia',
      );
    });

    it('re-reads once the TTL has elapsed', async () => {
      jest.useFakeTimers();
      prisma.userSettings.findUnique.mockResolvedValue(blob('Europe/Madrid'));

      await service.resolveUserTimeZone(USER);
      jest.advanceTimersByTime(USER_TIMEZONE_CACHE_TTL_MS + 1);
      await service.resolveUserTimeZone(USER);

      expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('invalidate() makes a change visible on the very next read, not one TTL later', async () => {
      prisma.userSettings.findUnique.mockResolvedValueOnce(blob('UTC'));
      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');

      prisma.userSettings.findUnique.mockResolvedValueOnce(
        blob('America/Costa_Rica'),
      );
      service.invalidate(USER);

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'America/Costa_Rica',
      );
    });

    it('invalidate() drops only the named user', async () => {
      prisma.userSettings.findUnique.mockImplementation((({ where }: any) =>
        Promise.resolve({ userId: where.userId, value: { timezone: 'UTC' } })) as any,
      );

      await service.resolveUserTimeZone(USER);
      await service.resolveUserTimeZone(OTHER);
      expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(2);

      service.invalidate(USER);
      await service.resolveUserTimeZone(USER);
      await service.resolveUserTimeZone(OTHER);

      expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(3);
    });
  });

  // ---------------------------------------------------------------------------
  // prime
  // ---------------------------------------------------------------------------

  describe('prime', () => {
    it('warms many users in ONE query and serves them all from cache', async () => {
      prisma.userSettings.findMany.mockResolvedValue([
        { userId: USER, value: { timezone: 'Europe/Madrid' } },
        { userId: OTHER, value: { timezone: 'Pacific/Apia' } },
      ] as any);

      await service.prime([USER, OTHER]);

      expect(prisma.userSettings.findMany).toHaveBeenCalledTimes(1);
      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'Europe/Madrid',
      );
      await expect(service.resolveUserTimeZone(OTHER)).resolves.toBe(
        'Pacific/Apia',
      );
      expect(prisma.userSettings.findUnique).not.toHaveBeenCalled();
    });

    it('caches a user with NO row as UTC — that is an answer, not a miss', async () => {
      prisma.userSettings.findMany.mockResolvedValue([] as any);

      await service.prime([USER]);

      await expect(service.resolveUserTimeZone(USER)).resolves.toBe('UTC');
      expect(prisma.userSettings.findUnique).not.toHaveBeenCalled();
    });

    it('deduplicates ids and skips already-cached users', async () => {
      prisma.userSettings.findUnique.mockResolvedValue(blob('Europe/Madrid'));
      await service.resolveUserTimeZone(USER);

      prisma.userSettings.findMany.mockResolvedValue([] as any);
      await service.prime([USER, USER]);

      expect(prisma.userSettings.findMany).not.toHaveBeenCalled();
    });

    it('is a no-op for an empty list', async () => {
      await service.prime([]);

      expect(prisma.userSettings.findMany).not.toHaveBeenCalled();
    });

    it('is best-effort — a failure leaves the cache cold rather than throwing', async () => {
      prisma.userSettings.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.prime([USER])).resolves.toBeUndefined();

      prisma.userSettings.findUnique.mockResolvedValue(blob('Europe/Madrid'));
      await expect(service.resolveUserTimeZone(USER)).resolves.toBe(
        'Europe/Madrid',
      );
    });
  });
});
