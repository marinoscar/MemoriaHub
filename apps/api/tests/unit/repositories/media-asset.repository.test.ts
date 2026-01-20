/**
 * Media Asset Repository Tests
 *
 * Unit tests for the media asset repository.
 * Tests media asset CRUD, queries, and access control.
 *
 * Key regression test: findAllAccessible must work with all sort options.
 * This was broken when SELECT DISTINCT was used without including the sort
 * expression in the SELECT list (PostgreSQL requires ORDER BY expressions
 * to appear in SELECT list when using DISTINCT).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaAssetStatus, MediaType, FileSource } from '@memoriahub/shared';

// Mock the database client
const mockQuery = vi.fn();
vi.mock('../../../src/infrastructure/database/client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock logger
vi.mock('../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock request context
vi.mock('../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: () => 'trace-123',
}));

// Mock storage provider
vi.mock('../../../src/infrastructure/storage/storage.factory.js', () => ({
  getDefaultStorageProvider: () => ({
    getPresignedUrl: vi.fn().mockResolvedValue('https://example.com/presigned'),
  }),
}));

import { MediaAssetRepository } from '../../../src/infrastructure/database/repositories/media-asset.repository.js';

describe('MediaAssetRepository', () => {
  let repository: MediaAssetRepository;

  /**
   * Creates a mock database row for a media asset
   */
  function createMockAssetRow(overrides?: Partial<{
    id: string;
    owner_id: string;
    storage_key: string;
    storage_bucket: string;
    thumbnail_key: string | null;
    preview_key: string | null;
    original_filename: string;
    media_type: MediaType;
    mime_type: string;
    file_size: string;
    file_source: FileSource;
    width: number | null;
    height: number | null;
    duration_seconds: string | null;
    camera_make: string | null;
    camera_model: string | null;
    latitude: string | null;
    longitude: string | null;
    country: string | null;
    state: string | null;
    city: string | null;
    location_name: string | null;
    captured_at_utc: Date | null;
    timezone_offset: number | null;
    exif_data: Record<string, unknown>;
    faces: unknown[];
    tags: unknown[];
    status: MediaAssetStatus;
    error_message: string | null;
    trace_id: string | null;
    created_at: Date;
    updated_at: Date;
    sort_key?: unknown;
  }>) {
    return {
      id: 'asset-123',
      owner_id: 'user-456',
      storage_key: 'originals/asset-123.jpg',
      storage_bucket: 'test-bucket',
      thumbnail_key: null,
      preview_key: null,
      original_filename: 'test-image.jpg',
      media_type: 'image' as MediaType,
      mime_type: 'image/jpeg',
      file_size: '1024',
      file_source: 'web' as FileSource,
      width: 1920,
      height: 1080,
      duration_seconds: null,
      camera_make: 'Apple',
      camera_model: 'iPhone 15',
      latitude: null,
      longitude: null,
      country: null,
      state: null,
      city: null,
      location_name: null,
      captured_at_utc: new Date('2024-01-15T12:00:00Z'),
      timezone_offset: 0,
      exif_data: {},
      faces: [],
      tags: [],
      status: 'READY' as MediaAssetStatus,
      error_message: null,
      trace_id: 'trace-abc',
      created_at: new Date('2024-01-01T00:00:00Z'),
      updated_at: new Date('2024-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new MediaAssetRepository();
  });

  describe('findById', () => {
    it('returns media asset when found', async () => {
      const mockRow = createMockAssetRow();
      mockQuery.mockResolvedValue({ rows: [mockRow] });

      const result = await repository.findById('asset-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM media_assets WHERE id = $1'),
        ['asset-123']
      );
      expect(result).toEqual(expect.objectContaining({
        id: 'asset-123',
        ownerId: 'user-456',
        originalFilename: 'test-image.jpg',
        status: 'READY',
      }));
    });

    it('returns null when not found', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByOwnerId', () => {
    it('returns assets owned by user with pagination', async () => {
      const mockRow = createMockAssetRow();
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findByOwnerId({
        ownerId: 'user-456',
        page: 1,
        limit: 20,
      });

      expect(result.assets).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.assets[0].ownerId).toBe('user-456');
    });

    it('filters by media type', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findByOwnerId({ ownerId: 'user-456', mediaType: 'video' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('media_type = $2'),
        expect.arrayContaining(['user-456', 'video'])
      );
    });

    it('filters by status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findByOwnerId({ ownerId: 'user-456', status: 'READY' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('status = $2'),
        expect.arrayContaining(['user-456', 'READY'])
      );
    });
  });

  /**
   * REGRESSION TEST: findAllAccessible with different sort options
   *
   * This test ensures that the findAllAccessible method works correctly
   * with all supported sort options. Previously, the query failed with:
   * "for SELECT DISTINCT, ORDER BY expressions must appear in select list"
   *
   * The fix includes the sort expression as 'sort_key' in the SELECT clause.
   */
  describe('findAllAccessible', () => {
    it('returns accessible assets with default sort (capturedAt)', async () => {
      const mockRow = createMockAssetRow({ sort_key: new Date('2024-01-15T12:00:00Z') });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        sortBy: 'capturedAt',
        sortOrder: 'desc',
      });

      // Verify the query includes sort_key in SELECT for DISTINCT compatibility
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('sort_key'),
        expect.any(Array)
      );

      // Verify ORDER BY uses sort_key
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ORDER BY sort_key DESC'),
        expect.any(Array)
      );

      expect(result.assets).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('handles sortBy=createdAt without SQL error', async () => {
      const mockRow = createMockAssetRow({ sort_key: new Date('2024-01-01T00:00:00Z') });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      // Verify the query uses sort_key alias (fix for DISTINCT + ORDER BY)
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('as sort_key'),
        expect.any(Array)
      );

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ORDER BY sort_key ASC'),
        expect.any(Array)
      );

      expect(result.assets).toHaveLength(1);
    });

    it('handles sortBy=filename without SQL error', async () => {
      const mockRow = createMockAssetRow({ sort_key: 'test-image.jpg' });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        sortBy: 'filename',
        sortOrder: 'asc',
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ORDER BY sort_key ASC'),
        expect.any(Array)
      );

      expect(result.assets).toHaveLength(1);
    });

    it('handles sortBy=fileSize without SQL error', async () => {
      const mockRow = createMockAssetRow({ sort_key: '1024' });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      const result = await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        sortBy: 'fileSize',
        sortOrder: 'desc',
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ORDER BY sort_key DESC'),
        expect.any(Array)
      );

      expect(result.assets).toHaveLength(1);
    });

    it('uses COALESCE for capturedAt sort to handle null values', async () => {
      const mockRow = createMockAssetRow({ sort_key: new Date('2024-01-15T12:00:00Z') });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        sortBy: 'capturedAt',
        sortOrder: 'desc',
      });

      // Verify the SELECT includes COALESCE expression as sort_key
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('COALESCE(ma.captured_at_utc, ma.created_at) as sort_key'),
        expect.any(Array)
      );
    });

    it('includes SELECT DISTINCT for deduplication', async () => {
      const mockRow = createMockAssetRow({ sort_key: new Date('2024-01-15T12:00:00Z') });
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '1' }] })
        .mockResolvedValueOnce({ rows: [mockRow] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
      });

      // Verify DISTINCT is used (this is what caused the original bug)
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('SELECT DISTINCT ma.*'),
        expect.any(Array)
      );
    });

    it('filters by mediaType', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        mediaType: 'image',
      });

      // The second call (data query) should contain the filter
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ma.media_type = $2'),
        expect.any(Array)
      );
    });

    it('filters by status', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        status: 'READY',
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ma.status = $2'),
        expect.any(Array)
      );
    });

    it('filters by date range', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-12-31');

      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        startDate,
        endDate,
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ma.captured_at_utc >='),
        expect.any(Array)
      );
    });

    it('filters by location (country, state)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        country: 'USA',
        state: 'California',
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ma.country = $'),
        expect.any(Array)
      );
    });

    it('filters by camera make and model', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
        cameraMake: 'Apple',
        cameraModel: 'iPhone 15',
      });

      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('ma.camera_make = $'),
        expect.any(Array)
      );
    });

    it('applies pagination correctly', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({
        userId: 'user-456',
        page: 3,
        limit: 24,
      });

      // Page 3 with limit 24 = offset 48
      // The query should contain LIMIT and OFFSET
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('LIMIT $'),
        expect.arrayContaining([24, 48])
      );
    });

    it('queries accessible media from multiple sources', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repository.findAllAccessible({ userId: 'user-456', page: 1, limit: 24 });

      // Verify the query checks all access paths
      const queryCall = mockQuery.mock.calls[1][0];
      expect(queryCall).toContain('ma.owner_id = $1'); // Owned by user
      expect(queryCall).toContain('ms.shared_with_user_id IS NOT NULL'); // Directly shared
      expect(queryCall).toContain('l.owner_id = $1'); // Owner of library
      expect(queryCall).toContain('lm.user_id IS NOT NULL'); // Member of library
      expect(queryCall).toContain("l.visibility = 'public'"); // Public library
    });

    it('returns empty result when no accessible assets', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repository.findAllAccessible({
        userId: 'user-456',
        page: 1,
        limit: 24,
      });

      expect(result.assets).toEqual([]);
      expect(result.total).toBe(0);
    });
  });
});
