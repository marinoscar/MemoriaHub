import { Readable } from 'stream';
import {
  StorageProvider,
  StorageUploadResult,
  MultipartUploadInit,
  UploadPart,
  SignedUrlOptions,
  StorageUploadOptions,
} from '@marinoscar/platform-api/storage';

/**
 * Creates a mock storage provider for testing
 * All methods return sensible defaults that can be overridden in tests
 */
/** The platform provider plus the two optional extras some MemoriaHub paths use when present. */
export type MockStorageProvider = jest.Mocked<StorageProvider> & {
  deleteMany: jest.Mock;
  getObjectSize: jest.Mock;
};

export const createMockStorageProvider = (): MockStorageProvider => ({
  kind: 's3',
  // Behaves like S3/R2: presigned part URLs a client PUTs to directly.
  partUploadMode: 'presigned',

  upload: jest.fn().mockResolvedValue({
    key: 'test-key',
    bucket: 'test-bucket',
    location: 's3://test-bucket/test-key',
    eTag: '"mock-etag"',
  } as StorageUploadResult),

  initMultipartUpload: jest.fn().mockResolvedValue({
    uploadId: 'mock-upload-id',
    key: 'test-key',
  } as MultipartUploadInit),

  getSignedUploadUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/upload'),

  completeMultipartUpload: jest.fn().mockResolvedValue({
    key: 'test-key',
    bucket: 'test-bucket',
    location: 's3://test-bucket/test-key',
    eTag: '"mock-etag"',
  } as StorageUploadResult),

  abortMultipartUpload: jest.fn().mockResolvedValue(undefined),

  download: jest.fn().mockResolvedValue(Readable.from(['mock content'])),

  getSignedDownloadUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/download'),

  delete: jest.fn().mockResolvedValue(undefined),

  deleteMany: jest.fn().mockResolvedValue({ deleted: 0, errors: [] }),

  getMetadata: jest
    .fn()
    .mockResolvedValue({ 'x-custom': 'value' } as Record<string, string>),

  setMetadata: jest.fn().mockResolvedValue(undefined),

  exists: jest.fn().mockResolvedValue(true),

  getBucket: jest.fn().mockReturnValue('test-bucket'),

  getSignedPutUrl: jest
    .fn()
    .mockResolvedValue('https://mock-presigned-url.com/put'),

  getObjectSize: jest.fn().mockResolvedValue(1024),
});
