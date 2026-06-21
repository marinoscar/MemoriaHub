/**
 * Service-level tests for MediaService.streamExport (Phase 04 — Metadata Export)
 *
 * Test style: SERVICE-LEVEL with mocked PrismaService.
 *
 * Rationale: The project has no live test database in this environment.
 * All Phase 02/03 tests (media-metadata-sync.service.spec.ts,
 * media.service.spec.ts) use jest-mock-extended or jest.fn() Prisma mocks with
 * a NestJS TestingModule. This file follows that exact pattern.
 * An HTTP integration test would require a real Fastify request context with
 * working auth guards; bypassing the route layer and testing the service method
 * directly provides cleaner, faster isolation for streaming behaviour.
 *
 * Async CSV flush strategy: we provide a real stream.PassThrough as res.raw so
 * the real csv-stringify library pipes into it. We await the PassThrough
 * 'finish' event (via a small Promise wrapper) AFTER calling streamExport,
 * letting the pipe chain drain fully before assertions are made.
 */

import { PassThrough } from 'stream';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { MediaService } from '../../src/media/media.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { STORAGE_PROVIDER } from '../../src/storage/providers/storage-provider.interface';
import { MediaMetadataSyncService } from '../../src/media/sync/media-metadata-sync.service';
import { CircleMembershipService } from '../../src/circles/circle-membership.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../mocks/prisma.mock';
import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { GEO_LOCATION_PROVIDER } from '../../src/media/geo/geo-location-provider.interface';
import { ForwardGeocodeService } from '../../src/media/geo/forward-geocode.service';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CALLER_ID = 'caller-user-uuid-001';
const OTHER_ID = 'other-user-uuid-002';

const OWN_PERMS = [PERMISSIONS.MEDIA_READ];
const ANY_PERMS = [PERMISSIONS.MEDIA_READ, PERMISSIONS.MEDIA_READ_ANY];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Build a MediaItem row as Prisma would return it from findMany with
 * `include: { storageObject: { select: { storageProvider, storageKey, size } } }`.
 */
function makeMediaRow(overrides: Record<string, any> = {}) {
  return {
    id: randomUUID(),
    storageObjectId: randomUUID(),
    ownerId: CALLER_ID,
    type: 'photo',
    source: 'web',
    originalFilename: 'photo.jpg',
    capturedAt: new Date('2024-06-15T10:30:00.000Z'),
    capturedAtOffset: -360,
    importedAt: new Date('2024-07-01T12:00:00.000Z'),
    width: 4032,
    height: 3024,
    durationMs: null,
    orientation: 6,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    contentHash: 'abc123',
    takenLat: 9.9281,
    takenLng: -84.0907,
    takenAltitude: 1247.5,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'Alajuela',
    geoAdmin2: 'San Carlos',
    geoLocality: 'La Fortuna',
    geoPlaceName: 'Arenal Volcano',
    geoSource: 'geonames-offline',
    geocodedAt: new Date('2024-06-15T10:35:00.000Z'),
    description: null,
    favorite: false,
    deletedAt: null,
    originalCreatedAt: null,
    sourcePath: null,
    sourceDeviceId: null,
    sourceDeviceName: null,
    metadata: { customKey: 'customValue' },
    createdAt: new Date(),
    updatedAt: new Date(),
    storageObject: {
      storageProvider: 's3',
      storageKey: 'uploads/photo.jpg',
      size: BigInt(2048000),
    },
    ...overrides,
  };
}

/**
 * Create a fake FastifyReply whose `raw` is a real PassThrough stream.
 * `writeHead` is a jest spy.
 *
 * Returns { fakeRes, raw, chunks, finished }:
 *   - fakeRes: pass to streamExport as the `res` argument
 *   - raw:     the underlying PassThrough
 *   - chunks:  array that accumulates every Buffer written to raw
 *   - finished: Promise that resolves when the stream emits 'finish'
 */
function makeFakeReply() {
  const chunks: Buffer[] = [];
  const raw = new PassThrough();

  raw.on('data', (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<string>((resolve, reject) => {
    raw.on('finish', () => resolve(Buffer.concat(chunks).toString('utf8')));
    raw.on('error', reject);
  });

  const writeHead = jest.fn();

  // Expose writeHead on raw itself (that is what the service calls:
  // res.raw.writeHead(...)). Assign it so TypeScript is happy.
  (raw as any).writeHead = writeHead;

  const fakeRes = { raw };

  return { fakeRes, raw, chunks, finished, writeHead };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all output from a JSON export as a string (single-batch). */
async function runJsonExport(
  service: MediaService,
  dto: Record<string, any>,
  userId: string,
  perms: string[],
  fakeRes: any,
): Promise<string> {
  await service.streamExport(dto as any, userId, perms, fakeRes as any);
  // For JSON, service calls res.raw.end() synchronously after writing.
  // The PassThrough drains synchronously in Node.js when there are no back-pressure issues.
  return Buffer.concat(fakeRes.raw.readableBuffer
    ? []  // don't read twice — use chunks array instead
    : []).toString();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('MediaService.streamExport', () => {
  let service: MediaService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: any;
  let mockCircleMembership: { assertCircleAccess: jest.Mock };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();

    // MediaService @Inject(STORAGE_PROVIDER) — provide a no-op stub; streamExport
    // does not use the storage provider, but the constructor requires it.
    mockStorageProvider = {};

    // Default: all callers are circle members (collaborator role)
    mockCircleMembership = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        // MediaService constructor index [2]: syncFromStorageObject is not
        // exercised by export tests — a no-op mock satisfies the dependency.
        { provide: MediaMetadataSyncService, useValue: { syncFromStorageObject: jest.fn() } },
        // MediaService constructor index [3]: CircleMembershipService; export
        // tests don't exercise circle-auth paths so a stub is sufficient.
        { provide: CircleMembershipService, useValue: mockCircleMembership },
        { provide: GEO_LOCATION_PROVIDER, useValue: { reverseGeocode: jest.fn() } },
        { provide: ForwardGeocodeService, useValue: { searchPlaces: jest.fn() } },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Step 7 — JSON export shape
  // -------------------------------------------------------------------------

  describe('JSON export (format: json)', () => {
    const BATCH = Array.from({ length: 3 }, () => makeMediaRow());

    beforeEach(() => {
      // Single batch smaller than BATCH_SIZE=100 → loop exits after one call
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce(BATCH);
    });

    it('should call writeHead with Content-Type: application/json', async () => {
      const { fakeRes, writeHead } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      expect(writeHead).toHaveBeenCalledTimes(1);
      const [_status, headers] = writeHead.mock.calls[0];
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('should call writeHead with Content-Disposition attachment filename ending .json', async () => {
      const { fakeRes, writeHead } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const [_status, headers] = writeHead.mock.calls[0];
      expect(headers['Content-Disposition']).toMatch(/attachment;\s*filename="memoriahub-export-\d{4}-\d{2}-\d{2}\.json"/);
    });

    it('should emit newline-delimited JSON — one line per record', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const lines = body.trim().split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(BATCH.length);
    });

    it('each JSON line should parse without error', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const lines = body.trim().split('\n').filter((l) => l.length > 0);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('each record should contain the documented fields', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const record = JSON.parse(body.trim().split('\n')[0]);

      expect(record).toHaveProperty('id');
      expect(record).toHaveProperty('originalFilename');
      expect(record).toHaveProperty('type');
      expect(record).toHaveProperty('capturedAt');
      expect(record).toHaveProperty('importedAt');
      expect(record).toHaveProperty('source');
      expect(record).toHaveProperty('width');
      expect(record).toHaveProperty('height');
      expect(record).toHaveProperty('durationMs');
      expect(record).toHaveProperty('takenLat');
      expect(record).toHaveProperty('takenLng');
      expect(record).toHaveProperty('cameraMake');
      expect(record).toHaveProperty('cameraModel');
      expect(record).toHaveProperty('contentHash');
      expect(record).toHaveProperty('metadata');
      expect(record).toHaveProperty('storage');
    });

    it('storage.size should be a number (not bigint or bigint string)', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const record = JSON.parse(body.trim().split('\n')[0]);

      expect(typeof record.storage.size).toBe('number');
      expect(record.storage.size).toBe(2048000);
    });

    it('storage fields should be nested under storage.provider / key / size', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const record = JSON.parse(body.trim().split('\n')[0]);

      expect(record.storage).toEqual({
        provider: 's3',
        key: 'uploads/photo.jpg',
        size: 2048000,
      });
    });

    it('metadata field should be present and parseable as an object', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);

      const body = await finished;
      const record = JSON.parse(body.trim().split('\n')[0]);

      // metadata is an object (not a JSON string) in the JSON path
      expect(typeof record.metadata).toBe('object');
      expect(record.metadata).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Step 8 — CSV export
  // -------------------------------------------------------------------------

  describe('CSV export (format: csv)', () => {
    const CSV_COLUMNS = [
      'id', 'originalFilename', 'type', 'capturedAt', 'importedAt',
      'source', 'width', 'height', 'durationMs',
      'takenLat', 'takenLng', 'cameraMake', 'cameraModel', 'contentHash',
      'storage_provider', 'storage_key', 'storage_size', 'metadata',
    ];

    const BATCH = Array.from({ length: 2 }, () => makeMediaRow());

    beforeEach(() => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce(BATCH);
    });

    it('should call writeHead with Content-Type text/csv', async () => {
      const { fakeRes, writeHead, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      expect(writeHead).toHaveBeenCalledTimes(1);
      const [_status, headers] = writeHead.mock.calls[0];
      expect(headers['Content-Type']).toContain('text/csv');
    });

    it('should call writeHead with Content-Disposition attachment filename ending .csv', async () => {
      const { fakeRes, writeHead, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      const [_status, headers] = writeHead.mock.calls[0];
      expect(headers['Content-Disposition']).toMatch(/attachment;\s*filename="memoriahub-export-\d{4}-\d{2}-\d{2}\.csv"/);
    });

    it('should output a header row containing all 18 columns', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const headerLine = body.split('\n')[0];
      for (const col of CSV_COLUMNS) {
        expect(headerLine).toContain(col);
      }
    });

    it('should output at least one data row in addition to the header', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      // Filter non-empty lines; first is header, rest are data
      const lines = body.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2); // header + at least 1 data row
    });

    it('the metadata cell should be a JSON-encoded string that round-trips', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const lines = body.split('\n').filter((l) => l.trim().length > 0);
      // data row: lines[1]
      const dataRow = lines[1];

      // csv-stringify uses RFC 4180 escaping: a field containing double-quotes is
      // wrapped in double-quotes, and each inner double-quote is doubled ("").
      // The metadata JSON object is the last field on the line.
      // Extract the last CSV field (which is the quoted metadata JSON).
      // Strategy: find the last occurrence of a RFC-4180 quoted field at end of line.
      const lastQuotedFieldMatch = dataRow.match(/"((?:[^"]|"")*)"$/);
      expect(lastQuotedFieldMatch).not.toBeNull();

      // Unescape RFC 4180 doubled double-quotes back to single double-quotes
      const unescaped = lastQuotedFieldMatch![1].replace(/""/g, '"');

      // Should be valid JSON
      expect(() => JSON.parse(unescaped)).not.toThrow();
      const parsed = JSON.parse(unescaped);
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
    });

    it('storage_provider, storage_key, storage_size columns should appear in the header', async () => {
      const { fakeRes, finished } = makeFakeReply();

      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const headerLine = body.split('\n')[0];
      expect(headerLine).toContain('storage_provider');
      expect(headerLine).toContain('storage_key');
      expect(headerLine).toContain('storage_size');
    });
  });

  // -------------------------------------------------------------------------
  // Step 9 — Circle-based access enforcement (updated for Family Circles)
  // NOTE: streamExport was refactored from ownerId-based to circleId-based
  //       access control in feat/family-circles. These tests verify the new
  //       circle membership enforcement behavior.
  // -------------------------------------------------------------------------

  const CIRCLE_ID = 'circle-export-test-0000-0001';

  describe('Circle-based access enforcement', () => {
    it('should throw ForbiddenException when assertCircleAccess rejects (non-member)', async () => {
      const { fakeRes, writeHead } = makeFakeReply();

      // Simulate non-member: assertCircleAccess rejects
      mockCircleMembership.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this circle'),
      );

      await expect(
        service.streamExport(
          { format: 'json', circleId: CIRCLE_ID } as any,
          CALLER_ID,
          OWN_PERMS,
          fakeRes as any,
        ),
      ).rejects.toThrow(ForbiddenException);

      // No bytes written before the throw
      expect(writeHead).not.toHaveBeenCalled();
    });

    it('should NOT call prisma.mediaItem.findMany when assertCircleAccess throws', async () => {
      const { fakeRes } = makeFakeReply();

      mockCircleMembership.assertCircleAccess.mockRejectedValueOnce(
        new ForbiddenException('You are not a member of this circle'),
      );

      await expect(
        service.streamExport(
          { format: 'json', circleId: CIRCLE_ID } as any,
          CALLER_ID,
          OWN_PERMS,
          fakeRes as any,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockPrisma.mediaItem.findMany).not.toHaveBeenCalled();
    });

    it('should filter by circleId in the prisma where clause', async () => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);

      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'json', circleId: CIRCLE_ID } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ circleId: CIRCLE_ID }),
        }),
      );
    });

    it('should allow a circle member to export circle media', async () => {
      // Default mock in beforeEach: assertCircleAccess resolves → member
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);

      const { fakeRes, finished } = makeFakeReply();

      await expect(
        service.streamExport(
          { format: 'json', circleId: CIRCLE_ID } as any,
          CALLER_ID,
          OWN_PERMS,
          fakeRes as any,
        ),
      ).resolves.not.toThrow();

      await finished;
    });

    it('should allow super-admin (MEDIA_READ_ANY) to export any circle media', async () => {
      // assertCircleAccess resolves with isSuperAdmin: true for admin with _any permissions
      mockCircleMembership.assertCircleAccess.mockResolvedValueOnce({ role: 'circle_admin', isSuperAdmin: true });
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);

      const { fakeRes, finished } = makeFakeReply();

      await expect(
        service.streamExport(
          { format: 'json', circleId: CIRCLE_ID } as any,
          CALLER_ID,
          ANY_PERMS, // includes MEDIA_READ_ANY
          fakeRes as any,
        ),
      ).resolves.not.toThrow();

      await finished;
    });
  });

  // -------------------------------------------------------------------------
  // Cursor pagination — loops a second batch
  // -------------------------------------------------------------------------

  describe('Cursor-based pagination', () => {
    it('should make two findMany calls when first batch is exactly BATCH_SIZE=100', async () => {
      const firstBatch = Array.from({ length: 100 }, () => makeMediaRow());
      const secondBatch = Array.from({ length: 5 }, () => makeMediaRow());

      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch);

      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      expect(mockPrisma.mediaItem.findMany).toHaveBeenCalledTimes(2);
    });

    it('second findMany call should include cursor pointing at last id of first batch', async () => {
      const firstBatch = Array.from({ length: 100 }, () => makeMediaRow());
      const secondBatch = Array.from({ length: 1 }, () => makeMediaRow());
      const lastId = firstBatch[99].id;

      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch);

      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      const secondCall = (mockPrisma.mediaItem.findMany as jest.Mock).mock.calls[1][0];
      expect(secondCall.cursor).toEqual({ id: lastId });
      expect(secondCall.skip).toBe(1);
    });

    it('should emit 105 JSON lines when batches are 100 + 5', async () => {
      const firstBatch = Array.from({ length: 100 }, () => makeMediaRow());
      const secondBatch = Array.from({ length: 5 }, () => makeMediaRow());

      (mockPrisma.mediaItem.findMany as jest.Mock)
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch);

      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const lines = body.trim().split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(105);
    });
  });

  // -------------------------------------------------------------------------
  // Zero-records edge case
  // -------------------------------------------------------------------------

  describe('Zero-records edge cases', () => {
    beforeEach(() => {
      (mockPrisma.mediaItem.findMany as jest.Mock).mockResolvedValueOnce([]);
    });

    it('JSON: emits no data lines (clean end) when there are zero records', async () => {
      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const lines = body.trim().split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(0);
    });

    it('JSON: writeHead is still called even when there are zero records', async () => {
      const { fakeRes, writeHead, finished } = makeFakeReply();
      await service.streamExport({ format: 'json' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      expect(writeHead).toHaveBeenCalledTimes(1);
    });

    it('CSV: still emits only the header row when there are zero records', async () => {
      const { fakeRes, finished } = makeFakeReply();
      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      const body = await finished;

      const lines = body.split('\n').filter((l) => l.trim().length > 0);
      // Exactly 1 line: the header
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('id');
      expect(lines[0]).toContain('metadata');
    });

    it('CSV: writeHead is called with text/csv even for empty result sets', async () => {
      const { fakeRes, writeHead, finished } = makeFakeReply();
      await service.streamExport({ format: 'csv' } as any, CALLER_ID, OWN_PERMS, fakeRes as any);
      await finished;

      expect(writeHead).toHaveBeenCalledTimes(1);
      const [_status, headers] = writeHead.mock.calls[0];
      expect(headers['Content-Type']).toContain('text/csv');
    });
  });
});
