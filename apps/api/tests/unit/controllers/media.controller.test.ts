/**
 * Media Controller Tests
 *
 * Tests for media HTTP endpoints including proxy upload.
 * Authentication is handled at the route level, not in the controller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { MediaController } from '../../../src/api/controllers/media.controller.js';
import type { MediaAssetDTO, PresignedUploadResponse } from '@memoriahub/shared';

// Mock upload service
const mockInitiateUpload = vi.fn();
const mockProxyUpload = vi.fn();
const mockCompleteUpload = vi.fn();
const mockListAssetsInLibrary = vi.fn();
const mockGetAsset = vi.fn();
const mockDeleteAsset = vi.fn();

vi.mock('../../../src/services/upload/upload.service.js', () => ({
  uploadService: {
    initiateUpload: (...args: unknown[]) => mockInitiateUpload(...args),
    proxyUpload: (...args: unknown[]) => mockProxyUpload(...args),
    completeUpload: (...args: unknown[]) => mockCompleteUpload(...args),
    listAssetsInLibrary: (...args: unknown[]) => mockListAssetsInLibrary(...args),
    getAsset: (...args: unknown[]) => mockGetAsset(...args),
    deleteAsset: (...args: unknown[]) => mockDeleteAsset(...args),
  },
}));

describe('MediaController', () => {
  let controller: MediaController;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  const mockAssetDTO: MediaAssetDTO = {
    id: 'asset-123',
    ownerId: 'user-123',
    originalFilename: 'test-image.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 1024,
    fileSource: 'web',
    width: 1920,
    height: 1080,
    durationSeconds: null,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15',
    latitude: null,
    longitude: null,
    country: null,
    state: null,
    city: null,
    locationName: null,
    capturedAtUtc: '2024-01-01T12:00:00.000Z',
    timezoneOffset: 0,
    thumbnailUrl: null,
    previewUrl: null,
    originalUrl: 'https://example.com/original.jpg',
    exifData: {},
    status: 'METADATA_EXTRACTED',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    controller = new MediaController();

    mockReq = {
      params: {},
      body: {},
      query: {},
      user: { id: 'user-123', email: 'test@example.com' },
      file: undefined,
    };

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();
  });

  describe('proxyUpload', () => {
    it('uploads file through proxy successfully', async () => {
      const mockFile = {
        buffer: Buffer.from('test file content'),
        originalname: 'test-image.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      };

      mockReq.file = mockFile as Express.Multer.File;
      mockReq.body = { libraryId: 'library-456' };

      mockProxyUpload.mockResolvedValue(mockAssetDTO);

      await controller.proxyUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockProxyUpload).toHaveBeenCalledWith('user-123', 'library-456', {
        buffer: mockFile.buffer,
        originalname: 'test-image.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      });
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockAssetDTO });
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockAssetDTO });
    });

    it('returns 400 when no file is provided', async () => {
      mockReq.file = undefined;
      mockReq.body = { libraryId: 'library-456' };

      await controller.proxyUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: { code: 'MISSING_FILE', message: 'No file provided' },
      });
      expect(mockProxyUpload).not.toHaveBeenCalled();
    });

    it('uploads file successfully without libraryId (user-owned media)', async () => {
      const mockFile = {
        buffer: Buffer.from('test'),
        originalname: 'test.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      };

      mockReq.file = mockFile as Express.Multer.File;
      mockReq.body = {};

      mockProxyUpload.mockResolvedValue(mockAssetDTO);

      await controller.proxyUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockProxyUpload).toHaveBeenCalledWith('user-123', null, {
        buffer: mockFile.buffer,
        originalname: 'test.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      });
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockAssetDTO });
    });

    it('passes errors to next middleware', async () => {
      const mockFile = {
        buffer: Buffer.from('test'),
        originalname: 'test.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      };

      mockReq.file = mockFile as Express.Multer.File;
      mockReq.body = { libraryId: 'library-456' };

      const error = new Error('Upload failed');
      mockProxyUpload.mockRejectedValue(error);

      await controller.proxyUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('initiateUpload', () => {
    it('initiates upload and returns presigned URL', async () => {
      mockReq.body = {
        libraryId: 'library-456',
        filename: 'test.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024,
      };

      const mockResponse: PresignedUploadResponse = {
        assetId: 'asset-123',
        uploadUrl: 'https://s3.example.com/presigned-url',
        storageKey: 'libraries/library-456/originals/asset-123.jpg',
        expiresAt: '2024-01-01T01:00:00.000Z',
      };

      mockInitiateUpload.mockResolvedValue(mockResponse);

      await controller.initiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockInitiateUpload).toHaveBeenCalledWith('user-123', mockReq.body, 'web');
      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockResponse });
    });

    it('passes errors to next middleware', async () => {
      mockReq.body = { libraryId: 'library-456' };

      const error = new Error('Initiate failed');
      mockInitiateUpload.mockRejectedValue(error);

      await controller.initiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('completeUpload', () => {
    it('completes upload successfully', async () => {
      mockReq.body = { assetId: 'asset-123' };

      mockCompleteUpload.mockResolvedValue(mockAssetDTO);

      await controller.completeUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockCompleteUpload).toHaveBeenCalledWith('user-123', 'asset-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockAssetDTO });
    });

    it('passes errors to next middleware', async () => {
      mockReq.body = { assetId: 'asset-123' };

      const error = new Error('Complete failed');
      mockCompleteUpload.mockRejectedValue(error);

      await controller.completeUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('listMediaInLibrary', () => {
    it('lists media assets in library', async () => {
      mockReq.params = { libraryId: 'library-456' };
      mockReq.query = { page: '1', limit: '20' };

      const mockResult = {
        assets: [mockAssetDTO],
        total: 1,
        page: 1,
        limit: 20,
      };

      mockListAssetsInLibrary.mockResolvedValue(mockResult);

      await controller.listMediaInLibrary(mockReq as Request, mockRes as Response, mockNext);

      expect(mockListAssetsInLibrary).toHaveBeenCalledWith('user-123', 'library-456', {
        page: 1,
        limit: 20,
        status: undefined,
        mediaType: undefined,
        country: undefined,
        state: undefined,
        city: undefined,
        cameraMake: undefined,
        cameraModel: undefined,
        startDate: undefined,
        endDate: undefined,
        sortBy: undefined,
        sortOrder: undefined,
      });
      expect(mockRes.json).toHaveBeenCalledWith({
        data: [mockAssetDTO],
        meta: { page: 1, limit: 20, total: 1 },
      });
    });

    it('passes filter parameters correctly', async () => {
      mockReq.params = { libraryId: 'library-456' };
      mockReq.query = {
        mediaType: 'image',
        country: 'USA',
        cameraMake: 'Apple',
        sortBy: 'capturedAt',
        sortOrder: 'desc',
      };

      mockListAssetsInLibrary.mockResolvedValue({ assets: [], total: 0, page: 1, limit: 50 });

      await controller.listMediaInLibrary(mockReq as Request, mockRes as Response, mockNext);

      expect(mockListAssetsInLibrary).toHaveBeenCalledWith('user-123', 'library-456', expect.objectContaining({
        mediaType: 'image',
        country: 'USA',
        cameraMake: 'Apple',
        sortBy: 'capturedAt',
        sortOrder: 'desc',
      }));
    });
  });

  describe('getMedia', () => {
    it('returns single media asset', async () => {
      mockReq.params = { id: 'asset-123' };

      mockGetAsset.mockResolvedValue(mockAssetDTO);

      await controller.getMedia(mockReq as Request, mockRes as Response, mockNext);

      expect(mockGetAsset).toHaveBeenCalledWith('user-123', 'asset-123');
      expect(mockRes.json).toHaveBeenCalledWith({ data: mockAssetDTO });
    });

    it('passes errors to next middleware', async () => {
      mockReq.params = { id: 'asset-123' };

      const error = new Error('Not found');
      mockGetAsset.mockRejectedValue(error);

      await controller.getMedia(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('deleteMedia', () => {
    it('deletes media asset successfully', async () => {
      mockReq.params = { id: 'asset-123' };

      mockDeleteAsset.mockResolvedValue(undefined);

      await controller.deleteMedia(mockReq as Request, mockRes as Response, mockNext);

      expect(mockDeleteAsset).toHaveBeenCalledWith('user-123', 'asset-123');
      expect(mockRes.status).toHaveBeenCalledWith(204);
      expect(mockRes.send).toHaveBeenCalled();
    });

    it('passes errors to next middleware', async () => {
      mockReq.params = { id: 'asset-123' };

      const error = new Error('Delete failed');
      mockDeleteAsset.mockRejectedValue(error);

      await controller.deleteMedia(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
