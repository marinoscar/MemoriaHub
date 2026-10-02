import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Readable } from 'stream';

import { ObjectsService } from './objects.service';
import { PrismaService } from '../../prisma/prisma.service';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import { StorageProviderResolver } from '../providers/storage-provider.resolver';
import { createMockPrismaService, MockPrismaService } from '../../../test/mocks/prisma.mock';
import { createMockStorageProvider } from '../../../test/mocks/storage-provider.mock';
import { OBJECT_UPLOADED_EVENT } from '../processing/events/object-uploaded.event';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { MultipartPartsMissingError } from '../providers/storage-provider.types';

describe('ObjectsService', () => {
  let service: ObjectsService;
  let mockPrisma: MockPrismaService;
  let mockStorageProvider: ReturnType<typeof createMockStorageProvider>;
  let mockConfig: jest.Mocked<ConfigService>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;
  let mockCircleMembershipService: { assertCircleAccess: jest.Mock };
  let mockStorageProviderResolver: { getActiveProvider: jest.Mock; getProviderFor: jest.Mock; invalidate: jest.Mock };

  const testUserId = 'user-123';
  const otherUserId = 'user-456';

  const mockStorageObject = {
    id: 'obj-123',
    name: 'test-file.pdf',
    size: BigInt(1024000),
    mimeType: 'application/pdf',
    storageKey: 'uploads/123456/uuid-123.pdf',
    storageProvider: 's3',
    bucket: 'test-bucket',
    status: 'ready',
    s3UploadId: null,
    uploadedById: testUserId,
    metadata: null,
    mediaItem: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    mockPrisma = createMockPrismaService();
    mockStorageProvider = createMockStorageProvider();
    mockConfig = {
      get: jest.fn(),
    } as any;
    mockEventEmitter = {
      emit: jest.fn(),
    } as any;
    mockCircleMembershipService = {
      assertCircleAccess: jest.fn().mockResolvedValue({ role: 'collaborator', isSuperAdmin: false }),
    };
    mockStorageProviderResolver = {
      getActiveProvider: jest.fn().mockResolvedValue({ id: 's3', provider: mockStorageProvider }),
      getProviderFor: jest.fn().mockResolvedValue(mockStorageProvider),
      invalidate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObjectsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: STORAGE_PROVIDER, useValue: mockStorageProvider },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: CircleMembershipService, useValue: mockCircleMembershipService },
        { provide: StorageProviderResolver, useValue: mockStorageProviderResolver },
      ],
    }).compile();

    service = module.get<ObjectsService>(ObjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initUpload', () => {
    it('should create object record and return presigned URLs', async () => {
      const dto = {
        name: 'test.pdf',
        size: 52428800, // 50MB
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'uploads/123/uuid.pdf',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        name: dto.name,
        size: BigInt(dto.size),
        status: 'pending',
        s3UploadId: 'upload-123',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.objectId).toBe('new-obj-id');
      expect(result.uploadId).toBe('upload-123');
      expect(result.partSize).toBe(10485760);
      expect(result.totalParts).toBe(5); // 50MB / 10MB
      expect(result.presignedUrls).toHaveLength(5); // First batch up to 10
      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalled();
      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: dto.name,
            size: BigInt(dto.size),
            mimeType: dto.mimeType,
            status: 'pending',
            s3UploadId: 'upload-123',
            uploadedById: testUserId,
          }),
        }),
      );
    });

    it('should calculate correct part count for large files', async () => {
      const dto = {
        name: 'large.zip',
        size: 104857600, // 100MB
        mimeType: 'application/zip',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-456',
        key: 'uploads/456/uuid.zip',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
      } as any);

      const result = await service.initUpload(dto, testUserId);

      expect(result.totalParts).toBe(10); // 100MB / 10MB
      expect(result.presignedUrls).toHaveLength(10); // First batch of 10
    });

    it('should generate unique storage key with timestamp and UUID', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760);
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-789',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockPrisma.storageObject.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageKey: expect.stringMatching(/^uploads\/\d+\/[a-f0-9-]+\.pdf$/),
          }),
        }),
      );
    });

    it('should throw BadRequestException for files exceeding 10,000 parts', async () => {
      const dto = {
        name: 'huge.dat',
        size: 524288000000, // 500GB
        mimeType: 'application/octet-stream',
      };

      mockConfig.get.mockReturnValue(10485760); // 10MB part size
      // 500GB / 10MB = 50,000 parts > 10,000 limit

      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.initUpload(dto, testUserId)).rejects.toThrow(
        'File too large for multipart upload',
      );
    });

    it('should call storage provider initMultipartUpload', async () => {
      const dto = {
        name: 'test.pdf',
        size: 10485760,
        mimeType: 'application/pdf',
      };

      mockConfig.get.mockReturnValue(10485760);
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'test-key',
      });
      mockStorageProvider.getBucket.mockReturnValue('test-bucket');
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
      } as any);

      await service.initUpload(dto, testUserId);

      expect(mockStorageProvider.initMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^uploads\//),
        expect.objectContaining({
          mimeType: dto.mimeType,
        }),
      );
    });
  });

  describe('getUploadStatus', () => {
    it('should return upload status with chunk info', async () => {
      const chunks = [
        { partNumber: 1, size: BigInt(10485760), eTag: 'etag1' },
        { partNumber: 2, size: BigInt(10485760), eTag: 'etag2' },
        { partNumber: 3, size: BigInt(5242880), eTag: 'etag3' },
      ];

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        size: BigInt(26214400), // ~25MB - matches totalBytes expectation
        chunks,
      } as any);
      mockConfig.get.mockReturnValue(10485760); // 10MB part size

      const result = await service.getUploadStatus(mockStorageObject.id, testUserId);

      expect(result.objectId).toBe(mockStorageObject.id);
      expect(result.status).toBe('pending');
      expect(result.uploadedParts).toEqual([1, 2, 3]);
      expect(result.totalParts).toBe(3);
      expect(result.uploadedBytes).toBe('26214400');
      expect(result.totalBytes).toBe('26214400'); // Updated to match mock size
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getUploadStatus('non-existent', testUserId),
      ).rejects.toThrow('Upload not found');
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        chunks: [],
      } as any);

      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.getUploadStatus(mockStorageObject.id, testUserId),
      ).rejects.toThrow('You do not own this upload');
    });
  });

  describe('completeUpload', () => {
    it('should complete multipart upload and update status', async () => {
      const dto = {
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: mockStorageObject.storageKey,
        bucket: 'test-bucket',
        location: 's3://test-bucket/key',
        eTag: 'final-etag',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.completeUpload(
        mockStorageObject.id,
        dto,
        testUserId,
      );

      expect(result.status).toBe('processing');
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
        dto.parts,
      );
      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: { status: 'processing' },
      });
    });

    it('should emit ObjectUploadedEvent', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      const updatedObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue(updatedObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: updatedObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockStorageProvider.completeMultipartUpload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.completeUpload(mockStorageObject.id, dto, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
          meta: expect.objectContaining({
            partsCount: 1,
          }),
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.completeUpload('non-existent', dto, testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw BadRequestException when uploadId is missing', async () => {
      const dto = {
        parts: [{ partNumber: 1, eTag: 'etag1' }],
      };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: null,
        chunks: [],
      } as any);

      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.completeUpload(mockStorageObject.id, dto, testUserId),
      ).rejects.toThrow('Upload ID not found');
    });

    // Issue #183: a multipart session the provider has dropped is a CLIENT-STATE
    // error. Letting the raw SDK error escape reported it as a 500, which both
    // misrepresents the condition and denies the client a status it can key
    // recovery off (it must re-init the upload).
    describe('stale multipart session', () => {
      function arrangeCompleteFailure(error: unknown): { parts: Array<{ partNumber: number; eTag: string }> } {
        const dto = { parts: [{ partNumber: 1, eTag: 'etag1' }] };
        mockPrisma.storageObject.findUnique.mockResolvedValue({
          ...mockStorageObject,
          status: 'pending',
          s3UploadId: 'upload-123',
          chunks: [],
        } as any);
        mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
        mockStorageProvider.completeMultipartUpload.mockRejectedValue(error as never);
        return dto;
      }

      it('maps NoSuchUpload to 409 Conflict', async () => {
        const err = Object.assign(new Error('The specified multipart upload does not exist.'), {
          name: 'NoSuchUpload',
        });
        const dto = arrangeCompleteFailure(err);

        await expect(
          service.completeUpload(mockStorageObject.id, dto, testUserId),
        ).rejects.toThrow(ConflictException);
      });

      it('carries details.reason UPLOAD_SESSION_INVALID (issue #506)', async () => {
        const err = Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
        const dto = arrangeCompleteFailure(err);

        const thrown = await service
          .completeUpload(mockStorageObject.id, dto, testUserId)
          .catch((e: unknown) => e);

        expect((thrown as ConflictException).getResponse()).toMatchObject({
          details: { reason: 'UPLOAD_SESSION_INVALID' },
        });
      });

      it('maps InvalidPart to 409 Conflict', async () => {
        const err = Object.assign(
          new Error('One or more of the specified parts could not be found.'),
          { name: 'InvalidPart' },
        );
        const dto = arrangeCompleteFailure(err);

        await expect(
          service.completeUpload(mockStorageObject.id, dto, testUserId),
        ).rejects.toThrow(ConflictException);
      });

      it('recognizes the condition from the message when the SDK omits the code', async () => {
        // R2's error shapes are not always identical to AWS's, so the message
        // fallback must carry the classification on its own.
        const dto = arrangeCompleteFailure(
          new Error('The specified multipart upload does not exist.'),
        );

        await expect(
          service.completeUpload(mockStorageObject.id, dto, testUserId),
        ).rejects.toThrow(ConflictException);
      });

      it('leaves an unrelated provider failure untouched', async () => {
        const err = Object.assign(new Error('We encountered an internal error.'), {
          name: 'InternalError',
        });
        const dto = arrangeCompleteFailure(err);

        // Must NOT be converted to a 409 — a genuine provider fault is a 5xx and
        // is legitimately retryable by the client.
        await expect(
          service.completeUpload(mockStorageObject.id, dto, testUserId),
        ).rejects.toThrow('We encountered an internal error.');
        await expect(
          service.completeUpload(mockStorageObject.id, dto, testUserId),
        ).rejects.not.toThrow(ConflictException);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Part URLs and API-proxied parts (issue #506)
  // -------------------------------------------------------------------------
  describe('part URLs by provider capability (issue #506)', () => {
    const configFor = (key: string, def?: unknown) => {
      if (key === 'storage.partSize') return 10485760;
      if (key === 'appUrl') return 'https://photos.example.test';
      return def;
    };

    beforeEach(() => {
      mockConfig.get.mockImplementation(configFor as any);
      mockStorageProvider.initMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'k',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-obj-id',
        status: 'pending',
        s3UploadId: 'upload-123',
      } as any);
    });

    it('S3/R2 (presigned parts): init returns provider URLs unchanged and partUploadAuth "none"', async () => {
      mockStorageProvider.getSignedUploadUrl.mockImplementation(
        async (_k: string, _u: string, n: number) => `https://bucket.s3.example/part?n=${n}&sig=x`,
      );

      const result = await service.initUpload(
        { name: 'a.mp4', size: 25 * 1024 * 1024, mimeType: 'video/mp4' },
        testUserId,
      );

      expect(result.partUploadAuth).toBe('none');
      expect(result.presignedUrls).toEqual([1, 2, 3].map((n) => ({
        partNumber: n,
        url: `https://bucket.s3.example/part?n=${n}&sig=x`,
      })));
      expect(mockStorageProvider.getSignedUploadUrl).toHaveBeenCalledTimes(3);
    });

    it('S3/R2: part-urls returns provider URLs and partUploadAuth "none"', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'pending',
        s3UploadId: 'upload-123',
      } as any);

      const result = await service.getPartUrls(mockStorageObject.id, { partNumbers: [11] }, testUserId);

      expect(result).toEqual({
        partUploadAuth: 'none',
        presignedUrls: [{ partNumber: 11, url: 'https://mock-presigned-url.com/upload' }],
      });
    });

    it('local (no presigned parts): init returns API part URLs and partUploadAuth "bearer"', async () => {
      (mockStorageProvider as any).supportsPresignedParts = false;

      const result = await service.initUpload(
        { name: 'a.mp4', size: 25 * 1024 * 1024, mimeType: 'video/mp4' },
        testUserId,
      );

      expect(result.partUploadAuth).toBe('bearer');
      expect(result.presignedUrls).toEqual([1, 2, 3].map((n) => ({
        partNumber: n,
        url: `https://photos.example.test/api/storage/objects/new-obj-id/upload/parts/${n}`,
      })));
      expect(mockStorageProvider.getSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('local: part-urls returns API part URLs and partUploadAuth "bearer"', async () => {
      (mockStorageProvider as any).supportsPresignedParts = false;
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'uploading',
        s3UploadId: 'upload-123',
      } as any);

      const result = await service.getPartUrls(mockStorageObject.id, { partNumbers: [2] }, testUserId);

      expect(result).toEqual({
        partUploadAuth: 'bearer',
        presignedUrls: [{
          partNumber: 2,
          url: `https://photos.example.test/api/storage/objects/${mockStorageObject.id}/upload/parts/2`,
        }],
      });
    });
  });

  describe('uploadPart (issue #506)', () => {
    const size = 25 * 1024 * 1024; // 10 MiB + 10 MiB + 5 MiB
    const uploading = {
      ...mockStorageObject,
      size: BigInt(size),
      status: 'pending',
      s3UploadId: 'upload-123',
    };

    beforeEach(() => {
      mockConfig.get.mockImplementation(((key: string, def?: unknown) =>
        key === 'storage.partSize' ? 10485760 : def) as any);
      (mockStorageProvider as any).supportsPresignedParts = false;
      (mockStorageProvider as any).writePart = jest.fn().mockResolvedValue({
        partNumber: 3,
        eTag: '"abc"',
        size: 5 * 1024 * 1024,
      });
      mockPrisma.storageObject.findUnique.mockResolvedValue(uploading as any);
      mockPrisma.storageObjectChunk.upsert.mockResolvedValue({} as any);
      mockPrisma.storageObject.updateMany.mockResolvedValue({ count: 1 } as any);
    });

    const body = () => Readable.from([Buffer.from('x')]);
    const reasonOf = async (p: Promise<unknown>) =>
      ((await p.catch((e: any) => e)) as any).getResponse().details;

    it('streams the part with the exact expected size and records the chunk', async () => {
      const stream = body();

      const result = await service.uploadPart(mockStorageObject.id, 3, testUserId, stream);

      expect(result.eTag).toBe('"abc"');
      expect((mockStorageProvider as any).writePart).toHaveBeenCalledWith('upload-123', 3, stream, {
        expectedSize: 5 * 1024 * 1024,
      });
      expect(mockPrisma.storageObjectChunk.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ partNumber: 3, eTag: '"abc"', size: BigInt(5 * 1024 * 1024) }),
        }),
      );
      expect(mockPrisma.storageObject.updateMany).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id, status: 'pending' },
        data: { status: 'uploading' },
      });
    });

    it('rejects a declared Content-Length that differs, before reading the body', async () => {
      const details = await reasonOf(
        service.uploadPart(mockStorageObject.id, 1, testUserId, body(), 123),
      );

      expect(details).toMatchObject({ reason: 'PART_SIZE_MISMATCH', expectedSize: 10485760, receivedSize: 123 });
      expect((mockStorageProvider as any).writePart).not.toHaveBeenCalled();
    });

    it('rejects a part number out of range', async () => {
      const details = await reasonOf(service.uploadPart(mockStorageObject.id, 4, testUserId, body()));

      expect(details).toEqual({ reason: 'PART_OUT_OF_RANGE', totalParts: 3 });
    });

    it.each(['processing', 'ready', 'failed'])('rejects an object in status %s', async (status) => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({ ...uploading, status } as any);

      const details = await reasonOf(service.uploadPart(mockStorageObject.id, 1, testUserId, body()));

      expect(details).toEqual({ reason: 'UPLOAD_NOT_ACTIVE', status });
    });

    it('accepts an object already uploading, without re-flipping its status', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({ ...uploading, status: 'uploading' } as any);

      await service.uploadPart(mockStorageObject.id, 3, testUserId, body());

      expect(mockPrisma.storageObject.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a provider that takes presigned parts', async () => {
      (mockStorageProvider as any).supportsPresignedParts = true;

      const details = await reasonOf(service.uploadPart(mockStorageObject.id, 1, testUserId, body()));

      expect(details).toEqual({ reason: 'PRESIGNED_PARTS_REQUIRED' });
    });

    it('403 for a non-owner, 404 for an unknown object', async () => {
      await expect(
        service.uploadPart(mockStorageObject.id, 1, otherUserId, body()),
      ).rejects.toThrow(ForbiddenException);

      mockPrisma.storageObject.findUnique.mockResolvedValue(null);
      await expect(
        service.uploadPart(mockStorageObject.id, 1, testUserId, body()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('completeUpload on a provider without presigned parts (issue #506)', () => {
    const size = 25 * 1024 * 1024;
    const parts = [1, 2, 3].map((n) => ({ partNumber: n, eTag: `"e${n}"` }));

    beforeEach(() => {
      mockConfig.get.mockImplementation(((key: string, def?: unknown) =>
        key === 'storage.partSize' ? 10485760 : def) as any);
      (mockStorageProvider as any).supportsPresignedParts = false;
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        size: BigInt(size),
        status: 'uploading',
        s3UploadId: 'upload-123',
        chunks: [],
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({ ...mockStorageObject, status: 'processing' } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);
    });

    it('does not overwrite the chunk rows recorded as parts arrived', async () => {
      await service.completeUpload(mockStorageObject.id, { parts }, testUserId);

      expect(mockPrisma.storageObjectChunk.upsert).not.toHaveBeenCalled();
      expect(mockStorageProvider.completeMultipartUpload).toHaveBeenCalled();
    });

    it('409 UPLOAD_PARTS_MISSING when the list does not cover every part', async () => {
      const thrown = await service
        .completeUpload(mockStorageObject.id, { parts: [parts[0], parts[2]] }, testUserId)
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'UPLOAD_PARTS_MISSING', partNumbers: [2] },
      });
      expect(mockStorageProvider.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('409 UPLOAD_PARTS_MISSING from the provider, and forgets those chunk rows', async () => {
      mockStorageProvider.completeMultipartUpload.mockRejectedValue(
        new MultipartPartsMissingError([3, 1]) as never,
      );
      mockPrisma.storageObjectChunk.deleteMany.mockResolvedValue({ count: 2 } as any);

      const thrown = await service
        .completeUpload(mockStorageObject.id, { parts }, testUserId)
        .catch((e: unknown) => e);

      expect((thrown as ConflictException).getResponse()).toMatchObject({
        details: { reason: 'UPLOAD_PARTS_MISSING', partNumbers: [1, 3] },
      });
      expect(mockPrisma.storageObjectChunk.deleteMany).toHaveBeenCalledWith({
        where: { objectId: mockStorageObject.id, partNumber: { in: [3, 1] } },
      });
      expect(mockPrisma.storageObject.update).not.toHaveBeenCalled();
    });

    it('400 PART_OUT_OF_RANGE for a listed part beyond totalParts', async () => {
      const thrown = await service
        .completeUpload(mockStorageObject.id, { parts: [...parts, { partNumber: 4, eTag: '"x"' }] }, testUserId)
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getResponse()).toMatchObject({
        details: { reason: 'PART_OUT_OF_RANGE', partNumbers: [4] },
      });
    });
  });

  describe('abortUpload', () => {
    it('should abort upload and delete records', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should call storage provider abortMultipartUpload', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockStorageProvider.abortMultipartUpload).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        'upload-123',
      );
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        s3UploadId: 'upload-123',
      } as any);
      mockStorageProvider.abortMultipartUpload.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.abortUpload(mockStorageObject.id, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:abort',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.abortUpload('non-existent', testUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
        s3UploadId: 'upload-123',
      } as any);

      await expect(
        service.abortUpload(mockStorageObject.id, testUserId),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('simpleUpload', () => {
    it('should upload file and create record', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'uploads/123/uuid.txt',
        bucket: 'test-bucket',
        location: 's3://test-bucket/uploads/123/uuid.txt',
        eTag: 'etag123',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        name: file.filename,
        mimeType: file.mimetype,
        status: 'processing',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.simpleUpload(file, testUserId);

      expect(result.name).toBe(file.filename);
      expect(result.mimeType).toBe(file.mimetype);
      expect(result.status).toBe('processing');
      expect(mockStorageProvider.upload).toHaveBeenCalled();
    });

    it('should emit ObjectUploadedEvent', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      const createdObject = {
        ...mockStorageObject,
        status: 'processing',
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue(createdObject as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        OBJECT_UPLOADED_EVENT,
        expect.objectContaining({
          object: createdObject,
        }),
      );
    });

    it('should create audit event', async () => {
      const file = {
        filename: 'test.txt',
        mimetype: 'text/plain',
        file: Readable.from(['test content']),
      };

      mockStorageProvider.upload.mockResolvedValue({
        key: 'key',
        bucket: 'bucket',
        location: 's3://bucket/key',
      });
      mockPrisma.storageObject.create.mockResolvedValue({
        ...mockStorageObject,
        id: 'new-id',
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.simpleUpload(file, testUserId);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:upload:complete',
          targetType: 'storage_object',
          targetId: 'new-id',
          meta: expect.objectContaining({
            uploadType: 'simple',
          }),
        }),
      });
    });
  });

  describe('list', () => {
    it('should return paginated results', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      const mockObjects = [
        { ...mockStorageObject, id: 'obj-1' },
        { ...mockStorageObject, id: 'obj-2' },
      ];

      mockPrisma.storageObject.findMany.mockResolvedValue(mockObjects as any);
      mockPrisma.storageObject.count.mockResolvedValue(2);

      const result = await service.list(query, testUserId);

      expect(result.items).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.pageSize).toBe(20);
      expect(result.meta.totalItems).toBe(2);
      expect(result.meta.totalPages).toBe(1);
    });

    it('should filter by status', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        status: 'ready' as const,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([mockStorageObject] as any);
      mockPrisma.storageObject.count.mockResolvedValue(1);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ready',
          }),
        }),
      );
    });

    it('should sort by specified field', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'name' as const,
        sortOrder: 'asc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { name: 'asc' },
        }),
      );
    });

    it('should exclude derived objects (thumbnails/ and video-faces/ prefixes) from findMany', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            NOT: expect.arrayContaining([
              { storageKey: { startsWith: 'thumbnails/' } },
              { storageKey: { startsWith: 'video-faces/' } },
            ]),
          }),
        }),
      );
    });

    it('should exclude derived objects (thumbnails/ and video-faces/ prefixes) from count', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            NOT: expect.arrayContaining([
              { storageKey: { startsWith: 'thumbnails/' } },
              { storageKey: { startsWith: 'video-faces/' } },
            ]),
          }),
        }),
      );
    });

    it('should apply derived-object exclusion alongside uploadedById and status filters', async () => {
      const query = {
        page: 1,
        pageSize: 20,
        status: 'ready' as const,
        sortBy: 'createdAt' as const,
        sortOrder: 'desc' as const,
      };

      mockPrisma.storageObject.findMany.mockResolvedValue([]);
      mockPrisma.storageObject.count.mockResolvedValue(0);

      await service.list(query, testUserId);

      expect(mockPrisma.storageObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            uploadedById: testUserId,
            status: 'ready',
            NOT: expect.arrayContaining([
              { storageKey: { startsWith: 'thumbnails/' } },
              { storageKey: { startsWith: 'video-faces/' } },
            ]),
          }),
        }),
      );
    });
  });

  describe('getById', () => {
    it('should return object metadata', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);

      const result = await service.getById(mockStorageObject.id, testUserId, []);

      expect(result.id).toBe(mockStorageObject.id);
      expect(result.name).toBe(mockStorageObject.name);
    });

    it('should throw NotFoundException for non-existent object', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(service.getById('non-existent', testUserId, [])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException for non-owner', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        uploadedById: otherUserId,
      } as any);

      await expect(
        service.getById(mockStorageObject.id, testUserId, []),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getDownloadUrl', () => {
    it('should return signed URL for ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'ready',
      } as any);
      mockConfig.get.mockReturnValue(3600);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/download',
      );

      const result = await service.getDownloadUrl(mockStorageObject.id, testUserId, undefined, []);

      expect(result.url).toBe('https://signed-url.com/download');
      expect(result.expiresIn).toBe(3600);
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        { expiresIn: 3600 },
      );
    });

    it('should throw BadRequestException for non-ready objects', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        status: 'processing',
      } as any);

      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId, undefined, []),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.getDownloadUrl(mockStorageObject.id, testUserId, undefined, []),
      ).rejects.toThrow('Object is not ready for download');
    });
  });

  describe('getInternalDownloadUrl', () => {
    it('presigns a still-processing object without the ready gate or an auth check', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        storageKey: mockStorageObject.storageKey,
        storageProvider: mockStorageObject.storageProvider,
        bucket: mockStorageObject.bucket,
        status: 'processing',
      } as any);
      mockConfig.get.mockReturnValue(3600);
      mockStorageProvider.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-url.com/internal',
      );

      const url = await service.getInternalDownloadUrl(mockStorageObject.id);

      expect(url).toBe('https://signed-url.com/internal');
      expect(mockStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
        { expiresIn: 3600 },
      );
    });

    it('returns null when the object row is missing', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(null);

      await expect(
        service.getInternalDownloadUrl('missing-object'),
      ).resolves.toBeNull();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('returns null when the object has no storageKey', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue({
        storageKey: '',
        storageProvider: mockStorageObject.storageProvider,
        bucket: mockStorageObject.bucket,
      } as any);

      await expect(
        service.getInternalDownloadUrl(mockStorageObject.id),
      ).resolves.toBeNull();
      expect(mockStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete from storage and database', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId, []);

      expect(mockStorageProvider.delete).toHaveBeenCalledWith(
        mockStorageObject.storageKey,
      );
      expect(mockPrisma.storageObject.delete).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
      });
    });

    it('should create audit event', async () => {
      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockStorageProvider.delete.mockResolvedValue(undefined);
      mockPrisma.storageObject.delete.mockResolvedValue({} as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.delete(mockStorageObject.id, testUserId, []);

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:delete',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });

  describe('updateMetadata', () => {
    it('should merge metadata and update record', async () => {
      const existingMetadata = { key1: 'value1' };
      const newMetadata = { key2: 'value2' };

      mockPrisma.storageObject.findUnique.mockResolvedValue({
        ...mockStorageObject,
        metadata: existingMetadata,
      } as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: { ...existingMetadata, ...newMetadata },
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      const result = await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
        [],
      );

      expect(mockPrisma.storageObject.update).toHaveBeenCalledWith({
        where: { id: mockStorageObject.id },
        data: {
          metadata: { ...existingMetadata, ...newMetadata },
        },
      });
    });

    it('should create audit event', async () => {
      const newMetadata = { key: 'value' };

      mockPrisma.storageObject.findUnique.mockResolvedValue(mockStorageObject as any);
      mockPrisma.storageObject.update.mockResolvedValue({
        ...mockStorageObject,
        metadata: newMetadata,
      } as any);
      mockPrisma.auditEvent.create.mockResolvedValue({} as any);

      await service.updateMetadata(
        mockStorageObject.id,
        { metadata: newMetadata },
        testUserId,
        [],
      );

      expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorUserId: testUserId,
          action: 'storage:object:metadata:update',
          targetType: 'storage_object',
          targetId: mockStorageObject.id,
        }),
      });
    });
  });
});
