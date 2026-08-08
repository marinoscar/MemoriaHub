/**
 * Unit tests for NodeBackupQueryService (issue #310, epic #308 — Local Media
 * Backup via Worker Nodes).
 *
 * Covers: resolveScope intersection semantics, getChanges keyset where-clause
 * shape (cursor null vs. set), maxPageSize clamping, the safety horizon,
 * trashed/archived inclusion, scope filtering, ordering, and the deep-scan
 * guarantee that the select never touches `embedding`/`embeddingVec`;
 * getManifest id-keyset paging and the 1000-row hard cap; composeSidecar's
 * exact schemaVersion-1 shape and BigInt-safe JSON round-trip.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  NodeBackupQueryService,
  BackupFeedItem,
} from './node-backup-query.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Forbidden select keys — these must never appear anywhere in a change-feed select. */
const FORBIDDEN_SELECT_KEYS = ['embedding', 'embeddingVec'];

/** Recursively scan an object (e.g. a Prisma `select`) for forbidden keys. */
function findForbiddenKeys(
  obj: unknown,
  forbidden: string[],
  path = '$',
  hits: string[] = [],
): string[] {
  if (obj === null || typeof obj !== 'object') return hits;
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (forbidden.includes(key)) {
      hits.push(`${path}.${key}`);
    }
    findForbiddenKeys(value, forbidden, `${path}.${key}`, hits);
  }
  return hits;
}

function defaultSettings(overrides: Partial<{ maxPageSize: number; feedSafetyHorizonSeconds: number }> = {}) {
  return {
    backup: {
      maxPageSize: 200,
      feedSafetyHorizonSeconds: 5,
      runStaleMinutes: 15,
      ...overrides,
    },
  };
}

function makeFeedItem(overrides: Partial<any> = {}): BackupFeedItem {
  return {
    id: 'item-1',
    circleId: 'circle-1',
    type: 'photo',
    originalFilename: 'photo.jpg',
    capturedAt: new Date('2026-01-01T10:00:00.000Z'),
    capturedAtOffset: -300,
    createdAt: new Date('2026-01-01T10:05:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    importedAt: new Date('2026-01-01T10:05:01.000Z'),
    contentHash: 'a'.repeat(64),
    width: 1600,
    height: 1200,
    durationMs: null,
    orientation: 1,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15',
    description: 'A photo of a sunset',
    favorite: true,
    archivedAt: null,
    deletedAt: null,
    takenLat: 37.7749,
    takenLng: -122.4194,
    takenAltitude: 12.3,
    coordSource: 'exif',
    geoCountry: 'United States',
    geoCountryCode: 'US',
    geoAdmin1: 'California',
    geoAdmin2: 'San Francisco County',
    geoLocality: 'San Francisco',
    geoPlaceName: 'Golden Gate Park',
    geoSource: 'offline',
    sourcePath: '/DCIM/100APPLE/IMG_0001.jpg',
    sourceDeviceId: 'device-abc',
    sourceDeviceName: "Oscar's iPhone",
    metadata: { foo: 'bar' },
    circle: { name: 'Family' },
    storageObject: {
      id: 'obj-1',
      size: BigInt('123456789012'),
      mimeType: 'image/jpeg',
      storageKey: 'uploads/img-0001.jpg',
      status: 'ready',
    },
    mediaTags: [
      { source: 'manual', tag: { name: 'vacation' } },
      { source: 'ai', tag: { name: 'sunset' } },
    ],
    albumItems: [
      { album: { id: 'album-1', name: 'Summer 2026' } },
    ],
    faces: [
      {
        id: 'face-1',
        personId: 'person-1',
        boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        confidence: 0.98,
        videoTimestampMs: null,
        manuallyAssigned: false,
        person: { id: 'person-1', name: 'Alice', favorite: false },
      },
      // Same person again on a second face — must dedupe to ONE people entry.
      {
        id: 'face-2',
        personId: 'person-1',
        boundingBox: { x: 0.5, y: 0.5, w: 0.15, h: 0.15 },
        confidence: 0.91,
        videoTimestampMs: null,
        manuallyAssigned: false,
        person: { id: 'person-1', name: 'Alice', favorite: false },
      },
      // Unassigned face — personId null, no person row.
      {
        id: 'face-3',
        personId: null,
        boundingBox: { x: 0.8, y: 0.05, w: 0.1, h: 0.1 },
        confidence: 0.72,
        videoTimestampMs: null,
        manuallyAssigned: false,
        person: null,
      },
    ],
    ...overrides,
  } as unknown as BackupFeedItem;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeBackupQueryService', () => {
  let service: NodeBackupQueryService;
  let mockPrisma: MockPrismaService;
  let mockSystemSettings: { getSettings: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockSystemSettings = {
      getSettings: jest.fn().mockResolvedValue(defaultSettings()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NodeBackupQueryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SystemSettingsService, useValue: mockSystemSettings },
      ],
    }).compile();

    service = module.get<NodeBackupQueryService>(NodeBackupQueryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // resolveScope
  // -------------------------------------------------------------------------

  describe('resolveScope', () => {
    it('returns ALL member circle ids when configured circleIds is empty (empty = all circles)', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a' },
        { circleId: 'circle-b' },
        { circleId: 'circle-c' },
      ]);

      const scope = await service.resolveScope('owner-1', []);

      expect(mockPrisma.circleMember.findMany).toHaveBeenCalledWith({
        where: { userId: 'owner-1' },
        select: { circleId: true },
      });
      expect(scope.sort()).toEqual(['circle-a', 'circle-b', 'circle-c'].sort());
    });

    it('intersects membership with a non-empty configured circleIds list', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a' },
        { circleId: 'circle-b' },
        { circleId: 'circle-c' },
      ]);

      const scope = await service.resolveScope('owner-1', ['circle-b', 'circle-d']);

      // circle-d is requested but the owner isn't a member -> excluded.
      // circle-a/c are memberships but not requested -> excluded.
      expect(scope).toEqual(['circle-b']);
    });

    it('returns an empty array when the intersection is empty', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([
        { circleId: 'circle-a' },
      ]);

      const scope = await service.resolveScope('owner-1', ['circle-z']);

      expect(scope).toEqual([]);
    });

    it('returns an empty array when the owner has no memberships at all', async () => {
      (mockPrisma.circleMember.findMany as jest.Mock).mockResolvedValue([]);

      const scope = await service.resolveScope('owner-1', []);

      expect(scope).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getChanges
  // -------------------------------------------------------------------------

  describe('getChanges', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('returns [] and never queries Prisma when scope is empty', async () => {
      const result = await service.getChanges([], null, 100);

      expect(result).toEqual([]);
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('builds a plain (no OR) where clause when cursor is null', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.OR).toBeUndefined();
      expect(call.where.circleId).toEqual({ in: ['circle-1'] });
      expect(call.where.updatedAt).toHaveProperty('lte');
    });

    it('builds the two-branch OR/updatedAt-id tiebreak clause when a cursor is set', async () => {
      const cursor = { updatedAt: new Date('2026-01-01T00:00:00.000Z'), id: 'cursor-item' };

      await service.getChanges(['circle-1'], cursor, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.OR).toEqual([
        { updatedAt: { gt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
      ]);
      // The AND-composed circleId/horizon predicates remain present alongside OR.
      expect(call.where.circleId).toEqual({ in: ['circle-1'] });
    });

    it('clamps the requested limit to backup.maxPageSize', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(defaultSettings({ maxPageSize: 50 }));

      await service.getChanges(['circle-1'], null, 5000);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(50);
    });

    it('uses the requested limit as-is when it is below maxPageSize', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(defaultSettings({ maxPageSize: 200 }));

      await service.getChanges(['circle-1'], null, 25);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(25);
    });

    it('floors take at 1 even for a non-positive requested limit', async () => {
      await service.getChanges(['circle-1'], null, 0);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(1);
    });

    it('applies the safety horizon: updatedAt.lte is ~feedSafetyHorizonSeconds in the past', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(defaultSettings({ feedSafetyHorizonSeconds: 5 }));
      const before = Date.now();

      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      const lte = call.where.updatedAt.lte as Date;
      const diffMs = before - lte.getTime();

      // Should be very close to 5000ms in the past — generous tolerance for
      // test-runner scheduling jitter, but far from 0 or from a wildly
      // different horizon.
      expect(diffMs).toBeGreaterThanOrEqual(5000 - 50);
      expect(diffMs).toBeLessThan(5000 + 2000);
    });

    it('honors a custom horizon value from settings', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(defaultSettings({ feedSafetyHorizonSeconds: 30 }));
      const before = Date.now();

      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      const lte = call.where.updatedAt.lte as Date;
      const diffMs = before - lte.getTime();

      expect(diffMs).toBeGreaterThanOrEqual(30000 - 50);
      expect(diffMs).toBeLessThan(30000 + 2000);
    });

    it('includes trashed items — no deletedAt filter in the where clause', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).not.toHaveProperty('deletedAt');
    });

    it('includes archived items — no archivedAt filter in the where clause', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).not.toHaveProperty('archivedAt');
    });

    it('filters by the given scope (circleId in [...])', async () => {
      await service.getChanges(['circle-a', 'circle-b'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.circleId).toEqual({ in: ['circle-a', 'circle-b'] });
    });

    it('orders by (updatedAt asc, id asc)', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    });

    it('never selects embedding or embeddingVec anywhere in the select tree', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      const hits = findForbiddenKeys(call.select, FORBIDDEN_SELECT_KEYS);
      expect(hits).toEqual([]);
    });

    it('the select faces sub-select carries no embedding-shaped field', async () => {
      await service.getChanges(['circle-1'], null, 50);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      const faceSelect = call.select.faces.select;
      expect(Object.keys(faceSelect)).not.toEqual(
        expect.arrayContaining(['embedding', 'embeddingVec']),
      );
    });
  });

  // -------------------------------------------------------------------------
  // composeSidecar
  // -------------------------------------------------------------------------

  describe('composeSidecar', () => {
    it('builds the exact schemaVersion-1 shape from a fully-populated item', () => {
      const item = makeFeedItem();

      const sidecar = service.composeSidecar(item);

      expect(sidecar.schemaVersion).toBe(1);
      expect(sidecar.mediaItemId).toBe('item-1');
      expect(sidecar.circleId).toBe('circle-1');
      expect(sidecar.circleName).toBe('Family');
      expect(sidecar.type).toBe('photo');
      expect(sidecar.originalFilename).toBe('photo.jpg');
      expect(sidecar.capturedAt).toBe('2026-01-01T10:00:00.000Z');
      expect(sidecar.capturedAtOffset).toBe(-300);
      expect(sidecar.createdAt).toBe('2026-01-01T10:05:00.000Z');
      expect(sidecar.updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(sidecar.importedAt).toBe('2026-01-01T10:05:01.000Z');
      expect(sidecar.contentHash).toBe('a'.repeat(64));

      // BigInt size becomes a STRING (BigInt-safe boundary).
      expect(sidecar.size).toBe('123456789012');
      expect(typeof sidecar.size).toBe('string');

      expect(sidecar.mimeType).toBe('image/jpeg');
      expect(sidecar.width).toBe(1600);
      expect(sidecar.height).toBe(1200);
      expect(sidecar.durationMs).toBeNull();
      expect(sidecar.orientation).toBe(1);
      expect(sidecar.cameraMake).toBe('Apple');
      expect(sidecar.cameraModel).toBe('iPhone 15');
      expect(sidecar.description).toBe('A photo of a sunset');
      expect(sidecar.favorite).toBe(true);
      expect(sidecar.archivedAt).toBeNull();
      expect(sidecar.deletedAt).toBeNull();

      expect(sidecar.geo).toEqual({
        takenLat: 37.7749,
        takenLng: -122.4194,
        takenAltitude: 12.3,
        coordSource: 'exif',
        country: 'United States',
        countryCode: 'US',
        admin1: 'California',
        admin2: 'San Francisco County',
        locality: 'San Francisco',
        placeName: 'Golden Gate Park',
        geoSource: 'offline',
      });

      expect(sidecar.tags).toEqual([
        { name: 'vacation', source: 'manual' },
        { name: 'sunset', source: 'ai' },
      ]);

      expect(sidecar.albums).toEqual([{ id: 'album-1', name: 'Summer 2026' }]);

      expect(sidecar.faces).toEqual([
        {
          id: 'face-1',
          personId: 'person-1',
          boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          confidence: 0.98,
          videoTimestampMs: null,
          manuallyAssigned: false,
        },
        {
          id: 'face-2',
          personId: 'person-1',
          boundingBox: { x: 0.5, y: 0.5, w: 0.15, h: 0.15 },
          confidence: 0.91,
          videoTimestampMs: null,
          manuallyAssigned: false,
        },
        {
          id: 'face-3',
          personId: null,
          boundingBox: { x: 0.8, y: 0.05, w: 0.1, h: 0.1 },
          confidence: 0.72,
          videoTimestampMs: null,
          manuallyAssigned: false,
        },
      ]);

      expect(sidecar.sourcePath).toBe('/DCIM/100APPLE/IMG_0001.jpg');
      expect(sidecar.sourceDeviceId).toBe('device-abc');
      expect(sidecar.sourceDeviceName).toBe("Oscar's iPhone");
      expect(sidecar.metadata).toEqual({ foo: 'bar' });

      // exportedAt is generated at call time — assert it's a valid ISO string.
      expect(typeof sidecar.exportedAt).toBe('string');
      expect(() => new Date(sidecar.exportedAt).toISOString()).not.toThrow();
    });

    it('derives `people` as the DISTINCT set of persons across faces (dedupes repeated personId)', () => {
      const item = makeFeedItem();

      const sidecar = service.composeSidecar(item);

      // Two faces share person-1, one face is unassigned (personId null) -> one person.
      expect(sidecar.people).toEqual([
        { personId: 'person-1', name: 'Alice', favorite: false },
      ]);
    });

    it('produces an empty people array when no face has an assigned person', () => {
      const item = makeFeedItem({
        faces: [
          {
            id: 'face-x',
            personId: null,
            boundingBox: { x: 0, y: 0, w: 0, h: 0 },
            confidence: null,
            videoTimestampMs: null,
            manuallyAssigned: false,
            person: null,
          },
        ],
      });

      const sidecar = service.composeSidecar(item);

      expect(sidecar.people).toEqual([]);
    });

    it('handles a null storageObject by nulling size and mimeType', () => {
      const item = makeFeedItem({ storageObject: null });

      const sidecar = service.composeSidecar(item);

      expect(sidecar.size).toBeNull();
      expect(sidecar.mimeType).toBeNull();
    });

    it('handles null timestamps (capturedAt, archivedAt, deletedAt) as null, not throwing', () => {
      const item = makeFeedItem({ capturedAt: null, archivedAt: null, deletedAt: null });

      const sidecar = service.composeSidecar(item);

      expect(sidecar.capturedAt).toBeNull();
      expect(sidecar.archivedAt).toBeNull();
      expect(sidecar.deletedAt).toBeNull();
    });

    it('defaults metadata to {} when the item metadata is null', () => {
      const item = makeFeedItem({ metadata: null });

      const sidecar = service.composeSidecar(item);

      expect(sidecar.metadata).toEqual({});
    });

    it('round-trips through JSON.stringify without throwing (BigInt-safety proof)', () => {
      const item = makeFeedItem();

      const sidecar = service.composeSidecar(item);

      expect(() => JSON.stringify(sidecar)).not.toThrow();
      const roundTripped = JSON.parse(JSON.stringify(sidecar));
      expect(roundTripped.size).toBe('123456789012');
      expect(roundTripped.mediaItemId).toBe('item-1');
    });

    it('round-trips a huge (>2^53) size value as a lossless string, unlike a raw BigInt', () => {
      const hugeSize = BigInt('9223372036854775000'); // near int64 max, unsigned-safe territory
      const item = makeFeedItem({ storageObject: { id: 'obj-1', size: hugeSize, mimeType: 'video/mp4', storageKey: 'k', status: 'ready' } });

      const sidecar = service.composeSidecar(item);

      expect(sidecar.size).toBe('9223372036854775000');
      expect(() => JSON.stringify(sidecar)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getManifest
  // -------------------------------------------------------------------------

  describe('getManifest', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValue([]);
    });

    it('returns [] and never queries Prisma when scope is empty', async () => {
      const result = await service.getManifest([], null, 100);

      expect(result).toEqual([]);
      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('omits the id filter when afterId is null (first page)', async () => {
      await service.getManifest(['circle-1'], null, 100);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).not.toHaveProperty('id');
      expect(call.where.circleId).toEqual({ in: ['circle-1'] });
    });

    it('applies an id-gt keyset filter when afterId is set', async () => {
      await service.getManifest(['circle-1'], 'cursor-item-id', 100);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where.id).toEqual({ gt: 'cursor-item-id' });
    });

    it('orders by id asc', async () => {
      await service.getManifest(['circle-1'], null, 100);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.orderBy).toEqual({ id: 'asc' });
    });

    it('caps the requested limit at 1000 regardless of a larger request', async () => {
      await service.getManifest(['circle-1'], null, 5000);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(1000);
    });

    it('uses the requested limit as-is when below the 1000 cap', async () => {
      await service.getManifest(['circle-1'], null, 250);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(250);
    });

    it('floors take at 1 even for a non-positive requested limit', async () => {
      await service.getManifest(['circle-1'], null, -5);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.take).toBe(1);
    });

    it('is not gated by backup.maxPageSize — cap is independent of the feed page size setting', async () => {
      mockSystemSettings.getSettings.mockResolvedValue(defaultSettings({ maxPageSize: 50 }));

      await service.getManifest(['circle-1'], null, 900);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      // maxPageSize (50) is NOT applied here — only the 1000 manifest cap is.
      expect(call.take).toBe(900);
      // getManifest never even reads settings.
      expect(mockSystemSettings.getSettings).not.toHaveBeenCalled();
    });

    it('selects exactly id, contentHash, updatedAt, deletedAt, archivedAt', async () => {
      await service.getManifest(['circle-1'], null, 100);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.select).toEqual({
        id: true,
        contentHash: true,
        updatedAt: true,
        deletedAt: true,
        archivedAt: true,
      });
    });

    it('includes trashed and archived items — no deletedAt/archivedAt filter in where', async () => {
      await service.getManifest(['circle-1'], null, 100);

      const call = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[0][0];
      expect(call.where).not.toHaveProperty('deletedAt');
      expect(call.where).not.toHaveProperty('archivedAt');
    });
  });
});
