/**
 * S3 Storage Provider Unit Tests
 *
 * Tests for the S3StorageProvider class including:
 * - AWS S3 endpoint detection logic
 * - S3-compatible service (MinIO) endpoint handling
 * - Object operations (put, get, delete, etc.)
 * - Presigned URL generation
 * - Health check functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// Mock AWS SDK before importing provider
const mockSend = vi.fn();
const mockS3ClientConstructor = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class MockS3Client {
    constructor(config: unknown) {
      mockS3ClientConstructor(config);
    }
    send = mockSend;
  },
  PutObjectCommand: class MockPutObjectCommand {
    constructor(public input: unknown) {}
  },
  GetObjectCommand: class MockGetObjectCommand {
    constructor(public input: unknown) {}
  },
  DeleteObjectCommand: class MockDeleteObjectCommand {
    constructor(public input: unknown) {}
  },
  DeleteObjectsCommand: class MockDeleteObjectsCommand {
    constructor(public input: unknown) {}
  },
  HeadObjectCommand: class MockHeadObjectCommand {
    constructor(public input: unknown) {}
  },
  CopyObjectCommand: class MockCopyObjectCommand {
    constructor(public input: unknown) {}
  },
  ListObjectsV2Command: class MockListObjectsV2Command {
    constructor(public input: unknown) {}
  },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://presigned-url.example.com'),
}));

// Mock logger
vi.mock('../../../../src/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock request context
vi.mock('../../../../src/infrastructure/logging/request-context.js', () => ({
  getTraceId: vi.fn().mockReturnValue('test-trace-id'),
}));

// Storage config mock - we'll update this per test
let mockStorageConfig = {
  endpoint: 'https://s3.amazonaws.com',
  publicEndpoint: undefined as string | undefined,
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key',
  bucket: 'test-bucket',
  region: 'us-east-1',
  forcePathStyle: false,
  presignedUrlExpiration: 3600,
  maxUploadSize: 100 * 1024 * 1024,
};

vi.mock('../../../../src/config/storage.config.js', () => ({
  get storageConfig() {
    return mockStorageConfig;
  },
}));

describe('S3StorageProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to AWS S3 config
    mockStorageConfig = {
      endpoint: 'https://s3.amazonaws.com',
      publicEndpoint: undefined,
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
      bucket: 'test-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
      presignedUrlExpiration: 3600,
      maxUploadSize: 100 * 1024 * 1024,
    };
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('AWS S3 endpoint detection', () => {
    it('detects standard AWS S3 endpoint (s3.amazonaws.com)', async () => {
      mockStorageConfig.endpoint = 'https://s3.amazonaws.com';
      mockS3ClientConstructor.mockClear();

      // Re-import to get fresh instance with new config
      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      new S3StorageProvider();

      // Get the last 2 calls (from our new S3StorageProvider() call)
      // The module export also creates a singleton, so there may be extra calls
      const calls = mockS3ClientConstructor.mock.calls;
      const lastTwoCalls = calls.slice(-2);

      // First call (main client) - should NOT have endpoint for AWS S3
      const mainClientConfig = lastTwoCalls[0][0];
      expect(mainClientConfig.endpoint).toBeUndefined();
      expect(mainClientConfig.region).toBe('us-east-1');
      expect(mainClientConfig.forcePathStyle).toBe(false);

      // Second call (presign client) - should NOT have endpoint for AWS S3
      const presignClientConfig = lastTwoCalls[1][0];
      expect(presignClientConfig.endpoint).toBeUndefined();
    });

    it('detects regional AWS S3 endpoint (s3.us-west-2.amazonaws.com)', async () => {
      mockStorageConfig.endpoint = 'https://s3.us-west-2.amazonaws.com';
      mockStorageConfig.region = 'us-west-2';
      mockS3ClientConstructor.mockClear();

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      new S3StorageProvider();

      // Get the last 2 calls
      const calls = mockS3ClientConstructor.mock.calls;
      const mainClientConfig = calls[calls.length - 2][0];

      // Should NOT set endpoint for regional AWS S3
      expect(mainClientConfig.endpoint).toBeUndefined();
      expect(mainClientConfig.region).toBe('us-west-2');
    });

    it('sets endpoint for MinIO (non-AWS)', async () => {
      mockStorageConfig.endpoint = 'http://minio:9000';
      mockStorageConfig.forcePathStyle = true;
      mockS3ClientConstructor.mockClear();

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      new S3StorageProvider();

      // Get the last 2 calls
      const calls = mockS3ClientConstructor.mock.calls;
      const mainClientConfig = calls[calls.length - 2][0];

      // Should set endpoint for MinIO
      expect(mainClientConfig.endpoint).toBe('http://minio:9000');
      expect(mainClientConfig.forcePathStyle).toBe(true);
    });

    it('sets endpoint for other S3-compatible services', async () => {
      mockStorageConfig.endpoint = 'https://storage.example.com';
      mockS3ClientConstructor.mockClear();

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      new S3StorageProvider();

      // Get the last 2 calls
      const calls = mockS3ClientConstructor.mock.calls;
      const mainClientConfig = calls[calls.length - 2][0];

      // Should set endpoint for non-AWS services
      expect(mainClientConfig.endpoint).toBe('https://storage.example.com');
    });

    it('uses public endpoint for presign client when configured', async () => {
      mockStorageConfig.endpoint = 'http://minio:9000';
      mockStorageConfig.publicEndpoint = 'http://localhost:9000';
      mockStorageConfig.forcePathStyle = true;
      mockS3ClientConstructor.mockClear();

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      new S3StorageProvider();

      // Get the last 2 calls
      const calls = mockS3ClientConstructor.mock.calls;
      const mainClientConfig = calls[calls.length - 2][0];
      const presignClientConfig = calls[calls.length - 1][0];

      // Main client should use internal endpoint
      expect(mainClientConfig.endpoint).toBe('http://minio:9000');

      // Presign client should use public endpoint
      expect(presignClientConfig.endpoint).toBe('http://localhost:9000');
    });
  });

  describe('putObject', () => {
    it('uploads object successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await provider.putObject('test-bucket', 'test-key', Buffer.from('test'), {
        contentType: 'image/jpeg',
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Key: 'test-key',
            ContentType: 'image/jpeg',
          }),
        })
      );
    });

    it('throws error on upload failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('Upload failed'));

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await expect(
        provider.putObject('test-bucket', 'test-key', Buffer.from('test'), {
          contentType: 'image/jpeg',
        })
      ).rejects.toThrow('Upload failed');
    });
  });

  describe('getObject', () => {
    it('retrieves object successfully', async () => {
      const mockReadable = Readable.from(['test content']);
      mockSend.mockResolvedValueOnce({
        Body: mockReadable,
        ContentLength: 12,
        ContentType: 'image/jpeg',
        LastModified: new Date('2024-01-01'),
        Metadata: { custom: 'value' },
        ETag: '"abc123"',
      });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const result = await provider.getObject('test-bucket', 'test-key');

      expect(result.metadata.size).toBe(12);
      expect(result.metadata.contentType).toBe('image/jpeg');
      expect(result.metadata.etag).toBe('"abc123"');
    });

    it('throws error when object not found', async () => {
      mockSend.mockRejectedValueOnce(new Error('NoSuchKey'));

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await expect(provider.getObject('test-bucket', 'test-key')).rejects.toThrow();
    });
  });

  describe('deleteObject', () => {
    it('deletes object successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await provider.deleteObject('test-bucket', 'test-key');

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Key: 'test-key',
          }),
        })
      );
    });
  });

  describe('deleteObjects', () => {
    it('deletes multiple objects in batch', async () => {
      mockSend.mockResolvedValueOnce({});

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await provider.deleteObjects('test-bucket', ['key1', 'key2', 'key3']);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Delete: expect.objectContaining({
              Objects: [{ Key: 'key1' }, { Key: 'key2' }, { Key: 'key3' }],
            }),
          }),
        })
      );
    });

    it('does nothing when keys array is empty', async () => {
      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await provider.deleteObjects('test-bucket', []);

      // send should only be called for constructor operations, not delete
      // Clear constructor calls first
      const callsBeforeDelete = mockSend.mock.calls.length;
      await provider.deleteObjects('test-bucket', []);
      expect(mockSend.mock.calls.length).toBe(callsBeforeDelete);
    });
  });

  describe('headObject', () => {
    it('retrieves object metadata successfully', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 1024,
        ContentType: 'image/png',
        LastModified: new Date('2024-01-01'),
        Metadata: { custom: 'value' },
        ETag: '"def456"',
      });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const result = await provider.headObject('test-bucket', 'test-key');

      expect(result.size).toBe(1024);
      expect(result.contentType).toBe('image/png');
      expect(result.etag).toBe('"def456"');
    });
  });

  describe('objectExists', () => {
    it('returns true when object exists', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 1024,
        ContentType: 'image/png',
      });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const exists = await provider.objectExists('test-bucket', 'test-key');
      expect(exists).toBe(true);
    });

    it('returns false when object does not exist (NotFound)', async () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockSend.mockRejectedValueOnce(notFoundError);

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const exists = await provider.objectExists('test-bucket', 'test-key');
      expect(exists).toBe(false);
    });

    it('returns false when object does not exist (NoSuchKey)', async () => {
      const notFoundError = new Error('NoSuchKey');
      notFoundError.name = 'NoSuchKey';
      mockSend.mockRejectedValueOnce(notFoundError);

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const exists = await provider.objectExists('test-bucket', 'test-key');
      expect(exists).toBe(false);
    });

    it('returns false when object does not exist (404 status)', async () => {
      const notFoundError = new Error('Not Found') as Error & {
        $metadata?: { httpStatusCode?: number };
      };
      notFoundError.$metadata = { httpStatusCode: 404 };
      mockSend.mockRejectedValueOnce(notFoundError);

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const exists = await provider.objectExists('test-bucket', 'test-key');
      expect(exists).toBe(false);
    });

    it('throws error for other errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await expect(provider.objectExists('test-bucket', 'test-key')).rejects.toThrow(
        'Access Denied'
      );
    });
  });

  describe('copyObject', () => {
    it('copies object successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      await provider.copyObject('source-bucket', 'source-key', 'dest-bucket', 'dest-key');

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'dest-bucket',
            Key: 'dest-key',
            CopySource: 'source-bucket/source-key',
          }),
        })
      );
    });
  });

  describe('listObjects', () => {
    it('lists objects successfully', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [
          { Key: 'file1.jpg', Size: 1000, LastModified: new Date(), ETag: '"a"' },
          { Key: 'file2.jpg', Size: 2000, LastModified: new Date(), ETag: '"b"' },
        ],
        CommonPrefixes: [{ Prefix: 'folder/' }],
        IsTruncated: false,
      });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const result = await provider.listObjects('test-bucket', { prefix: 'photos/' });

      expect(result.objects).toHaveLength(2);
      expect(result.objects[0].key).toBe('file1.jpg');
      expect(result.prefixes).toContain('folder/');
      expect(result.isTruncated).toBe(false);
    });

    it('handles pagination with continuation token', async () => {
      mockSend.mockResolvedValueOnce({
        Contents: [{ Key: 'file1.jpg', Size: 1000, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: 'next-token',
      });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const result = await provider.listObjects('test-bucket');

      expect(result.isTruncated).toBe(true);
      expect(result.nextContinuationToken).toBe('next-token');
    });
  });

  describe('getPresignedUploadUrl', () => {
    it('generates presigned upload URL', async () => {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const url = await provider.getPresignedUploadUrl('test-bucket', 'test-key', {
        contentType: 'image/jpeg',
        expiresIn: 7200,
      });

      expect(url).toBe('https://presigned-url.example.com');
      expect(getSignedUrl).toHaveBeenCalled();
    });
  });

  describe('getPresignedDownloadUrl', () => {
    it('generates presigned download URL', async () => {
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const url = await provider.getPresignedDownloadUrl('test-bucket', 'test-key', {
        contentDisposition: 'attachment; filename="photo.jpg"',
      });

      expect(url).toBe('https://presigned-url.example.com');
      expect(getSignedUrl).toHaveBeenCalled();
    });
  });

  describe('healthCheck', () => {
    it('returns true when bucket is accessible', async () => {
      mockSend.mockResolvedValueOnce({ Contents: [] });

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const healthy = await provider.healthCheck();
      expect(healthy).toBe(true);
    });

    it('returns false when bucket is not accessible', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));

      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      const healthy = await provider.healthCheck();
      expect(healthy).toBe(false);
    });
  });

  describe('provider name', () => {
    it('returns correct provider name', async () => {
      const { S3StorageProvider } = await import(
        '../../../../src/infrastructure/storage/s3.provider.js'
      );
      const provider = new S3StorageProvider();

      expect(provider.providerName).toBe('s3');
    });
  });
});
