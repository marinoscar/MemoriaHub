/**
 * Media Validator Tests
 *
 * Tests for media validation middleware.
 * Ensures proper validation of path params and query params for media endpoints.
 *
 * IMPORTANT: This test suite was created to prevent regression of a bug where
 * the listMediaQuerySchema incorrectly required `libraryId` in query params,
 * but the endpoint uses `/library/:libraryId` path param instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  validateInitiateUpload,
  validateCompleteUpload,
  validateListMediaQuery,
} from '../../../src/api/validators/media.validator.js';

describe('Media Validators', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockReq = {
      params: {},
      query: {},
      body: {},
    };
    mockRes = {};
    mockNext = vi.fn();
  });

  describe('validateInitiateUpload', () => {
    it('passes for valid upload input', () => {
      mockReq.body = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024000,
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for missing libraryId', () => {
      mockReq.body = {
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024000,
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      }));
    });

    it('calls next with error for invalid UUID libraryId', () => {
      mockReq.body = {
        libraryId: 'not-a-uuid',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 1024000,
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for unsupported mime type', () => {
      mockReq.body = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
        filename: 'document.pdf',
        mimeType: 'application/pdf',
        fileSize: 1024000,
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for missing filename', () => {
      mockReq.body = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
        mimeType: 'image/jpeg',
        fileSize: 1024000,
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for file too large', () => {
      mockReq.body = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        fileSize: 200 * 1024 * 1024, // 200MB, exceeds 100MB limit
      };

      validateInitiateUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });

  describe('validateCompleteUpload', () => {
    it('passes for valid assetId', () => {
      mockReq.body = {
        assetId: '123e4567-e89b-12d3-a456-426614174000',
      };

      validateCompleteUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for missing assetId', () => {
      mockReq.body = {};

      validateCompleteUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      }));
    });

    it('calls next with error for invalid UUID assetId', () => {
      mockReq.body = {
        assetId: 'not-a-uuid',
      };

      validateCompleteUpload(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });
  });

  describe('validateListMediaQuery', () => {
    /**
     * REGRESSION TEST: This test ensures that libraryId comes from path params,
     * not query params. Previously, the schema incorrectly required libraryId
     * in query params which caused 400 errors when accessing /api/media/library/:libraryId
     */
    it('passes when libraryId is in path params and query params are valid', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        page: '1',
        limit: '24',
        status: 'READY',
        sortBy: 'capturedAt',
        sortOrder: 'desc',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    /**
     * REGRESSION TEST: Validates that the endpoint works correctly without
     * libraryId in query params - it should only be in path params
     */
    it('passes when libraryId is only in path params (not in query)', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {}; // Empty query - this should be valid

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error when libraryId is missing from path params', () => {
      mockReq.params = {}; // No libraryId in path
      mockReq.query = {
        page: '1',
        limit: '24',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      }));
    });

    it('calls next with error when libraryId in path is invalid UUID', () => {
      mockReq.params = {
        libraryId: 'not-a-valid-uuid',
      };
      mockReq.query = {};

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('passes with valid optional query params', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        page: '2',
        limit: '50',
        status: 'READY',
        mediaType: 'image',
        sortBy: 'createdAt',
        sortOrder: 'asc',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('passes with video mediaType filter', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        mediaType: 'video',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith();
    });

    it('calls next with error for invalid mediaType', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        mediaType: 'audio', // Invalid - only 'image' or 'video' allowed
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for invalid status', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        status: 'INVALID_STATUS',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for invalid sortBy', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        sortBy: 'invalidField',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for invalid sortOrder', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        sortOrder: 'random',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for page less than 1', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        page: '0',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('calls next with error for limit greater than 100', () => {
      mockReq.params = {
        libraryId: '123e4567-e89b-12d3-a456-426614174000',
      };
      mockReq.query = {
        limit: '101',
      };

      validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 400,
      }));
    });

    it('passes with all valid sortBy options', () => {
      const validSortByOptions = ['capturedAt', 'createdAt', 'filename', 'fileSize'];

      for (const sortBy of validSortByOptions) {
        mockReq.params = {
          libraryId: '123e4567-e89b-12d3-a456-426614174000',
        };
        mockReq.query = { sortBy };
        mockNext = vi.fn();

        validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      }
    });

    it('passes with all valid status options', () => {
      const validStatuses = [
        'UPLOADED',
        'METADATA_EXTRACTED',
        'DERIVATIVES_READY',
        'ENRICHED',
        'INDEXED',
        'READY',
        'ERROR',
      ];

      for (const status of validStatuses) {
        mockReq.params = {
          libraryId: '123e4567-e89b-12d3-a456-426614174000',
        };
        mockReq.query = { status };
        mockNext = vi.fn();

        validateListMediaQuery(mockReq as Request, mockRes as Response, mockNext);

        expect(mockNext).toHaveBeenCalledWith();
      }
    });
  });
});
