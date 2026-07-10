/**
 * Unit tests for VideoFaceDetectionHandler.
 *
 * Focus: the storageObject.upsert call added to register a StorageObject row
 * for every successfully uploaded representative-frame JPEG (so that
 * MediaThumbnailService.signThumb() can resolve a signed URL).
 *
 * What is mocked:
 *  - sharp              — dynamic import inside the handler; returns a small JPEG
 *  - fluent-ffmpeg      — never reached (VideoFrameExtractionService is fully mocked)
 *  - image-orientation  — prepareImageForProcessing returns the buffer unchanged
 *
 * Collaborators replaced with plain jest mocks (no NestJS testing module needed):
 *  - EnrichmentHandlerRegistry  — register()
 *  - PrismaService              — mediaItem.findUnique, systemSettings.findUnique,
 *                                 storageObject.upsert, face.deleteMany, face.create,
 *                                 face.update, mediaFaceStatus.upsert
 *  - FaceDetectionCore          — markProcessing, resolveProviderAndCreds,
 *                                 detectWithThrottleMapping, normalizeFace,
 *                                 persistAndMatchFaces, markStatus, markFailed,
 *                                 recordModel (via EnrichmentJobService)
 *  - VideoFrameExtractionService — extractFrames (returns one fake frame)
 *  - FaceMatchingService        — cosineSimilarity, clusterThreshold
 *  - StorageProviderResolver    — getActiveProvider(), getProviderFor()
 *  - EnrichmentJobService       — recordModel
 *
 * Architecture note:
 *   The handler's process() path calls `await import('sharp')` dynamically for
 *   thumbnail downscaling. We mock sharp before importing the handler so Jest
 *   intercepts the ESM-style default export and each test controls behaviour
 *   through the mock factory returned by jest.requireMock('sharp').
 *
 * OOM-fix coverage note:
 *   VideoFaceDetectionHandler streams the downloaded video straight to a temp
 *   file (`streamToTempFile`) instead of buffering it into memory, and cleans
 *   that temp file up in a `finally` block after frame extraction + detection.
 *   `fs`'s `promises.unlink` is spied on (delegating to the real implementation
 *   so the temp file is actually removed and no test files leak) so we can
 *   assert the cleanup happens on both the success and thrown-error paths,
 *   without otherwise disturbing real `fs` behavior (`@prisma/client` needs the
 *   real filesystem module to load).
 *
 * Queue-resilience coverage note:
 *   The same `fs` mock also replaces `promises.statfs` with a deterministic
 *   stub (plenty of free space by default) because the handler now runs
 *   `assertDiskSpaceForDownload` (statfs on os.tmpdir(), 20% headroom over the
 *   object size) before any video download. Tests override it per-case to
 *   simulate a full disk. The storageObject fixture gained a `size` (BigInt)
 *   field for the disk guard and the optional VIDEO_ENRICHMENT_MAX_BYTES hard
 *   cap (oversized → markStatus no_faces, no download).
 */

// ---------------------------------------------------------------------------
// Module-level mocks — must come before any import of the handler
// ---------------------------------------------------------------------------

// Mock sharp so the dynamic `await import('sharp')` in the handler resolves.
// The factory returns a chainable mock that supports:
//   .metadata()  — resolves to { width, height } (separate call, not chainable in real sharp)
//   .extract()   — chainable, returns the pipeline so .resize().jpeg().toBuffer() works
//   .resize()    — chainable
//   .jpeg()      — chainable
//   .toBuffer()  — resolves to a fake JPEG buffer
// Each test can override per-call via mockReturnValueOnce on jest.requireMock('sharp').
jest.mock('sharp', () => {
  const mockPipeline = {
    metadata: jest.fn().mockResolvedValue({ width: 1000, height: 800 }),
    extract: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-thumb-jpeg')),
  };
  return jest.fn().mockReturnValue(mockPipeline);
});

// Mock prepareImageForProcessing — applied orientation upright, returns the
// buffer as-is with non-zero dimensions so the handler continues normally.
jest.mock('../storage/processing/image-orientation.util', () => ({
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('frame-prepared'),
    width: 640,
    height: 480,
  }),
}));

// Mock fluent-ffmpeg (required transitively by VideoFrameExtractionService
// even though the service itself is replaced; importing the class loads the
// module, so the mock prevents native binary lookup failures).
jest.mock('fluent-ffmpeg', () => {
  const chain = {
    seekInput: jest.fn().mockReturnThis(),
    frames: jest.fn().mockReturnThis(),
    output: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation((event: string, cb: () => void) => {
      if (event === 'end') cb();
      return chain;
    }),
    run: jest.fn().mockReturnThis(),
  };
  const ffmpegMock = jest.fn().mockReturnValue(chain);
  return { default: ffmpegMock, __esModule: true, ...ffmpegMock };
});

// Spy on fs.promises.unlink (delegating to the real implementation) so tests
// can assert the downloaded temp video file is actually cleaned up, without
// replacing the rest of the real `fs` module — @prisma/client and other
// transitive imports need real fs to load.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      unlink: jest.fn().mockImplementation((...args: unknown[]) =>
        (actual.promises.unlink as (...a: unknown[]) => Promise<void>)(...args),
      ),
      // Deterministic statfs stub for the disk-space guard: default to ample
      // free space (bavail * bsize = ~1 TB) so ordinary tests never trip it;
      // disk-guard tests override per-call with mockResolvedValueOnce.
      statfs: jest.fn().mockResolvedValue({ bavail: 1_000_000, bsize: 1_000_000 }),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports — after mocks so jest intercepts module loading
// ---------------------------------------------------------------------------

import { Readable } from 'stream';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';
import { VideoFaceDetectionHandler } from './video-face-detection.handler';
import { prepareImageForProcessing } from '../storage/processing/image-orientation.util';

// ---------------------------------------------------------------------------
// Test-scoped factory helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-video-1',
    type: 'video_face_detection',
    mediaItemId: 'media-video-1',
    circleId: 'circle-1',
    status: JobStatus.running,
    reason: JobReason.upload,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 1,
    lastError: null,
    startedAt: new Date(),
    finishedAt: null,
    scheduledFor: null,
    rateLimitedAt: null,
    rateLimitHits: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Build a minimal MediaItem row with one StorageObject. */
function makeMediaItem(overrides: Partial<{
  id: string;
  circleId: string;
  type: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  storageObject: { storageKey: string; storageProvider: string; bucket: string; name: string; size: bigint } | null;
}> = {}) {
  return {
    id: 'media-video-1',
    circleId: 'circle-1',
    type: 'video',
    durationMs: 30000, // 30 s → 6 frames at 5 s interval
    width: 1280,
    height: 720,
    storageObject: {
      storageKey: 'uploads/video.mp4',
      storageProvider: 's3',
      bucket: 'my-bucket',
      name: 'video.mp4',
      // The handler's select now includes size (BigInt) for the disk-space
      // guard and the VIDEO_ENRICHMENT_MAX_BYTES hard cap.
      size: BigInt(1024),
    },
    ...overrides,
  };
}

/** A fake detected face as returned by a mocked FaceProvider. */
const FAKE_FACE = {
  boundingBox: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 },
  confidence: 0.95,
  embedding: [0.6, 0.8], // pre-normalized; L2 norm = 1
  landmarks: null,
  externalFaceId: null,
};

/** Normalized version of FAKE_FACE (as returned by core.normalizeFace). */
const FAKE_NORMALIZED_FACE = {
  ...FAKE_FACE,
  embedding: [0.6, 0.8],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('VideoFaceDetectionHandler', () => {
  // -------------------------------------------------------------------------
  // Shared mocks — rebuilt in beforeEach so each test starts clean
  // -------------------------------------------------------------------------

  let mockRegistry: { register: jest.Mock };
  let mockPrisma: {
    mediaItem: { findUnique: jest.Mock };
    systemSettings: { findUnique: jest.Mock };
    storageObject: { upsert: jest.Mock };
    face: { deleteMany: jest.Mock; create: jest.Mock; update: jest.Mock };
    mediaFaceStatus: { upsert: jest.Mock };
  };
  let mockCore: {
    markProcessing: jest.Mock;
    resolveProviderAndCreds: jest.Mock;
    detectWithThrottleMapping: jest.Mock;
    normalizeFace: jest.Mock;
    persistAndMatchFaces: jest.Mock;
    markStatus: jest.Mock;
    markFailed: jest.Mock;
  };
  let mockFrameExtractor: { extractFrames: jest.Mock };
  let mockMatchingService: { cosineSimilarity: jest.Mock; clusterThreshold: number };
  let mockResolver: { getActiveProvider: jest.Mock; getProviderFor: jest.Mock };
  let mockActiveStorageProvider: { upload: jest.Mock; getBucket: jest.Mock };
  let mockObjectStorageProvider: { download: jest.Mock };
  let mockEnrichmentJobService: { recordModel: jest.Mock };

  let handler: VideoFaceDetectionHandler;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset sharp mock pipeline so all methods return consistent defaults.
    // metadata() and extract() are added here to support the face-crop path.
    const sharpMock = jest.requireMock('sharp') as jest.Mock;
    sharpMock.mockReturnValue({
      metadata: jest.fn().mockResolvedValue({ width: 1000, height: 800 }),
      extract: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-thumb-jpeg')),
    });

    // Reset prepareImageForProcessing mock
    (prepareImageForProcessing as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('frame-prepared'),
      width: 640,
      height: 480,
    });

    // -----------------------------------------------------------------------
    // Prisma mock — every table method starts as jest.fn()
    // -----------------------------------------------------------------------
    mockPrisma = {
      mediaItem: { findUnique: jest.fn() },
      systemSettings: { findUnique: jest.fn() },
      storageObject: { upsert: jest.fn().mockResolvedValue({ id: 'so-1' }) },
      face: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'face-1', embedding: [0.6, 0.8], externalFaceId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      mediaFaceStatus: { upsert: jest.fn().mockResolvedValue({}) },
    };

    // -----------------------------------------------------------------------
    // FaceDetectionCore mock — all helpers that VideoFaceDetectionHandler calls
    // -----------------------------------------------------------------------
    mockCore = {
      markProcessing: jest.fn().mockResolvedValue(undefined),
      resolveProviderAndCreds: jest.fn().mockResolvedValue({
        providerKey: 'compreface',
        modelVersion: 'arcface-r100-v1',
        provider: {
          detect: jest.fn(),
          capabilities: { delegatedRecognize: false },
        },
        creds: { apiKey: 'test-key' },
      }),
      detectWithThrottleMapping: jest.fn().mockResolvedValue([FAKE_FACE]),
      normalizeFace: jest.fn().mockReturnValue(FAKE_NORMALIZED_FACE),
      persistAndMatchFaces: jest.fn().mockResolvedValue(1),
      markStatus: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    // -----------------------------------------------------------------------
    // VideoFrameExtractionService mock — returns exactly one fake frame
    // -----------------------------------------------------------------------
    mockFrameExtractor = {
      extractFrames: jest.fn().mockResolvedValue([
        {
          timestampMs: 2500,
          buffer: Buffer.from('fake-frame-jpeg'),
        },
      ]),
    };

    // -----------------------------------------------------------------------
    // FaceMatchingService mock — clusterThreshold drives dedup in handler
    // -----------------------------------------------------------------------
    mockMatchingService = {
      cosineSimilarity: jest.fn().mockReturnValue(0.99), // same identity always
      clusterThreshold: 0.45,
    };

    // -----------------------------------------------------------------------
    // Storage provider mocks
    // -----------------------------------------------------------------------
    mockObjectStorageProvider = {
      download: jest.fn().mockResolvedValue(Readable.from(Buffer.from('fake-video-bytes'))),
    };

    mockActiveStorageProvider = {
      upload: jest.fn().mockResolvedValue(undefined),
      getBucket: jest.fn().mockReturnValue('active-bucket'),
    };

    mockResolver = {
      getProviderFor: jest.fn().mockResolvedValue(mockObjectStorageProvider),
      getActiveProvider: jest.fn().mockResolvedValue({
        id: 'active-s3',
        provider: mockActiveStorageProvider,
      }),
    };

    mockEnrichmentJobService = {
      recordModel: jest.fn().mockResolvedValue(undefined),
    };

    // -----------------------------------------------------------------------
    // Prisma: default media item and system settings
    // -----------------------------------------------------------------------
    mockPrisma.mediaItem.findUnique.mockResolvedValue(makeMediaItem());
    mockPrisma.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: {
        face: {
          video: {
            enabled: true,
            sampleIntervalSeconds: 5,
            maxFramesPerVideo: 60,
          },
        },
      },
    });

    // -----------------------------------------------------------------------
    // Registry mock
    // -----------------------------------------------------------------------
    mockRegistry = { register: jest.fn() };

    // -----------------------------------------------------------------------
    // Instantiate the handler directly
    // -----------------------------------------------------------------------
    handler = new VideoFaceDetectionHandler(
      mockRegistry as any,
      mockPrisma as any,
      mockCore as any,
      mockFrameExtractor as any,
      mockMatchingService as any,
      mockResolver as any,
      mockEnrichmentJobService as any,
    );
  });

  // -------------------------------------------------------------------------
  // Boilerplate: type & registration
  // -------------------------------------------------------------------------

  describe('type', () => {
    it('has type === "video_face_detection"', () => {
      expect(handler.type).toBe('video_face_detection');
    });
  });

  describe('onModuleInit()', () => {
    it('registers itself with the handler registry', () => {
      handler.onModuleInit();
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
    });
  });

  // -------------------------------------------------------------------------
  // Key behaviour: storageObject.upsert on successful frame upload
  // -------------------------------------------------------------------------

  describe('StorageObject row registration on successful upload', () => {
    it('calls prisma.storageObject.upsert once for the single representative face', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledTimes(1);
    });

    it('upserts with status "ready"', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      expect(call.update.status).toBe('ready');
      expect(call.create.status).toBe('ready');
    });

    it('upserts with mimeType "image/jpeg"', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      expect(call.update.mimeType).toBe('image/jpeg');
      expect(call.create.mimeType).toBe('image/jpeg');
    });

    it('upserts with storageProvider matching the active provider id', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      // 'active-s3' is what getActiveProvider().id returns in the mock
      expect(call.update.storageProvider).toBe('active-s3');
      expect(call.create.storageProvider).toBe('active-s3');
    });

    it('upserts with bucket matching activeStorageProvider.getBucket()', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      expect(call.update.bucket).toBe('active-bucket');
      expect(call.create.bucket).toBe('active-bucket');
    });

    it('upserts where.storageKey matches the frameThumbnailKey pattern', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      const key: string = call.where.storageKey;

      // Key format: video-faces/<mediaItemId>/<uuid>.jpg
      expect(key).toMatch(/^video-faces\/media-video-1\/[0-9a-f-]+\.jpg$/);
    });

    it('passes the frameThumbnailKey through to persistAndMatchFaces', async () => {
      await handler.process(makeJob());

      // Capture the storageKey used in the upsert
      const upsertCall = mockPrisma.storageObject.upsert.mock.calls[0][0];
      const upsertedKey: string = upsertCall.where.storageKey;

      // The faces array passed to core.persistAndMatchFaces must contain the same key
      expect(mockCore.persistAndMatchFaces).toHaveBeenCalledWith(
        expect.objectContaining({
          faces: expect.arrayContaining([
            expect.objectContaining({ frameThumbnailKey: upsertedKey }),
          ]),
        }),
      );
    });

    it('includes metadata.videoFaceFrameOf set to the mediaItemId', async () => {
      await handler.process(makeJob());

      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      expect(call.create.metadata).toEqual(
        expect.objectContaining({ videoFaceFrameOf: 'media-video-1' }),
      );
      expect(call.update.metadata).toEqual(
        expect.objectContaining({ videoFaceFrameOf: 'media-video-1' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Failure path: upload throws → no upsert, face still pushed without key
  // -------------------------------------------------------------------------

  describe('StorageObject row NOT created when upload fails', () => {
    beforeEach(() => {
      mockActiveStorageProvider.upload.mockRejectedValue(new Error('S3 upload failed'));
    });

    it('does NOT call prisma.storageObject.upsert when the upload throws', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
    });

    it('still calls persistAndMatchFaces (face is persisted without frameThumbnailKey)', async () => {
      await handler.process(makeJob());

      expect(mockCore.persistAndMatchFaces).toHaveBeenCalled();
      const [input] = mockCore.persistAndMatchFaces.mock.calls[0];
      // The face must NOT have a frameThumbnailKey (key omitted, not null)
      expect(input.faces[0]).not.toHaveProperty('frameThumbnailKey');
    });

    it('still completes without throwing (upload failure is non-fatal)', async () => {
      await expect(handler.process(makeJob())).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple clusters → one upsert per cluster
  // -------------------------------------------------------------------------

  describe('multiple distinct face clusters', () => {
    beforeEach(() => {
      // Two frames, each with a different face and a low inter-cluster similarity
      // so the greedy dedup produces TWO clusters, not one.
      const FACE_A = { ...FAKE_FACE, confidence: 0.95, embedding: [1, 0] };
      const FACE_B = { ...FAKE_FACE, confidence: 0.90, embedding: [0, 1] };
      const FACE_A_NORM = { ...FACE_A, embedding: [1, 0] };
      const FACE_B_NORM = { ...FACE_B, embedding: [0, 1] };

      // Two frames
      mockFrameExtractor.extractFrames.mockResolvedValue([
        { timestampMs: 2500, buffer: Buffer.from('frame-a') },
        { timestampMs: 7500, buffer: Buffer.from('frame-b') },
      ]);

      // detectWithThrottleMapping returns one face per frame in order
      mockCore.detectWithThrottleMapping
        .mockResolvedValueOnce([FACE_A])
        .mockResolvedValueOnce([FACE_B]);

      // normalizeFace returns respective normalized faces
      mockCore.normalizeFace
        .mockReturnValueOnce(FACE_A_NORM)
        .mockReturnValueOnce(FACE_B_NORM);

      // cosineSimilarity returns 0 → FACE_A and FACE_B are distinct clusters
      mockMatchingService.cosineSimilarity.mockReturnValue(0);

      mockCore.persistAndMatchFaces.mockResolvedValue(2);
    });

    it('calls storageObject.upsert once per cluster (two upserts)', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledTimes(2);
    });

    it('each upsert uses a distinct storageKey', async () => {
      await handler.process(makeJob());

      const keys = mockPrisma.storageObject.upsert.mock.calls.map(
        (c: any[]) => c[0].where.storageKey,
      );
      expect(keys[0]).not.toBe(keys[1]);
    });
  });

  // -------------------------------------------------------------------------
  // face.video.enabled === false → no frames, no upsert
  // -------------------------------------------------------------------------

  describe('face.video.enabled = false', () => {
    beforeEach(() => {
      mockPrisma.systemSettings.findUnique.mockResolvedValue({
        key: 'global',
        value: { face: { video: { enabled: false } } },
      });
    });

    it('skips frame extraction and does not call storageObject.upsert', async () => {
      await handler.process(makeJob());

      expect(mockFrameExtractor.extractFrames).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
    });

    it('marks status as no_faces', async () => {
      await handler.process(makeJob());

      expect(mockCore.markStatus).toHaveBeenCalledWith(
        'media-video-1',
        'no_faces',
        0,
        expect.any(String),
        expect.any(String),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Missing mediaItemId guard
  // -------------------------------------------------------------------------

  describe('missing mediaItemId', () => {
    it('throws immediately without touching storage when mediaItemId is null', async () => {
      const job = makeJob({ mediaItemId: null });

      await expect(handler.process(job)).rejects.toThrow(
        'video_face_detection job missing mediaItemId',
      );

      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Face-centered crop thumbnail — normal bounding box
  // -------------------------------------------------------------------------

  describe('face-crop thumbnail with normal bounding box', () => {
    /**
     * Bounding box: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 }
     * Frame dims from mocked metadata(): 1000 × 800
     *
     * Expected crop with 35% padding:
     *   padX = 0.2 * 0.35 = 0.07
     *   padY = 0.2 * 0.35 = 0.07
     *   left   = max(0, 0.4 - 0.07) = 0.33  → cropLeft = round(0.33 * 1000) = 330
     *   top    = max(0, 0.3 - 0.07) = 0.23  → cropTop  = round(0.23 * 800)  = 184
     *   right  = min(1, 0.4 + 0.2 + 0.07) = 0.67 → round(0.67 * 1000) = 670
     *   bottom = min(1, 0.3 + 0.2 + 0.07) = 0.57 → round(0.57 * 800)  = 456
     *   cropW  = 670 - 330 = 340 (clamped: 340 ≤ 1000 - 330 = 670 ✓)
     *   cropH  = 456 - 184 = 272 (clamped: 272 ≤ 800 - 184 = 616 ✓)
     */
    const NORMAL_BBOX = { x: 0.4, y: 0.3, w: 0.2, h: 0.2 };
    const FRAME_W = 1000;
    const FRAME_H = 800;

    beforeEach(() => {
      // Use a face with our specific bounding box
      const faceWithNormalBbox = {
        ...FAKE_FACE,
        boundingBox: NORMAL_BBOX,
      };
      const normalizedWithNormalBbox = {
        ...FAKE_NORMALIZED_FACE,
        boundingBox: NORMAL_BBOX,
      };

      mockCore.detectWithThrottleMapping.mockResolvedValue([faceWithNormalBbox]);
      mockCore.normalizeFace.mockReturnValue(normalizedWithNormalBbox);

      // Make sharp().metadata() return the known frame dimensions
      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      sharpMock.mockReturnValue({
        metadata: jest.fn().mockResolvedValue({ width: FRAME_W, height: FRAME_H }),
        extract: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-crop-jpeg')),
      });
    });

    it('calls sharp().extract() with a crop region matching the 35%-margin box', async () => {
      await handler.process(makeJob());

      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      // The pipeline instance returned by sharp() — same object for all calls
      const pipeline = sharpMock.mock.results[sharpMock.mock.results.length - 1].value;
      const extractCall = pipeline.extract.mock.calls[0][0] as {
        left: number;
        top: number;
        width: number;
        height: number;
      };

      expect(extractCall.left).toBe(330);
      expect(extractCall.top).toBe(184);
      expect(extractCall.width).toBe(340);
      expect(extractCall.height).toBe(272);
    });

    it('calls sharp().resize() with width and height of 512 (FACE_CROP_MAX_DIM)', async () => {
      await handler.process(makeJob());

      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      const pipeline = sharpMock.mock.results[sharpMock.mock.results.length - 1].value;
      const resizeCall = pipeline.resize.mock.calls[0][0] as {
        width: number;
        height: number;
        fit: string;
        withoutEnlargement: boolean;
      };

      expect(resizeCall.width).toBe(512);
      expect(resizeCall.height).toBe(512);
      expect(resizeCall.fit).toBe('inside');
      expect(resizeCall.withoutEnlargement).toBe(true);
    });

    it('still calls storageObject.upsert after a successful crop', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledTimes(1);
      const call = mockPrisma.storageObject.upsert.mock.calls[0][0];
      expect(call.create.mimeType).toBe('image/jpeg');
      expect(call.create.status).toBe('ready');
    });
  });

  // -------------------------------------------------------------------------
  // Face-centered crop thumbnail — degenerate bounding box (fallback path)
  // -------------------------------------------------------------------------

  describe('face-crop thumbnail with degenerate bounding box (w=0, h=0)', () => {
    /**
     * When the bounding box has w<=0 or h<=0 the handler must NOT call extract()
     * and must fall back to the full-frame resize path (FRAME_THUMB_MAX_DIM = 800).
     */
    const DEGENERATE_BBOX = { x: 0, y: 0, w: 0, h: 0 };

    beforeEach(() => {
      const faceDegenerate = { ...FAKE_FACE, boundingBox: DEGENERATE_BBOX };
      const normalizedDegenerate = { ...FAKE_NORMALIZED_FACE, boundingBox: DEGENERATE_BBOX };

      mockCore.detectWithThrottleMapping.mockResolvedValue([faceDegenerate]);
      mockCore.normalizeFace.mockReturnValue(normalizedDegenerate);

      // Provide valid frame dims — the fallback is triggered by the degenerate bbox,
      // not by missing metadata.
      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      sharpMock.mockReturnValue({
        metadata: jest.fn().mockResolvedValue({ width: 1000, height: 800 }),
        extract: jest.fn().mockReturnThis(),
        resize: jest.fn().mockReturnThis(),
        jpeg: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-fallback-jpeg')),
      });
    });

    it('does NOT call sharp().extract() when the bounding box is degenerate', async () => {
      await handler.process(makeJob());

      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      // Gather all pipeline instances across all sharp() calls
      const allPipelines = sharpMock.mock.results.map((r: jest.MockResult<unknown>) => r.value) as Array<{
        extract: jest.Mock;
      }>;
      const anyExtractCalled = allPipelines.some((p) => p.extract.mock.calls.length > 0);
      expect(anyExtractCalled).toBe(false);
    });

    it('calls sharp().resize() with 800 (full-frame fallback) when bbox is degenerate', async () => {
      await handler.process(makeJob());

      const sharpMock = jest.requireMock('sharp') as jest.Mock;
      // The last pipeline instance is from the actual thumbnail build
      const pipeline = sharpMock.mock.results[sharpMock.mock.results.length - 1].value as {
        resize: jest.Mock;
      };
      const resizeCall = pipeline.resize.mock.calls[0][0] as {
        width: number;
        height: number;
      };

      expect(resizeCall.width).toBe(800);
      expect(resizeCall.height).toBe(800);
    });

    it('still calls storageObject.upsert after the full-frame fallback', async () => {
      await handler.process(makeJob());

      expect(mockPrisma.storageObject.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Downloaded temp video file cleanup (OOM fix regression coverage)
  //
  // VideoFaceDetectionHandler streams the download straight to a temp file
  // (constant memory) instead of buffering the whole video into a Buffer, and
  // removes that temp file in a `finally` block that wraps frame extraction +
  // detection. These tests assert the `finally` actually fires — both when
  // everything succeeds and when a downstream step throws.
  // -------------------------------------------------------------------------

  describe('downloaded temp video file cleanup (OOM fix)', () => {
    const mockUnlink = fsPromises.unlink as jest.Mock;

    it('cleans up the downloaded temp file exactly once after successful frame extraction', async () => {
      await handler.process(makeJob());

      // The path handed to extractFrames is the same one the handler must clean up.
      const tmpVideoPath = mockFrameExtractor.extractFrames.mock.calls[0][0] as string;
      expect(typeof tmpVideoPath).toBe('string');
      expect(tmpVideoPath).toMatch(/memoriaHub-vface-dl-.*\.mp4$/);

      expect(mockUnlink).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledWith(tmpVideoPath);
    });

    it('still cleans up the downloaded temp file when frame extraction throws', async () => {
      mockFrameExtractor.extractFrames.mockRejectedValue(new Error('ffmpeg exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('ffmpeg exploded');

      const tmpVideoPath = mockFrameExtractor.extractFrames.mock.calls[0][0] as string;
      expect(mockUnlink).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledWith(tmpVideoPath);
    });

    it('still cleans up the downloaded temp file when face detection throws mid-loop', async () => {
      mockCore.detectWithThrottleMapping.mockRejectedValue(new Error('provider exploded'));

      await expect(handler.process(makeJob())).rejects.toThrow('provider exploded');

      const tmpVideoPath = mockFrameExtractor.extractFrames.mock.calls[0][0] as string;
      expect(mockUnlink).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledWith(tmpVideoPath);
    });

    it('never lets an unlink failure escape process() (cleanup errors are swallowed)', async () => {
      mockUnlink.mockRejectedValueOnce(new Error('ENOENT: no such file'));

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockUnlink).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // VIDEO_ENRICHMENT_MAX_BYTES hard size cap (queue-resilience)
  //
  // When the env cap is set (> 0) and the storage object exceeds it, the
  // handler marks the item no_faces — like the other skip paths — WITHOUT
  // downloading a single byte. Default (0 / unset) disables the cap. The env
  // var is read per-call, so no module re-import is needed.
  // -------------------------------------------------------------------------

  describe('VIDEO_ENRICHMENT_MAX_BYTES hard size cap', () => {
    const SAVED_MAX_BYTES = process.env['VIDEO_ENRICHMENT_MAX_BYTES'];

    afterEach(() => {
      if (SAVED_MAX_BYTES === undefined) {
        delete process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
      } else {
        process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = SAVED_MAX_BYTES;
      }
    });

    it('marks no_faces and never downloads when the object size exceeds the cap', async () => {
      process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = '1000';
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          storageObject: { ...makeMediaItem().storageObject!, size: BigInt(5000) },
        }),
      );

      await expect(handler.process(makeJob())).resolves.toBeUndefined();

      expect(mockCore.markStatus).toHaveBeenCalledWith(
        'media-video-1',
        'no_faces',
        0,
        expect.any(String),
        expect.any(String),
      );
      // Not a single byte downloaded, no frames, no thumbnails.
      expect(mockResolver.getProviderFor).not.toHaveBeenCalled();
      expect(mockObjectStorageProvider.download).not.toHaveBeenCalled();
      expect(mockFrameExtractor.extractFrames).not.toHaveBeenCalled();
      expect(mockPrisma.storageObject.upsert).not.toHaveBeenCalled();
    });

    it('processes normally when the object size is within the cap', async () => {
      process.env['VIDEO_ENRICHMENT_MAX_BYTES'] = '10000';
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          storageObject: { ...makeMediaItem().storageObject!, size: BigInt(5000) },
        }),
      );

      await handler.process(makeJob());

      expect(mockObjectStorageProvider.download).toHaveBeenCalledTimes(1);
      expect(mockFrameExtractor.extractFrames).toHaveBeenCalledTimes(1);
      expect(mockCore.persistAndMatchFaces).toHaveBeenCalled();
    });

    it('cap disabled (env unset, default 0) processes an arbitrarily large video normally', async () => {
      delete process.env['VIDEO_ENRICHMENT_MAX_BYTES'];
      mockPrisma.mediaItem.findUnique.mockResolvedValue(
        makeMediaItem({
          storageObject: { ...makeMediaItem().storageObject!, size: BigInt(10_000_000_000) },
        }),
      );

      await handler.process(makeJob());

      expect(mockObjectStorageProvider.download).toHaveBeenCalledTimes(1);
      expect(mockFrameExtractor.extractFrames).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Disk-space guard before download (queue-resilience)
  //
  // assertDiskSpaceForDownload(size, tmpdir()) runs BEFORE provider.download —
  // when the temp filesystem lacks size * 1.2 headroom the job fails fast
  // (through the worker's normal retry path) without writing a partial file.
  // -------------------------------------------------------------------------

  describe('disk-space guard before download', () => {
    const mockStatfs = fsPromises.statfs as unknown as jest.Mock;
    const mockUnlink = fsPromises.unlink as jest.Mock;

    it('rejects with the insufficient-disk-space error and never starts the download when free space is too low', async () => {
      // Zero free space on the temp filesystem.
      mockStatfs.mockResolvedValueOnce({ bavail: 0, bsize: 4096 });

      await expect(handler.process(makeJob())).rejects.toThrow(
        /insufficient disk space for video download/,
      );

      expect(mockObjectStorageProvider.download).not.toHaveBeenCalled();
      expect(mockFrameExtractor.extractFrames).not.toHaveBeenCalled();
      // The guard throws before the download try/finally — no temp file was
      // ever created, so nothing is unlinked.
      expect(mockUnlink).not.toHaveBeenCalled();
      // The failure is surfaced to the face status like any other error.
      expect(mockCore.markFailed).toHaveBeenCalledWith(
        'media-video-1',
        expect.any(String),
        expect.any(String),
        expect.stringContaining('insufficient disk space'),
      );
    });

    it('checks the temp directory filesystem (statfs on os.tmpdir())', async () => {
      await handler.process(makeJob());

      expect(mockStatfs).toHaveBeenCalledWith(tmpdir());
    });

    it('proceeds with the download when free space covers the size plus 20% headroom', async () => {
      // size = 1024 bytes → needed = 1229; provide just enough.
      mockStatfs.mockResolvedValueOnce({ bavail: 1229, bsize: 1 });

      await handler.process(makeJob());

      expect(mockObjectStorageProvider.download).toHaveBeenCalledTimes(1);
    });
  });
});
