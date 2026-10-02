import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Inject } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { extname } from 'path';

import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { CircleRole } from '@prisma/client';
import { CircleMembershipService } from '../../circles/circle-membership.service';
import { STORAGE_PROVIDER } from '../providers/storage-provider.interface';
import type { StorageProvider } from '../providers/storage-provider.interface';
import { StorageProviderResolver } from '../providers/storage-provider.resolver';
import {
  InitUploadDto,
  InitUploadResponseDto,
  PartUploadAuth,
} from './dto/init-upload.dto';
import {
  UploadPartResponseDto,
  UPLOAD_ERROR_REASONS,
} from './dto/upload-part.dto';
import {
  MultipartPartsMissingError,
  MultipartSessionNotFoundError,
  PartSizeMismatchError,
} from '../providers/storage-provider.types';
import {
  CompleteUploadDto,
} from './dto/complete-upload.dto';
import {
  ObjectResponseDto,
  UploadStatusResponseDto,
} from './dto/object-response.dto';
import {
  ObjectListQueryDto,
  ObjectListResponseDto,
} from './dto/object-list-query.dto';
import {
  UpdateMetadataDto,
} from './dto/update-metadata.dto';
import {
  DownloadUrlResponseDto,
} from './dto/download-url-response.dto';
import {
  GetPartUrlsDto,
  GetPartUrlsResponseDto,
} from './dto/get-part-urls.dto';
import {
  OBJECT_UPLOADED_EVENT,
  ObjectUploadedEvent,
} from '../processing/events/object-uploaded.event';

export interface MultipartFile {
  filename: string;
  mimetype: string;
  file: Readable;
}

// Derived/internal storage objects that should not appear in user-facing browse lists.
// These are auto-generated blobs, not user-uploaded files.
const DERIVED_KEY_PREFIXES = ['thumbnails/', 'video-faces/'];

/**
 * S3/R2 error codes meaning the client's multipart session is unusable:
 *  - NoSuchUpload — the upload id is gone (provider GC'd an abandoned upload)
 *  - InvalidPart / InvalidPartOrder — the submitted ETags don't belong to it
 *
 * Matched on `name` (AWS SDK v3 surfaces the code there) with a message
 * fallback, since R2's error shapes are not always identical to AWS's.
 */
const STALE_MULTIPART_ERROR_NAMES = new Set([
  'NoSuchUpload',
  'InvalidPart',
  'InvalidPartOrder',
]);

/** Statuses in which an object still accepts multipart parts. */
const IN_PROGRESS_STATUSES = new Set(['pending', 'uploading']);

const STALE_MULTIPART_MESSAGE_RE =
  /multipart upload does not exist|parts could not be found|NoSuchUpload|InvalidPart/i;

/** True when a provider error means the client must re-init the upload. */
function isStaleMultipartSessionError(error: unknown): boolean {
  if (error instanceof MultipartSessionNotFoundError) return true;
  if (error == null || typeof error !== 'object') return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && STALE_MULTIPART_ERROR_NAMES.has(name)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && STALE_MULTIPART_MESSAGE_RE.test(message);
}

@Injectable()
export class ObjectsService {
  private readonly logger = new Logger(ObjectsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER)
    private readonly storageProvider: StorageProvider,
    private readonly config: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly circleMembershipService: CircleMembershipService,
    private readonly resolver: StorageProviderResolver,
  ) {}

  /**
   * Initialize a resumable multipart upload
   */
  async initUpload(
    dto: InitUploadDto,
    userId: string,
  ): Promise<InitUploadResponseDto> {
    const { name, size, mimeType } = dto;

    // Get configuration
    const partSize = this.config.get<number>('storage.partSize', 10485760); // 10MB default
    const minPartSize = 5 * 1024 * 1024; // 5MB S3 minimum

    // Validate part size
    if (partSize < minPartSize) {
      throw new BadRequestException(
        `Part size must be at least ${minPartSize} bytes`,
      );
    }

    // Calculate total parts
    const totalParts = Math.ceil(size / partSize);

    if (totalParts > 10000) {
      throw new BadRequestException(
        'File too large for multipart upload (exceeds 10,000 parts)',
      );
    }

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(name);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(`Initializing upload for ${name}, ${totalParts} parts`);

    // Resolve the active storage provider dynamically from system settings so
    // the id and bucket are persisted on the row rather than being hardcoded.
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();

    // Initialize multipart upload with storage provider
    const { uploadId } = await activeProvider.initMultipartUpload(
      storageKey,
      { mimeType },
    );

    // Create StorageObject record — persist the active provider id + bucket so
    // per-object resolution works correctly for all subsequent operations.
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name,
        size: BigInt(size),
        mimeType,
        storageKey,
        storageProvider: activeProviderId,
        bucket: activeProvider.getBucket(),
        status: 'pending',
        s3UploadId: uploadId,
        uploadedById: userId,
      },
    });

    // Part URLs for the first batch (up to 10 parts) — presigned provider URLs,
    // or this API's own part route when the provider has none (issue #506).
    const urlBatchSize = Math.min(10, totalParts);
    const { presignedUrls, partUploadAuth } = await this.buildPartUrls(
      activeProvider,
      storageObject.id,
      storageKey,
      uploadId,
      Array.from({ length: urlBatchSize }, (_, i) => i + 1),
    );

    this.logger.log(
      `Upload initialized: ${storageObject.id}, uploadId: ${uploadId}`,
    );

    return {
      objectId: storageObject.id,
      uploadId,
      partSize,
      totalParts,
      presignedUrls,
      partUploadAuth,
    };
  }

  /**
   * Part URLs a client can actually PUT to, plus how to authenticate them.
   *
   * A provider with real presigned part URLs (S3/R2) is unchanged: its URLs
   * are returned verbatim with `partUploadAuth: 'none'`. A provider without
   * them (`supportsPresignedParts === false`, i.e. local disk) would otherwise
   * hand the client `internal://` placeholders no device can reach, so the
   * client is given this API's own absolute part route instead, with
   * `partUploadAuth: 'bearer'` (issue #506).
   */
  private async buildPartUrls(
    provider: StorageProvider,
    objectId: string,
    storageKey: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{
    presignedUrls: Array<{ partNumber: number; url: string }>;
    partUploadAuth: PartUploadAuth;
  }> {
    if (provider.supportsPresignedParts === false) {
      const appUrl = this.config
        .get<string>('appUrl', 'http://localhost:3535')
        .replace(/\/+$/, '');
      return {
        presignedUrls: partNumbers.map((partNumber) => ({
          partNumber,
          url: `${appUrl}/api/storage/objects/${objectId}/upload/parts/${partNumber}`,
        })),
        partUploadAuth: 'bearer',
      };
    }

    const presignedUrls = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await provider.getSignedUploadUrl(storageKey, uploadId, partNumber),
      })),
    );
    return { presignedUrls, partUploadAuth: 'none' };
  }

  /**
   * The size every part of `objectSize` must have under the configured part
   * size, and how many parts there are. Mirrors the arithmetic `initUpload`
   * and `getUploadStatus` already use.
   */
  private partLayout(objectSize: number): {
    partSize: number;
    totalParts: number;
    sizeOf: (partNumber: number) => number;
  } {
    const partSize = this.config.get<number>('storage.partSize', 10485760);
    const totalParts = Math.max(1, Math.ceil(objectSize / partSize));
    return {
      partSize,
      totalParts,
      sizeOf: (partNumber) =>
        partNumber < totalParts ? partSize : objectSize - partSize * (totalParts - 1),
    };
  }

  /**
   * Receive one part of a multipart upload through the API (issue #506).
   *
   * Only for providers whose part URLs a client cannot reach directly (local
   * disk); `initUpload` / `getPartUrls` point clients here for those. The body
   * is streamed straight to the provider — never buffered — and the part is
   * recorded in `storage_object_chunks` so `GET :id/upload/status` reports it
   * in `uploadedParts`, which is what drives a client's resume.
   *
   * @param declaredLength the request's Content-Length, when it sent one; a
   *   wrong value is rejected before a single byte is read
   */
  async uploadPart(
    objectId: string,
    partNumber: number,
    userId: string,
    body: Readable,
    declaredLength?: number,
  ): Promise<UploadPartResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Ownership check mirrors getUploadStatus / getPartUrls.
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId || !IN_PROGRESS_STATUSES.has(storageObject.status)) {
      throw new BadRequestException({
        message: `Upload is not in progress (status: ${storageObject.status})`,
        details: { reason: UPLOAD_ERROR_REASONS.UPLOAD_NOT_ACTIVE, status: storageObject.status },
      });
    }

    const provider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );

    if (provider.supportsPresignedParts !== false || !provider.writePart) {
      throw new BadRequestException({
        message:
          'This upload takes its parts at the presigned URLs returned by upload/init ' +
          'and upload/part-urls, not through the API.',
        details: { reason: UPLOAD_ERROR_REASONS.PRESIGNED_PARTS_REQUIRED },
      });
    }

    const { partSize, totalParts, sizeOf } = this.partLayout(Number(storageObject.size));

    if (partNumber < 1 || partNumber > totalParts) {
      throw new BadRequestException({
        message: `Part number must be between 1 and ${totalParts}`,
        details: { reason: UPLOAD_ERROR_REASONS.PART_OUT_OF_RANGE, totalParts },
      });
    }

    const expectedSize = sizeOf(partNumber);
    const sizeMismatch = (receivedSize: number | null) =>
      new BadRequestException({
        message: `Part ${partNumber} must be exactly ${expectedSize} bytes`,
        details: {
          reason: UPLOAD_ERROR_REASONS.PART_SIZE_MISMATCH,
          partNumber,
          expectedSize,
          receivedSize,
          partSize,
        },
      });

    if (declaredLength !== undefined && declaredLength !== expectedSize) {
      throw sizeMismatch(declaredLength);
    }

    let written;
    try {
      written = await provider.writePart(storageObject.s3UploadId, partNumber, body, {
        expectedSize,
      });
    } catch (error) {
      if (error instanceof PartSizeMismatchError) {
        throw sizeMismatch(error.exceeded ? null : error.receivedSize);
      }
      if (error instanceof MultipartSessionNotFoundError) {
        throw this.sessionInvalid(objectId);
      }
      throw error;
    }

    await this.prisma.storageObjectChunk.upsert({
      where: { objectId_partNumber: { objectId, partNumber } },
      create: {
        objectId,
        partNumber,
        eTag: written.eTag,
        size: BigInt(written.size),
      },
      update: { eTag: written.eTag, size: BigInt(written.size) },
    });

    // First part in: the object is now actively uploading. Conditional so a
    // concurrent complete (status → processing) is never rolled back.
    if (storageObject.status === 'pending') {
      await this.prisma.storageObject.updateMany({
        where: { id: objectId, status: 'pending' },
        data: { status: 'uploading' },
      });
    }

    return written;
  }

  /**
   * Get upload status and progress
   */
  async getUploadStatus(
    objectId: string,
    userId: string,
  ): Promise<UploadStatusResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { chunks: true },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    const uploadedParts = storageObject.chunks
      .map((chunk) => chunk.partNumber)
      .sort((a, b) => a - b);

    const uploadedBytes = storageObject.chunks.reduce(
      (sum, chunk) => sum + chunk.size,
      BigInt(0),
    );

    const partSize = this.config.get<number>('storage.partSize', 10485760);
    const totalParts = Math.ceil(Number(storageObject.size) / partSize);

    return {
      objectId: storageObject.id,
      status: storageObject.status,
      uploadedParts,
      totalParts,
      uploadedBytes: uploadedBytes.toString(),
      totalBytes: storageObject.size.toString(),
    };
  }

  /**
   * Mint presigned upload URLs for arbitrary part numbers.
   *
   * This resolves the >10-part limit imposed by initUpload (which only returns
   * the first ≤10 URLs). The CLI uses this for files requiring more than 10
   * parts (>100 MB at the default 10 MB part size), enabling 500 MB+ uploads
   * without a server-side size cap.
   *
   * The web client can use the same endpoint in the future to lift its own
   * informal 100 MB limit.
   */
  async getPartUrls(
    objectId: string,
    dto: GetPartUrlsDto,
    userId: string,
  ): Promise<GetPartUrlsResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Ownership check mirrors getUploadStatus
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('No active multipart upload for this object');
    }

    // Re-resolve from the object row so an active-provider switch mid-upload
    // cannot misroute part-URL requests to the wrong provider.
    const partProvider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );

    const { presignedUrls, partUploadAuth } = await this.buildPartUrls(
      partProvider,
      objectId,
      storageObject.storageKey,
      storageObject.s3UploadId,
      dto.partNumbers,
    );

    this.logger.log(
      `Minted ${presignedUrls.length} part URL(s) for object ${objectId}`,
    );

    return { presignedUrls, partUploadAuth };
  }

  /**
   * Complete multipart upload
   */
  async completeUpload(
    objectId: string,
    dto: CompleteUploadDto,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      include: { chunks: true },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    const { parts } = dto;

    this.logger.log(`Completing upload ${objectId} with ${parts.length} parts`);

    // Re-resolve from the object row so an active-provider switch between
    // initUpload and completeUpload cannot misroute to the wrong provider.
    const completeProvider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );

    // Parts that went through the API (local disk, issue #506) were recorded
    // with their real size and eTag as they arrived. For those the part list
    // must also cover EVERY part of the object: concatenating 1 and 3 without 2
    // is a corrupt file, not a smaller one.
    const apiProxiedParts = completeProvider.supportsPresignedParts === false;

    if (apiProxiedParts) {
      const { totalParts } = this.partLayout(Number(storageObject.size));
      const listed = new Set(parts.map((part) => part.partNumber));
      const outOfRange = [...listed].filter((n) => n > totalParts);
      if (outOfRange.length > 0) {
        throw new BadRequestException({
          message: `Part numbers must be between 1 and ${totalParts}`,
          details: {
            reason: UPLOAD_ERROR_REASONS.PART_OUT_OF_RANGE,
            totalParts,
            partNumbers: outOfRange.sort((a, b) => a - b),
          },
        });
      }
      const unlisted = Array.from({ length: totalParts }, (_, i) => i + 1).filter(
        (n) => !listed.has(n),
      );
      if (unlisted.length > 0) {
        throw this.partsMissing(objectId, unlisted);
      }
    } else {
      // Record chunks in database. S3/R2 parts never pass through the API, so
      // this is the first time the server learns about them.
      await Promise.all(
        parts.map((part) =>
          this.prisma.storageObjectChunk.upsert({
            where: {
              objectId_partNumber: {
                objectId,
                partNumber: part.partNumber,
              },
            },
            create: {
              objectId,
              partNumber: part.partNumber,
              eTag: part.eTag,
              size: BigInt(0), // We don't know exact part size from client
            },
            update: {
              eTag: part.eTag,
            },
          }),
        ),
      );
    }

    // Complete upload with storage provider.
    //
    // A dead client-held session (the provider garbage-collected an abandoned
    // multipart upload, or the client's persisted ETags belong to one) is a
    // CLIENT-STATE error, not a server fault. Letting the raw SDK error escape
    // made Nest report it as a 500, which both misrepresents the condition and
    // leaves the client no status to key recovery off — it must instead restart
    // the upload from a fresh init (issue #183).
    try {
      await completeProvider.completeMultipartUpload(
        storageObject.storageKey,
        storageObject.s3UploadId,
        parts,
      );
    } catch (error) {
      if (error instanceof MultipartPartsMissingError) {
        // Forget the bad parts so GET :id/upload/status stops reporting them
        // as uploaded — a client resuming from status then re-sends exactly
        // these, rather than skipping them forever.
        await this.prisma.storageObjectChunk.deleteMany({
          where: { objectId, partNumber: { in: error.partNumbers } },
        });
        throw this.partsMissing(objectId, error.partNumbers);
      }
      if (isStaleMultipartSessionError(error)) {
        throw this.sessionInvalid(objectId);
      }
      throw error;
    }

    // Update status to processing
    const updated = await this.prisma.storageObject.update({
      where: { id: objectId },
      data: { status: 'processing' },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(updated),
    );

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:complete', objectId, {
      name: updated.name,
      size: updated.size.toString(),
      mimeType: updated.mimeType,
      partsCount: parts.length,
    });

    this.logger.log(`Upload completed: ${objectId}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * 409 `UPLOAD_PARTS_MISSING`: the client re-sends exactly `partNumbers`
   * (fresh URLs from `upload/part-urls`) and calls `complete` again. The
   * session stays open, so the parts it already sent are kept.
   */
  private partsMissing(objectId: string, partNumbers: number[]): ConflictException {
    const sorted = [...partNumbers].sort((a, b) => a - b);
    this.logger.warn(
      `Refusing to complete upload ${objectId}: missing or corrupt part(s) ${sorted.join(', ')}`,
    );
    return new ConflictException({
      message:
        'Some parts of this upload are missing or do not match their eTag. ' +
        'Re-send the listed parts, then complete the upload again.',
      details: { reason: UPLOAD_ERROR_REASONS.UPLOAD_PARTS_MISSING, partNumbers: sorted },
    });
  }

  /**
   * 409 `UPLOAD_SESSION_INVALID`: the provider no longer knows the multipart
   * session (garbage-collected, already completed or aborted), or the client's
   * ETags belong to another one. A CLIENT-STATE error, never a 500: the client
   * aborts and re-initializes the upload (issues #183, #506).
   */
  private sessionInvalid(objectId: string): ConflictException {
    this.logger.warn(
      `Multipart session for object ${objectId} is no longer valid on the ` +
        `storage provider; the client must re-initialize the upload.`,
    );
    return new ConflictException({
      message:
        'The multipart upload session is no longer valid on the storage ' +
        'provider. Re-initialize the upload and send the parts again.',
      details: { reason: UPLOAD_ERROR_REASONS.UPLOAD_SESSION_INVALID },
    });
  }

  /**
   * Abort multipart upload
   */
  async abortUpload(objectId: string, userId: string): Promise<void> {
    const storageObject = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
    });

    if (!storageObject) {
      throw new NotFoundException('Upload not found');
    }

    // Check ownership
    if (storageObject.uploadedById !== userId) {
      throw new ForbiddenException('You do not own this upload');
    }

    if (!storageObject.s3UploadId) {
      throw new BadRequestException('Upload ID not found');
    }

    this.logger.log(`Aborting upload ${objectId}`);

    // Resolve from the object row so abort targets the same provider/bucket
    // that was used for the initiation even if the active provider changed.
    const abortProvider = await this.resolver.getProviderFor(
      storageObject.storageProvider,
      storageObject.bucket,
    );

    // Abort with storage provider
    await abortProvider.abortMultipartUpload(
      storageObject.storageKey,
      storageObject.s3UploadId,
    );

    // Delete database records
    await this.prisma.storageObject.delete({
      where: { id: objectId },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:abort', objectId, {
      name: storageObject.name,
      status: storageObject.status,
    });

    this.logger.log(`Upload aborted: ${objectId}`);
  }

  /**
   * Simple upload for smaller files
   */
  async simpleUpload(
    file: MultipartFile,
    userId: string,
  ): Promise<ObjectResponseDto> {
    const { filename, mimetype, file: stream } = file;

    // Generate storage key
    const timestamp = Date.now();
    const uuid = randomUUID();
    const extension = extname(filename);
    const storageKey = `uploads/${timestamp}/${uuid}${extension}`;

    this.logger.log(`Simple upload starting: ${filename}`);

    // Resolve the active storage provider dynamically from system settings.
    const { id: activeProviderId, provider: activeProvider } =
      await this.resolver.getActiveProvider();

    // Upload to storage
    const result = await activeProvider.upload(storageKey, stream, {
      mimeType: mimetype,
    });

    // We don't know the size until after upload for streams
    // Use a default size of 0, should be updated in post-processing
    const storageObject = await this.prisma.storageObject.create({
      data: {
        name: filename,
        size: BigInt(0), // Will be updated by post-processing
        mimeType: mimetype,
        storageKey,
        storageProvider: activeProviderId,
        bucket: result.bucket,
        status: 'processing',
        uploadedById: userId,
      },
    });

    // Emit event for post-processing
    this.eventEmitter.emit(
      OBJECT_UPLOADED_EVENT,
      new ObjectUploadedEvent(storageObject),
    );

    // Create audit event
    await this.createAuditEvent(userId, 'storage:upload:complete', storageObject.id, {
      name: storageObject.name,
      mimeType: storageObject.mimeType,
      uploadType: 'simple',
    });

    this.logger.log(`Simple upload completed: ${storageObject.id}`);

    return this.mapToResponseDto(storageObject);
  }

  /**
   * List user's objects with pagination and filtering
   */
  async list(
    query: ObjectListQueryDto,
    userId: string,
  ): Promise<ObjectListResponseDto> {
    const { page, pageSize, status, sortBy, sortOrder } = query;

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const where = {
      uploadedById: userId,
      ...(status && { status }),
      NOT: DERIVED_KEY_PREFIXES.map((prefix) => ({
        storageKey: { startsWith: prefix },
      })),
    };

    // Build orderBy clause
    const orderBy: any = {};
    if (sortBy === 'createdAt') {
      orderBy.createdAt = sortOrder;
    } else if (sortBy === 'name') {
      orderBy.name = sortOrder;
    } else if (sortBy === 'size') {
      orderBy.size = sortOrder;
    }

    const [items, totalItems] = await Promise.all([
      this.prisma.storageObject.findMany({
        where,
        orderBy,
        skip,
        take,
      }),
      this.prisma.storageObject.count({ where }),
    ]);

    const totalPages = Math.ceil(totalItems / pageSize);

    return {
      items: items.map((item) => this.mapToResponseDto(item)),
      meta: {
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    };
  }

  /**
   * Get object by ID with ownership check
   */
  async getById(id: string, userId: string, userPermissions: string[]): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId, userPermissions, 'viewer' as CircleRole);
    return this.mapToResponseDto(object);
  }

  /**
   * Get signed download URL for an object
   */
  async getDownloadUrl(
    id: string,
    userId: string,
    expiresIn?: number,
    userPermissions: string[] = [],
  ): Promise<DownloadUrlResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId, userPermissions, 'viewer' as CircleRole);

    // Verify status is ready
    if (object.status !== 'ready') {
      throw new BadRequestException(
        `Object is not ready for download. Current status: ${object.status}`,
      );
    }

    const defaultExpiry = this.config.get<number>(
      'storage.signedUrlExpiry',
      3600,
    );
    const expiry = expiresIn || defaultExpiry;

    const downloadProvider = await this.resolver.getProviderFor(
      object.storageProvider,
      object.bucket,
    );

    const url = await downloadProvider.getSignedDownloadUrl(
      object.storageKey,
      { expiresIn: expiry },
    );

    this.logger.log(`Generated download URL for object ${id}, expires in ${expiry}s`);

    return {
      url,
      expiresIn: expiry,
    };
  }

  /**
   * Presign a download URL for a storage object for a TRUSTED INTERNAL EXECUTOR.
   *
   * This deliberately differs from {@link getDownloadUrl} in two ways:
   *   1. It does NOT gate on `status === 'ready'`. The raw uploaded bytes exist
   *      at `storageKey` the moment the upload completes — long before the
   *      in-process processing pipeline flips the object to `ready`. The
   *      in-process enrichment worker reads those bytes directly via
   *      `provider.download(storageKey)` with no status check (e.g.
   *      FaceDetectionService), so a distributed worker node claiming the same
   *      job must be able to presign the same bytes even while the object is
   *      still `status='processing'`.
   *   2. It does NOT run any per-user ownership/circle-membership auth check.
   *      This is for server-trusted callers only (worker node job claiming),
   *      mirroring the in-process worker's unauthenticated byte access. NEVER
   *      expose this on a user-facing route — the public download path
   *      ({@link getDownloadUrl}) keeps its ready + auth guards.
   *
   * @returns a presigned GET URL, or `null` when the object row is missing or
   *          has no `storageKey`.
   */
  async getInternalDownloadUrl(
    objectId: string,
    expiresIn?: number,
  ): Promise<string | null> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id: objectId },
      select: { storageKey: true, storageProvider: true, bucket: true },
    });

    if (!object || !object.storageKey) {
      return null;
    }

    const provider = await this.resolver.getProviderFor(
      object.storageProvider,
      object.bucket,
    );

    return provider.getSignedDownloadUrl(object.storageKey, {
      expiresIn:
        expiresIn ?? this.config.get<number>('storage.signedUrlExpiry', 3600),
    });
  }

  /**
   * Delete object from storage and database
   */
  async delete(id: string, userId: string, userPermissions: string[]): Promise<void> {
    const object = await this.getObjectWithAuthCheck(id, userId, userPermissions, 'collaborator' as CircleRole);

    this.logger.log(`Deleting object ${id} from storage and database`);

    // Resolve from the object row so the delete targets the provider and bucket
    // where the file actually lives, regardless of what the current active
    // provider is.
    const deleteProvider = await this.resolver.getProviderFor(
      object.storageProvider,
      object.bucket,
    );

    // Delete from storage provider
    await deleteProvider.delete(object.storageKey);

    // Delete from database (cascade deletes chunks)
    await this.prisma.storageObject.delete({
      where: { id },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:delete', id, {
      name: object.name,
      size: object.size.toString(),
      mimeType: object.mimeType,
    });

    this.logger.log(`Object deleted: ${id}`);
  }

  /**
   * Update object metadata
   */
  async updateMetadata(
    id: string,
    dto: UpdateMetadataDto,
    userId: string,
    userPermissions: string[],
  ): Promise<ObjectResponseDto> {
    const object = await this.getObjectWithAuthCheck(id, userId, userPermissions, 'collaborator' as CircleRole);

    // Merge new metadata with existing
    const existingMetadata = (object.metadata as Record<string, unknown>) || {};
    const mergedMetadata = {
      ...existingMetadata,
      ...dto.metadata,
    };

    // Update in database
    const updated = await this.prisma.storageObject.update({
      where: { id },
      data: { metadata: mergedMetadata as Prisma.InputJsonValue },
    });

    // Create audit event
    await this.createAuditEvent(userId, 'storage:object:metadata:update', id, {
      name: object.name,
      metadataChanges: dto.metadata,
    });

    this.logger.log(`Updated metadata for object ${id}`);

    return this.mapToResponseDto(updated);
  }

  /**
   * Helper method to get object with ownership check
   * @private
   */
  private async getObjectWithAuthCheck(
    id: string,
    userId: string,
    userPermissions: string[],
    required: CircleRole,
  ): Promise<any> {
    const object = await this.prisma.storageObject.findUnique({
      where: { id },
      include: { mediaItem: true },
    });

    if (!object) {
      throw new NotFoundException('Object not found');
    }

    if (object.mediaItem) {
      // Access controlled via circle membership
      await this.circleMembershipService.assertCircleAccess(
        userId,
        object.mediaItem.circleId,
        userPermissions,
        required,
      );
    } else {
      // In-progress upload with no linked MediaItem: owner-only
      if (object.uploadedById !== userId) {
        throw new ForbiddenException('You do not have access to this object');
      }
    }

    return object;
  }

  /**
   * Map Prisma model to response DTO
   */
  private mapToResponseDto(obj: any): ObjectResponseDto {
    return {
      id: obj.id,
      name: obj.name,
      size: obj.size.toString(),
      mimeType: obj.mimeType,
      status: obj.status,
      metadata: obj.metadata as Record<string, unknown> | null,
      createdAt: obj.createdAt.toISOString(),
      updatedAt: obj.updatedAt.toISOString(),
    };
  }

  /**
   * Create audit event for storage operations
   */
  private async createAuditEvent(
    userId: string,
    action: string,
    objectId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action,
        targetType: 'storage_object',
        targetId: objectId,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
