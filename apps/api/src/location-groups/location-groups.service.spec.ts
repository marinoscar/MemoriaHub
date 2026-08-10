/**
 * Unit tests for LocationGroupsService — the Location Grouping management API
 * (issue #374).
 *
 * Prisma is mocked, so no database is required. The assertions that matter
 * most here are:
 *
 *   - the cross-group member `409` carries its owner THROUGH the real
 *     `HttpExceptionFilter` (see the harness note below);
 *   - every mutation invalidates the resolver cache AND enqueues exactly one
 *     rebuild;
 *   - the geometry and cover-item validations reject rather than silently
 *     storing something that can never match.
 */
import { ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { LocationGroupsService, titleCase } from './location-groups.service';
import { LocationGroupResolverService } from './location-group-resolver.service';
import { LocationGroupRebuildService } from './location-group-rebuild.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

/**
 * Run a thrown exception through the REAL app-wide `HttpExceptionFilter` and
 * return the body the client would actually receive.
 *
 * ⚠️ This is the load-bearing assertion for the `409` contract. The filter does
 * NOT spread an exception payload — it rebuilds every body from a fixed key
 * allowlist (`message`, `code`, `details`, `error`, `error_description`,
 * `startedAt`), so a top-level `groupId` would type-check, satisfy any
 * assertion on `err.getResponse()`, and still never reach the wire. Mirrors the
 * harness in `db-backup-admin.service.spec.ts` and
 * `common/filters/http-exception.filter.spec.ts`.
 */
function sendThroughFilter(exception: unknown): any {
  const response = {
    code: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ url: '/api/location-groups', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;

  new HttpExceptionFilter().catch(exception, host);
  return response.send.mock.calls[0][0];
}

const SETTINGS = {
  features: { locationGrouping: true },
  locationGrouping: {
    radiusCaptureEnabled: true,
    maxRadiusKm: 50,
    suggestionMinItems: 1,
  },
};

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 'group-1',
    level: 'region',
    canonicalName: 'Heredia',
    normalizedName: 'heredia',
    countryCode: 'CR',
    coverMediaItemId: null,
    centerLat: null,
    centerLng: null,
    radiusKm: null,
    enabled: true,
    notes: null,
    createdById: 'user-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    aliases: [],
    _count: { aliases: 0 },
    coverMediaItem: null,
    ...overrides,
  };
}

describe('LocationGroupsService', () => {
  let service: LocationGroupsService;
  let prisma: MockPrismaService;
  let resolver: { invalidate: jest.Mock };
  let rebuild: { enqueueRebuild: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrismaService();
    resolver = { invalidate: jest.fn() };
    rebuild = {
      enqueueRebuild: jest.fn().mockResolvedValue({ id: 'job-1', status: 'pending' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationGroupsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SystemSettingsService,
          useValue: { getSettings: jest.fn().mockResolvedValue(SETTINGS) },
        },
        { provide: LocationGroupResolverService, useValue: resolver },
        { provide: LocationGroupRebuildService, useValue: rebuild },
        {
          provide: MediaThumbnailService,
          useValue: {
            attachThumbnailUrls: jest
              .fn()
              .mockImplementation((rows: any[]) =>
                Promise.resolve(rows.map((r) => ({ ...r, thumbnailUrl: null }))),
              ),
          },
        },
      ],
    }).compile();

    service = module.get(LocationGroupsService);

    // Sensible "empty database" defaults; individual tests override.
    (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.locationGroup.count as jest.Mock).mockResolvedValue(0);
    (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([]);
  });

  // =========================================================================
  // 409: cross-group member conflict, asserted THROUGH the filter
  // =========================================================================

  describe('member conflict (409)', () => {
    it('reports the owning group at details.groupId / details.groupName ON THE WIRE', async () => {
      (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([
        {
          normalizedValue: 'heredia province',
          groupId: 'owner-group',
          group: { canonicalName: 'Heredia' },
        },
      ]);

      let thrown: unknown;
      try {
        await service.create(
          {
            level: 'region',
            canonicalName: 'Provincia de Heredia',
            countryCode: 'CR',
            memberValues: ['Heredia Province'],
            enabled: true,
          } as any,
          'user-1',
        );
      } catch (err) {
        thrown = err;
      }

      // The regression this guards: a top-level `groupId` on the thrown payload
      // is silently stripped by HttpExceptionFilter's allowlist, so it must be
      // nested under `details` — and the only proof of that is the real filter.
      const body = sendThroughFilter(thrown);
      expect(body).toMatchObject({
        statusCode: 409,
        details: { groupId: 'owner-group', groupName: 'Heredia' },
      });
      expect(prisma.locationGroup.create).not.toHaveBeenCalled();
    });

    it('never silently re-parents a claimed value — addMembers throws instead of creating an alias', async () => {
      (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroup({ id: 'group-2', canonicalName: 'Cartago', normalizedName: 'cartago' }),
      );
      (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([
        {
          normalizedValue: 'heredia',
          groupId: 'group-1',
          group: { canonicalName: 'Heredia' },
        },
      ]);

      const body = sendThroughFilter(
        await service.addMembers('group-2', ['Heredia']).catch((e) => e),
      );

      expect(body.statusCode).toBe(409);
      expect(body.details).toEqual({ groupId: 'group-1', groupName: 'Heredia' });
      expect(prisma.locationGroupAlias.createMany).not.toHaveBeenCalled();
    });

    it('409s when a member value collides with ANOTHER group\'s own canonical name', async () => {
      // A group's canonical name always resolves to itself, so it is just as
      // claimed as an explicit alias even though no alias row exists for it.
      (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroup({ id: 'group-2', canonicalName: 'Cartago', normalizedName: 'cartago' }),
      );
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        { id: 'group-1', canonicalName: 'Heredia', normalizedName: 'heredia' },
      ]);

      const body = sendThroughFilter(
        await service.addMembers('group-2', ['heredia']).catch((e) => e),
      );

      expect(body.statusCode).toBe(409);
      expect(body.details).toEqual({ groupId: 'group-1', groupName: 'Heredia' });
    });

    it('allows re-adding a value the SAME group already owns (idempotent, not a conflict)', async () => {
      (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(makeGroup());
      (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([
        {
          normalizedValue: 'heredia province',
          groupId: 'group-1',
          group: { canonicalName: 'Heredia' },
        },
      ]);
      (prisma.locationGroupAlias.createMany as jest.Mock).mockResolvedValue({ count: 0 });

      await expect(service.addMembers('group-1', ['Heredia Province'])).resolves.toEqual({
        added: 0,
      });
    });
  });

  // =========================================================================
  // Geometry validation
  // =========================================================================

  describe('geometry validation', () => {
    it('rejects a center without a radiusKm', async () => {
      await expect(
        service.create(
          {
            level: 'locality',
            canonicalName: 'The Woodlands',
            countryCode: 'US',
            memberValues: [],
            center: { lat: 30.15, lng: -95.48 },
            enabled: true,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a radiusKm without a center', async () => {
      await expect(
        service.create(
          {
            level: 'locality',
            canonicalName: 'The Woodlands',
            countryCode: 'US',
            memberValues: [],
            radiusKm: 12,
            enabled: true,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/must be supplied together/);
    });

    it('rejects a radiusKm above locationGrouping.maxRadiusKm', async () => {
      // The resolver silently CLAMPS to maxRadiusKm at match time; rejecting
      // here turns that invisible clamp into a 400 the admin can see.
      await expect(
        service.create(
          {
            level: 'locality',
            canonicalName: 'Greater Houston',
            countryCode: 'US',
            memberValues: [],
            center: { lat: 29.76, lng: -95.37 },
            radiusKm: 120,
            enabled: true,
          } as any,
          'user-1',
        ),
      ).rejects.toThrow(/exceeds locationGrouping.maxRadiusKm \(50\)/);
    });

    it('accepts a radiusKm exactly at the maximum', async () => {
      (prisma.locationGroup.create as jest.Mock).mockResolvedValue({
        id: 'group-new',
        aliases: [],
      });
      (prisma.locationGroup.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // uniqueness pre-check
        .mockResolvedValue(makeGroup()); // the trailing get()

      await service.create(
        {
          level: 'locality',
          canonicalName: 'Greater Houston',
          countryCode: 'US',
          memberValues: [],
          center: { lat: 29.76, lng: -95.37 },
          radiusKm: 50,
          enabled: true,
        } as any,
        'user-1',
      );

      expect(prisma.locationGroup.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ radiusKm: 50, centerLat: 29.76, centerLng: -95.37 }),
        }),
      );
    });
  });

  // =========================================================================
  // Cover item must resolve to the group
  // =========================================================================

  describe('cover item validation', () => {
    beforeEach(() => {
      (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(
        makeGroup({ aliases: [{ normalizedValue: 'heredia province' }] }),
      );
    });

    it('rejects a cover item whose location does not resolve to the group', async () => {
      (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue({
        id: 'item-1',
        geoCountryCode: 'CR',
        geoAdmin1: 'Guanacaste',
        geoCanonicalAdmin1: 'Guanacaste',
      });

      await expect(
        service.update('group-1', { coverMediaItemId: 'aaaaaaaa-0000-4000-8000-000000000001' } as any),
      ).rejects.toThrow(/does not resolve to group "Heredia"/);
    });

    it('accepts a cover item the rebuild has ALREADY claimed (canonical match)', async () => {
      (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue({
        id: 'item-1',
        geoCountryCode: 'CR',
        geoAdmin1: 'Heredia Province',
        geoCanonicalAdmin1: 'Heredia',
      });
      (prisma.locationGroup.update as jest.Mock).mockResolvedValue(makeGroup());

      await service.update('group-1', {
        coverMediaItemId: 'aaaaaaaa-0000-4000-8000-000000000001',
      } as any);

      expect(prisma.locationGroup.update).toHaveBeenCalled();
    });

    it('accepts a cover item the rebuild has NOT yet claimed (raw member match)', async () => {
      // The rebuild is asynchronous, so checking only the materialised
      // canonical column would reject every cover an admin picks in the seconds
      // right after creating a group — which is exactly when they pick one.
      (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue({
        id: 'item-1',
        geoCountryCode: 'CR',
        geoAdmin1: 'Heredia Province',
        geoCanonicalAdmin1: 'Heredia Province',
      });
      (prisma.locationGroup.update as jest.Mock).mockResolvedValue(makeGroup());

      await service.update('group-1', {
        coverMediaItemId: 'aaaaaaaa-0000-4000-8000-000000000001',
      } as any);

      expect(prisma.locationGroup.update).toHaveBeenCalled();
    });

    it('rejects a cover item outside the group\'s country scope', async () => {
      (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue({
        id: 'item-1',
        geoCountryCode: 'US',
        geoAdmin1: 'Heredia',
        geoCanonicalAdmin1: 'Heredia',
      });

      await expect(
        service.update('group-1', { coverMediaItemId: 'aaaaaaaa-0000-4000-8000-000000000001' } as any),
      ).rejects.toThrow(/country scope/);
    });

    it('rejects a cover item that does not exist', async () => {
      (prisma.mediaItem.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('group-1', { coverMediaItemId: 'aaaaaaaa-0000-4000-8000-000000000001' } as any),
      ).rejects.toThrow(/does not exist or has been deleted/);
    });
  });

  // =========================================================================
  // Every mutation invalidates + enqueues exactly one rebuild
  // =========================================================================

  describe('cache invalidation and rebuild enqueue', () => {
    beforeEach(() => {
      (prisma.locationGroup.findUnique as jest.Mock).mockResolvedValue(makeGroup());
      (prisma.locationGroup.create as jest.Mock).mockResolvedValue({
        id: 'group-1',
        aliases: [],
      });
      (prisma.locationGroup.update as jest.Mock).mockResolvedValue(makeGroup());
      (prisma.locationGroup.delete as jest.Mock).mockResolvedValue(makeGroup());
      (prisma.locationGroupAlias.createMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.locationGroupAlias.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
    });

    it('create invalidates the resolver and enqueues one rebuild', async () => {
      (prisma.locationGroup.findUnique as jest.Mock)
        .mockResolvedValueOnce(null) // uniqueness pre-check
        .mockResolvedValue(makeGroup()); // the trailing get()

      await service.create(
        {
          level: 'region',
          canonicalName: 'Heredia',
          countryCode: 'CR',
          memberValues: ['Heredia Province'],
          enabled: true,
        } as any,
        'user-1',
      );

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledTimes(1);
    });

    it('update invalidates the resolver and enqueues one rebuild', async () => {
      await service.update('group-1', { enabled: false } as any);

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledTimes(1);
    });

    it('delete invalidates the resolver and enqueues one rebuild', async () => {
      await service.remove('group-1');

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledTimes(1);
    });

    it('addMembers invalidates the resolver and enqueues one rebuild', async () => {
      await service.addMembers('group-1', ['Provincia de Heredia']);

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledTimes(1);
    });

    it('removeMembers invalidates the resolver and enqueues one rebuild', async () => {
      await service.removeMembers('group-1', ['Provincia de Heredia']);

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledTimes(1);
    });

    it('enqueues a FULL rebuild, never a groupIds-scoped one', async () => {
      // A groupId-scoped rebuild would be a data-loss bug: the job's RESET pass
      // always runs over the whole scope, so only the listed group would be
      // re-applied and every other group's canonical names would be stranded at
      // their raw values.
      await service.update('group-1', { enabled: false } as any);

      expect(rebuild.enqueueRebuild).toHaveBeenCalledWith({});
    });

    it('does NOT invalidate or enqueue when a mutation is rejected', async () => {
      await expect(
        service.update('group-1', {
          center: { lat: 10, lng: -84 },
        } as any),
      ).rejects.toThrow(BadRequestException);

      expect(resolver.invalidate).not.toHaveBeenCalled();
      expect(rebuild.enqueueRebuild).not.toHaveBeenCalled();
    });

    it('the explicit admin rebuild passes circleId/groupIds through verbatim', async () => {
      const result = await service.triggerRebuild({
        circleId: 'circle-1',
        groupIds: ['group-1'],
      });

      expect(resolver.invalidate).toHaveBeenCalledTimes(1);
      expect(rebuild.enqueueRebuild).toHaveBeenCalledWith({
        circleId: 'circle-1',
        groupIds: ['group-1'],
      });
      expect(result).toEqual({ data: { jobId: 'job-1', status: 'pending' } });
    });
  });

  // =========================================================================
  // Not found
  // =========================================================================

  describe('not found', () => {
    it.each(['get', 'remove'] as const)('%s throws NotFoundException for an unknown id', async (method) => {
      await expect((service as any)[method]('missing')).rejects.toThrow(NotFoundException);
    });

    it('update throws NotFoundException for an unknown id', async () => {
      await expect(service.update('missing', { enabled: true } as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // =========================================================================
  // GET /values
  // =========================================================================

  describe('listValues', () => {
    beforeEach(() => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 12 } },
        { geoAdmin1: 'Heredia Province', geoCountryCode: 'CR', _count: { _all: 5 } },
        { geoAdmin1: 'Guanacaste', geoCountryCode: 'CR', _count: { _all: 30 } },
      ]);
      (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([
        {
          countryCode: 'CR',
          normalizedValue: 'heredia province',
          groupId: 'group-1',
          group: { canonicalName: 'Heredia' },
        },
      ]);
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        { id: 'group-1', countryCode: 'CR', normalizedName: 'heredia', canonicalName: 'Heredia' },
      ]);
    });

    it('annotates each value with the group that owns it', async () => {
      const result = await service.listValues({
        level: 'region',
        grouped: 'all',
        limit: 500,
      } as any);

      const byValue = new Map(result.items.map((i) => [i.value, i]));
      expect(byValue.get('Heredia Province')).toMatchObject({
        groupId: 'group-1',
        groupCanonicalName: 'Heredia',
      });
      // A group's own canonical name counts as claimed even without an alias row.
      expect(byValue.get('Heredia')).toMatchObject({ groupId: 'group-1' });
      expect(byValue.get('Guanacaste')).toMatchObject({
        groupId: null,
        groupCanonicalName: null,
      });
    });

    it('grouped=ungrouped excludes already-claimed values', async () => {
      const result = await service.listValues({
        level: 'region',
        grouped: 'ungrouped',
        limit: 500,
      } as any);

      expect(result.items.map((i) => i.value)).toEqual(['Guanacaste']);
    });

    it('grouped=grouped returns only claimed values', async () => {
      const result = await service.listValues({
        level: 'region',
        grouped: 'grouped',
        limit: 500,
      } as any);

      expect(result.items.map((i) => i.value).sort()).toEqual([
        'Heredia',
        'Heredia Province',
      ]);
    });

    it('reads the RAW column app-wide via ONE groupBy — no circle scope, no per-row lookup', async () => {
      await service.listValues({ level: 'region', grouped: 'all', limit: 500 } as any);

      expect(prisma.mediaItem.groupBy).toHaveBeenCalledTimes(1);
      const [call] = (prisma.mediaItem.groupBy as jest.Mock).mock.calls;
      expect(call[0].by).toEqual(['geoAdmin1', 'geoCountryCode']);
      expect(call[0].where.circleId).toBeUndefined();
      expect(prisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('orders by itemCount descending and honours the limit', async () => {
      const result = await service.listValues({
        level: 'region',
        grouped: 'all',
        limit: 2,
      } as any);

      expect(result.items.map((i) => i.value)).toEqual(['Guanacaste', 'Heredia']);
    });
  });

  // =========================================================================
  // GET /suggestions
  // =========================================================================

  describe('suggestions', () => {
    it('clusters the three Heredia spellings and proposes "Heredia"', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 12 } },
        { geoAdmin1: 'Heredia Province', geoCountryCode: 'CR', _count: { _all: 5 } },
        { geoAdmin1: 'Provincia de Heredia', geoCountryCode: 'CR', _count: { _all: 3 } },
        { geoAdmin1: 'Guanacaste', geoCountryCode: 'CR', _count: { _all: 30 } },
      ]);

      const result = await service.suggestions({ level: 'region', limit: 50 } as any);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].suggestedCanonicalName).toBe('Heredia');
      expect(result.items[0].countryCode).toBe('CR');
      expect(result.items[0].totalItems).toBe(20);
      expect(result.items[0].members.map((m) => m.value).sort()).toEqual([
        'Heredia',
        'Heredia Province',
        'Provincia de Heredia',
      ]);
    });

    it('never proposes a singleton cluster', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Guanacaste', geoCountryCode: 'CR', _count: { _all: 30 } },
      ]);

      const result = await service.suggestions({ level: 'region', limit: 50 } as any);

      expect(result.items).toEqual([]);
    });

    it('excludes values already claimed by a group', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 12 } },
        { geoAdmin1: 'Heredia Province', geoCountryCode: 'CR', _count: { _all: 5 } },
      ]);
      (prisma.locationGroupAlias.findMany as jest.Mock).mockResolvedValue([
        {
          countryCode: 'CR',
          normalizedValue: 'heredia province',
          groupId: 'group-1',
          group: { canonicalName: 'Heredia' },
        },
      ]);

      const result = await service.suggestions({ level: 'region', limit: 50 } as any);

      // Only one unclaimed spelling remains, so there is nothing to propose.
      expect(result.items).toEqual([]);
    });

    it('never merges the same name across two different countries', async () => {
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Ontario', geoCountryCode: 'CA', _count: { _all: 9 } },
        { geoAdmin1: 'Ontario Province', geoCountryCode: 'CA', _count: { _all: 2 } },
        { geoAdmin1: 'Ontario', geoCountryCode: 'US', _count: { _all: 4 } },
      ]);

      const result = await service.suggestions({ level: 'region', limit: 50 } as any);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].countryCode).toBe('CA');
    });

    it('excludes values below locationGrouping.suggestionMinItems', async () => {
      const settings = module_getSettingsWithMin(3);
      (service as any).systemSettings = { getSettings: jest.fn().mockResolvedValue(settings) };
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 12 } },
        { geoAdmin1: 'Heredia Province', geoCountryCode: 'CR', _count: { _all: 1 } },
      ]);

      const result = await service.suggestions({ level: 'region', limit: 50 } as any);

      // Only "Heredia" clears the floor, so the cluster falls below the
      // two-member minimum and nothing is proposed.
      expect(result.items).toEqual([]);
    });
  });

  // =========================================================================
  // Counting
  // =========================================================================

  describe('item counts', () => {
    it('derives itemCount from ONE groupBy per level, never a per-group query', async () => {
      (prisma.locationGroup.count as jest.Mock).mockResolvedValue(2);
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        makeGroup({ id: 'g1', canonicalName: 'Heredia', countryCode: 'CR' }),
        makeGroup({ id: 'g2', canonicalName: 'Guanacaste', countryCode: 'CR' }),
      ]);
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoCanonicalAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 17 } },
        { geoCanonicalAdmin1: 'Guanacaste', geoCountryCode: 'CR', _count: { _all: 30 } },
        { geoCanonicalAdmin1: 'Heredia', geoCountryCode: 'US', _count: { _all: 4 } },
      ]);

      const result = await service.list({ page: 1, pageSize: 50 } as any);

      // Two groups, both at the `region` level ⇒ exactly one aggregate query.
      expect(prisma.mediaItem.groupBy).toHaveBeenCalledTimes(1);
      expect(result.items.find((i) => i.id === 'g1')!.itemCount).toBe(17);
      expect(result.items.find((i) => i.id === 'g2')!.itemCount).toBe(30);
    });

    it("an unscoped ('') group counts items from every country", async () => {
      (prisma.locationGroup.count as jest.Mock).mockResolvedValue(1);
      (prisma.locationGroup.findMany as jest.Mock).mockResolvedValue([
        makeGroup({ id: 'g1', canonicalName: 'Heredia', countryCode: '' }),
      ]);
      (prisma.mediaItem.groupBy as jest.Mock).mockResolvedValue([
        { geoCanonicalAdmin1: 'Heredia', geoCountryCode: 'CR', _count: { _all: 17 } },
        { geoCanonicalAdmin1: 'Heredia', geoCountryCode: 'US', _count: { _all: 4 } },
      ]);

      const result = await service.list({ page: 1, pageSize: 50 } as any);

      expect(result.items[0].itemCount).toBe(21);
    });
  });

  // =========================================================================
  // titleCase
  // =========================================================================

  describe('titleCase', () => {
    it.each([
      ['heredia', 'Heredia'],
      ['san jose', 'San Jose'],
      ['the woodlands', 'The Woodlands'],
      ['', ''],
    ])('%s → %s', (input, expected) => {
      expect(titleCase(input)).toBe(expected);
    });
  });
});

/** Settings clone with a different suggestionMinItems floor. */
function module_getSettingsWithMin(min: number) {
  return {
    ...SETTINGS,
    locationGrouping: { ...SETTINGS.locationGrouping, suggestionMinItems: min },
  };
}
