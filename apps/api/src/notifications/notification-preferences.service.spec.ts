/**
 * Unit tests for NotificationPreferencesService and its pure resolution
 * helpers (epic #240, issue #251).
 *
 * Covers:
 *  - resolveNotificationPreferences(): the load-bearing "absence means
 *    enabled" rule — absent namespace, empty namespace, partial `types` map,
 *    and malformed stored values all resolve to enabled; `workflowMicroRuns`
 *    is the one inverted default (absent === false).
 *  - defaultNotificationPreferences() / disabledNotificationTypes(): the two
 *    other pure exports the settings write path depends on.
 *  - NotificationPreferencesService.resolve()/isEnabled()/
 *    allowsWorkflowMicroRuns(): per-user TTL cache, cross-user isolation,
 *    fail-open on a DB read failure.
 *  - prime(): batched warm-up (one findMany for N users), cache-freshness
 *    dedup, absent-row-is-a-real-answer semantics, best-effort failure.
 *  - invalidate(): drops exactly one user's cached entry.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import {
  NOTIFICATION_PREFERENCES_CACHE_TTL_MS,
  NotificationPreferencesService,
  defaultNotificationPreferences,
  disabledNotificationTypes,
  resolveNotificationPreferences,
} from './notification-preferences.service';

const ALL_TYPES = Object.values(NotificationType) as NotificationType[];

const USER_A = 'user-aaa';
const USER_B = 'user-bbb';

// =============================================================================
// resolveNotificationPreferences() — pure function, the absence-means-enabled
// rule itself
// =============================================================================

describe('resolveNotificationPreferences()', () => {
  it('an absent namespace (undefined) resolves EVERY type to enabled', () => {
    const resolved = resolveNotificationPreferences(undefined);

    expect(resolved.enabled).toBe(true);
    for (const type of ALL_TYPES) {
      expect(resolved.types[type]).toBe(true);
    }
  });

  it('a null namespace resolves the same as absent', () => {
    const resolved = resolveNotificationPreferences(null);

    expect(resolved.enabled).toBe(true);
    for (const type of ALL_TYPES) {
      expect(resolved.types[type]).toBe(true);
    }
  });

  it('an empty namespace ({}) — present but with nothing set — still resolves every type to enabled', () => {
    const resolved = resolveNotificationPreferences({});

    expect(resolved.enabled).toBe(true);
    for (const type of ALL_TYPES) {
      expect(resolved.types[type]).toBe(true);
    }
    expect(resolved.workflowMicroRuns).toBe(false);
  });

  it('a partially-populated types map disables only the listed type — the other seven stay enabled', () => {
    const resolved = resolveNotificationPreferences({
      types: { upload_completed: false },
    });

    expect(resolved.types.upload_completed).toBe(false);
    const others = ALL_TYPES.filter((t) => t !== 'upload_completed');
    expect(others.length).toBe(7);
    for (const type of others) {
      expect(resolved.types[type]).toBe(true);
    }
  });

  it('an explicit types[type] = true is enabled (the non-default explicit case)', () => {
    const resolved = resolveNotificationPreferences({
      types: { upload_completed: true },
    });

    expect(resolved.types.upload_completed).toBe(true);
  });

  describe('malformed/unexpected stored values resolve to enabled (the `!== false` rule)', () => {
    it('a per-type value that is not literally `false` (e.g. a string) resolves to enabled', () => {
      const resolved = resolveNotificationPreferences({
        types: { upload_completed: 'false' as unknown as boolean },
      });

      expect(resolved.types.upload_completed).toBe(true);
    });

    it('a per-type value of 0 (falsy but not `false`) resolves to enabled', () => {
      const resolved = resolveNotificationPreferences({
        types: { upload_completed: 0 as unknown as boolean },
      });

      expect(resolved.types.upload_completed).toBe(true);
    });

    it('a per-type value of null resolves to enabled', () => {
      const resolved = resolveNotificationPreferences({
        types: { upload_completed: null as unknown as boolean },
      });

      expect(resolved.types.upload_completed).toBe(true);
    });

    it('a malformed `enabled` (e.g. a string "false") resolves the master switch to enabled', () => {
      const resolved = resolveNotificationPreferences({
        enabled: 'false' as unknown as boolean,
      });

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) {
        expect(resolved.types[type]).toBe(true);
      }
    });

    it('literal boolean `false` for `enabled` — and ONLY that — disables the master switch', () => {
      const resolved = resolveNotificationPreferences({ enabled: false });

      expect(resolved.enabled).toBe(false);
      for (const type of ALL_TYPES) {
        expect(resolved.types[type]).toBe(false);
      }
    });
  });

  describe('workflowMicroRuns — the one inverted default', () => {
    it('is FALSE when absent (opposite of every other field)', () => {
      const resolved = resolveNotificationPreferences(undefined);
      expect(resolved.workflowMicroRuns).toBe(false);
    });

    it('is TRUE only when explicitly stored as literal boolean true', () => {
      const resolved = resolveNotificationPreferences({ workflowMicroRuns: true });
      expect(resolved.workflowMicroRuns).toBe(true);
    });

    it('a malformed value (e.g. string "true") does NOT enable it — `=== true` is strict', () => {
      const resolved = resolveNotificationPreferences({
        workflowMicroRuns: 'true' as unknown as boolean,
      });
      expect(resolved.workflowMicroRuns).toBe(false);
    });

    it('explicit `workflowMicroRuns: false` resolves to false (same as absent)', () => {
      const resolved = resolveNotificationPreferences({ workflowMicroRuns: false });
      expect(resolved.workflowMicroRuns).toBe(false);
    });
  });

  it('the master switch being off does not, by itself, flip the resolved workflowMicroRuns field — that AND is allowsWorkflowMicroRuns()’s job, not resolve()’s', () => {
    const resolved = resolveNotificationPreferences({
      enabled: false,
      workflowMicroRuns: true,
    });

    // types are all suppressed by the master switch...
    for (const type of ALL_TYPES) {
      expect(resolved.types[type]).toBe(false);
    }
    // ...but the raw workflowMicroRuns field still reflects what was stored.
    expect(resolved.workflowMicroRuns).toBe(true);
  });
});

// =============================================================================
// defaultNotificationPreferences()
// =============================================================================

describe('defaultNotificationPreferences()', () => {
  it('is identical to resolveNotificationPreferences(undefined) — the fail-open value', () => {
    expect(defaultNotificationPreferences()).toEqual(
      resolveNotificationPreferences(undefined),
    );
  });

  it('every type is enabled and workflowMicroRuns is off', () => {
    const defaults = defaultNotificationPreferences();

    expect(defaults.enabled).toBe(true);
    expect(defaults.workflowMicroRuns).toBe(false);
    for (const type of ALL_TYPES) {
      expect(defaults.types[type]).toBe(true);
    }
  });
});

// =============================================================================
// disabledNotificationTypes()
// =============================================================================

describe('disabledNotificationTypes()', () => {
  it('returns an empty array for an absent namespace (nothing to dismiss)', () => {
    expect(disabledNotificationTypes(undefined)).toEqual([]);
  });

  it('returns an empty array for an empty namespace', () => {
    expect(disabledNotificationTypes({})).toEqual([]);
  });

  it('returns exactly the one disabled type when only that type is turned off', () => {
    const disabled = disabledNotificationTypes({
      types: { upload_completed: false },
    });

    expect(disabled).toEqual(['upload_completed']);
  });

  it('returns EVERY type when the master switch is off', () => {
    const disabled = disabledNotificationTypes({ enabled: false });

    expect(new Set(disabled)).toEqual(new Set(ALL_TYPES));
    expect(disabled).toHaveLength(ALL_TYPES.length);
  });

  it('returns every type disabled by the master switch PLUS none extra when a type is also explicitly true (still off overall)', () => {
    const disabled = disabledNotificationTypes({
      enabled: false,
      types: { upload_completed: true },
    });

    // enabled=false suppresses everything regardless of a per-type override —
    // resolve() ANDs `enabled && stored[type] !== false`.
    expect(new Set(disabled)).toEqual(new Set(ALL_TYPES));
  });
});

// =============================================================================
// NotificationPreferencesService — cache, fail-open, batching
// =============================================================================

describe('NotificationPreferencesService', () => {
  let service: NotificationPreferencesService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationPreferencesService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<NotificationPreferencesService>(NotificationPreferencesService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // resolve() — the read path
  // ---------------------------------------------------------------------------

  describe('resolve()', () => {
    it('a user with no user_settings row at all resolves to all-enabled', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) expect(resolved.types[type]).toBe(true);
    });

    it('a user_settings row with no `notifications` key resolves to all-enabled', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { theme: 'dark', profile: { useProviderImage: true } },
      });

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) expect(resolved.types[type]).toBe(true);
    });

    it('a user_settings row with `notifications: {}` still resolves to all-enabled', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { theme: 'dark', profile: {}, notifications: {} },
      });

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) expect(resolved.types[type]).toBe(true);
    });

    it('parses a real stored namespace correctly', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: {
          notifications: { types: { review_queue_bursts: false } },
        },
      });

      const resolved = await service.resolve(USER_A);

      expect(resolved.types.review_queue_bursts).toBe(false);
      expect(resolved.types.upload_completed).toBe(true);
    });

    it('a value that is not a plain object (e.g. an array) reads as absent', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: [1, 2, 3],
      });

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) expect(resolved.types[type]).toBe(true);
    });

    it('a `notifications` key that is itself an array reads as absent', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: ['not', 'an', 'object'] },
      });

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
    });

    it('calls findUnique scoped to the user and selecting only `value`', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await service.resolve(USER_A);

      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_A },
        select: { value: true },
      });
    });

    // --- caching -------------------------------------------------------------

    it('a second resolve() call for the same user within the TTL does NOT re-query Prisma', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await service.resolve(USER_A);
      await service.resolve(USER_A);

      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
    });

    it('re-queries once the TTL has elapsed', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      (mockPrisma.userSettings.findUnique as jest.Mock)
        .mockResolvedValueOnce({ value: {} })
        .mockResolvedValueOnce({ value: { notifications: { enabled: false } } });

      nowSpy.mockReturnValue(1_000_000);
      const first = await service.resolve(USER_A);
      expect(first.enabled).toBe(true);

      nowSpy.mockReturnValue(1_000_000 + NOTIFICATION_PREFERENCES_CACHE_TTL_MS + 1);
      const second = await service.resolve(USER_A);

      expect(second.enabled).toBe(false);
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('CACHE ISOLATION: a cached value resolved for user A is never returned for user B', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock)
        .mockResolvedValueOnce({ value: { notifications: { enabled: false } } }) // user A: disabled
        .mockResolvedValueOnce({ value: {} }); // user B: enabled

      const a = await service.resolve(USER_A);
      const b = await service.resolve(USER_B);

      expect(a.enabled).toBe(false);
      expect(b.enabled).toBe(true);
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);

      // Re-fetch A within the TTL — must still see A's own cached (disabled)
      // value, never B's, and must not issue a third query.
      const aAgain = await service.resolve(USER_A);
      expect(aAgain.enabled).toBe(false);
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    // --- fail-open -------------------------------------------------------------

    it('FAIL-OPEN: a thrown DB read resolves to all-enabled rather than propagating', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.userSettings.findUnique as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );

      const resolved = await service.resolve(USER_A);

      expect(resolved.enabled).toBe(true);
      for (const type of ALL_TYPES) expect(resolved.types[type]).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(USER_A));
    });

    it('FAIL-OPEN: isEnabled() also resolves true for every type when the DB read throws', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.userSettings.findUnique as jest.Mock).mockRejectedValue(
        new Error('db down'),
      );

      await expect(
        service.isEnabled(USER_A, 'upload_completed'),
      ).resolves.toBe(true);
      await expect(
        service.isEnabled(USER_A, 'enrichment_failed'),
      ).resolves.toBe(true);
    });

    it('a fail-open result is NOT cached as if it were a real answer — a later successful read overrides it on next call once the TTL underlying entry is gone', async () => {
      // resolve() does not cache the fail-open value at all (the catch branch
      // returns without calling store()), so the very next call re-queries.
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.userSettings.findUnique as jest.Mock)
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ value: { notifications: { enabled: false } } });

      const first = await service.resolve(USER_A);
      expect(first.enabled).toBe(true); // fail-open

      const second = await service.resolve(USER_A);
      expect(second.enabled).toBe(false); // real answer, not swallowed by a bad cache entry
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // isEnabled()
  // ---------------------------------------------------------------------------

  describe('isEnabled()', () => {
    it('returns true for a type with no override', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.isEnabled(USER_A, 'upload_completed')).resolves.toBe(true);
    });

    it('returns false for a type explicitly disabled', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: { types: { upload_completed: false } } },
      });

      await expect(service.isEnabled(USER_A, 'upload_completed')).resolves.toBe(false);
      // A sibling type is untouched.
      await expect(service.isEnabled(USER_A, 'enrichment_failed')).resolves.toBe(true);
    });

    it('returns false for EVERY type when the master switch is off', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: { enabled: false } },
      });

      for (const type of ALL_TYPES) {
        await expect(service.isEnabled(USER_A, type)).resolves.toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // allowsWorkflowMicroRuns()
  // ---------------------------------------------------------------------------

  describe('allowsWorkflowMicroRuns()', () => {
    it('is false by default (absent namespace)', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.allowsWorkflowMicroRuns(USER_A)).resolves.toBe(false);
    });

    it('is true when explicitly opted in AND the master switch is on', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: { workflowMicroRuns: true } },
      });

      await expect(service.allowsWorkflowMicroRuns(USER_A)).resolves.toBe(true);
    });

    it('is false when opted in but the master switch is off — the AND', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: { enabled: false, workflowMicroRuns: true } },
      });

      await expect(service.allowsWorkflowMicroRuns(USER_A)).resolves.toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // prime() — batched warm-up
  // ---------------------------------------------------------------------------

  describe('prime()', () => {
    it('fetches every uncached user in ONE findMany call', async () => {
      (mockPrisma.userSettings.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_A, value: {} },
        { userId: USER_B, value: { notifications: { enabled: false } } },
      ]);

      await service.prime([USER_A, USER_B]);

      expect(mockPrisma.userSettings.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.userSettings.findMany).toHaveBeenCalledWith({
        where: { userId: { in: [USER_A, USER_B] } },
        select: { userId: true, value: true },
      });
    });

    it('primed users are served from cache afterward — no per-user resolve() query', async () => {
      (mockPrisma.userSettings.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_A, value: {} },
        { userId: USER_B, value: { notifications: { enabled: false } } },
      ]);

      await service.prime([USER_A, USER_B]);

      const a = await service.resolve(USER_A);
      const b = await service.resolve(USER_B);

      expect(a.enabled).toBe(true);
      expect(b.enabled).toBe(false);
      expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
    });

    it('a user with NO settings row is cached as all-enabled — a real answer, not a retry-later miss', async () => {
      (mockPrisma.userSettings.findMany as jest.Mock).mockResolvedValue([
        // USER_B has no row at all, so it never appears in the findMany result.
        { userId: USER_A, value: {} },
      ]);

      await service.prime([USER_A, USER_B]);
      const b = await service.resolve(USER_B);

      expect(b.enabled).toBe(true);
      // Still served from the prime()-populated cache, not a fresh query.
      expect(mockPrisma.userSettings.findUnique).not.toHaveBeenCalled();
    });

    it('skips users already fresh in the cache — dedupes the findMany `in` list', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({ value: {} });
      await service.resolve(USER_A); // primes A via the per-user path

      (mockPrisma.userSettings.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_B, value: {} },
      ]);
      await service.prime([USER_A, USER_B]);

      expect(mockPrisma.userSettings.findMany).toHaveBeenCalledWith({
        where: { userId: { in: [USER_B] } },
        select: { userId: true, value: true },
      });
    });

    it('does nothing (no query) when every requested user is already fresh', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({ value: {} });
      await service.resolve(USER_A);

      await service.prime([USER_A]);

      expect(mockPrisma.userSettings.findMany).not.toHaveBeenCalled();
    });

    it('dedupes repeated ids within the same prime() call', async () => {
      (mockPrisma.userSettings.findMany as jest.Mock).mockResolvedValue([
        { userId: USER_A, value: {} },
      ]);

      await service.prime([USER_A, USER_A, USER_A]);

      expect(mockPrisma.userSettings.findMany).toHaveBeenCalledWith({
        where: { userId: { in: [USER_A] } },
        select: { userId: true, value: true },
      });
    });

    it('BEST-EFFORT: a findMany failure never throws, and leaves the cache cold (resolve() falls back per-user)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      (mockPrisma.userSettings.findMany as jest.Mock).mockRejectedValue(new Error('db down'));
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({
        value: { notifications: { enabled: false } },
      });

      await expect(service.prime([USER_A])).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();

      // The cache was never populated, so resolve() takes its own (also
      // fail-open, but here successful) per-user path.
      const resolved = await service.resolve(USER_A);
      expect(resolved.enabled).toBe(false);
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // invalidate()
  // ---------------------------------------------------------------------------

  describe('invalidate()', () => {
    it('drops the cached entry so the next resolve() re-queries', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({ value: {} });

      await service.resolve(USER_A);
      service.invalidate(USER_A);
      await service.resolve(USER_A);

      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2);
    });

    it('invalidating one user does not evict another user’s cached entry', async () => {
      (mockPrisma.userSettings.findUnique as jest.Mock).mockResolvedValue({ value: {} });

      await service.resolve(USER_A);
      await service.resolve(USER_B);
      service.invalidate(USER_A);

      await service.resolve(USER_B); // still cached
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(2); // A + B initial reads only

      await service.resolve(USER_A); // A was evicted, re-queries
      expect(mockPrisma.userSettings.findUnique).toHaveBeenCalledTimes(3);
    });
  });
});
