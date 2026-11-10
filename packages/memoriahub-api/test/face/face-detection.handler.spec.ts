/**
 * Unit tests for FaceDetectionHandler.
 *
 * Tests: type property, onModuleInit() self-registration with the registry,
 * delegation to FaceDetectionService.processMediaItem, and error propagation
 * when the service throws.
 *
 * Neither FaceDetectionService nor EnrichmentHandlerRegistry is imported —
 * both are replaced with plain mock objects so this unit test has no
 * transitive dependencies.
 */

import { MemoriahubRateLimitError } from '../../src/ports/index.js';
import { FaceDetectionHandler } from '../../src/face/face-detection.handler.js';
import { faceDetectionResultSchema } from '@marinoscar/memoriahub-compute/dto';
import { mediaItemJob, subjectPrisma } from './support/mock-jobs.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeJob = (mediaItemId = 'media-1') => mediaItemJob('face_detection', mediaItemId);

/** What the service receives for the default job. */
const CONTEXT = { id: 'job-1', mediaItemId: 'media-1', circleId: 'circle-1' };

/** Canned, schema-valid node result payload (Human provider, 4-d toy embedding). */
function makeNodeResult() {
  return {
    modelVersion: 'human-faceres-1024',
    providerKey: 'human',
    imageWidth: 800,
    imageHeight: 600,
    faces: [
      {
        boundingBox: { x: 100, y: 120, width: 80, height: 90 },
        confidence: 0.92,
        embedding: [0.1, 0.2, 0.3, 0.4],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceDetectionHandler', () => {
  let mockJobs: { registerHandler: jest.Mock };
  let mockFaceDetectionService: { processMediaItem: jest.Mock; persistFaces: jest.Mock };
  let handler: FaceDetectionHandler;

  beforeEach(() => {
    mockJobs = { registerHandler: jest.fn() };
    mockFaceDetectionService = {
      processMediaItem: jest.fn(),
      persistFaces: jest.fn().mockResolvedValue(undefined),
    };
    // Instantiate directly — no NestJS testing module needed for this pure unit test
    handler = new FaceDetectionHandler(
      mockJobs as any,
      subjectPrisma() as any,
      mockFaceDetectionService as any,
    );
  });

  // -------------------------------------------------------------------------
  // type property
  // -------------------------------------------------------------------------

  describe('type', () => {
    it('has type === "face_detection"', () => {
      expect(handler.type).toBe('face_detection');
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit() — self-registration
  // -------------------------------------------------------------------------

  describe('onModuleInit()', () => {
    it('registers itself with the queue when the module initializes', () => {
      handler.onModuleInit();

      expect(mockJobs.registerHandler).toHaveBeenCalledTimes(1);
      expect(mockJobs.registerHandler).toHaveBeenCalledWith(handler);
    });

    it('maps the type onto the face provider throttle bucket', () => {
      expect(handler.throttleKey).toBe('face');
    });
  });

  describe('platform contract', () => {
    it('declares a label and the 5-minute, 3-attempt profile', () => {
      expect(handler.label).toBe('Face detection (photo)');
      expect(handler.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 3 });
    });
  });

  // -------------------------------------------------------------------------
  // process() — delegation
  // -------------------------------------------------------------------------

  describe('process()', () => {
    it('delegates to faceDetectionService.processMediaItem with the job', async () => {
      // Arrange
      const job = makeJob();
      mockFaceDetectionService.processMediaItem.mockResolvedValue(undefined);

      // Act
      await handler.process(job);

      // Assert
      expect(mockFaceDetectionService.processMediaItem).toHaveBeenCalledTimes(1);
      expect(mockFaceDetectionService.processMediaItem).toHaveBeenCalledWith(CONTEXT);
    });

    it('settles as a no-op when the media item no longer exists', async () => {
      await expect(handler.process(makeJob('gone'))).resolves.toBeUndefined();
      expect(mockFaceDetectionService.processMediaItem).not.toHaveBeenCalled();
    });

    it('throws for a job that is not about a media item', async () => {
      const job = { ...makeJob(), subjectType: 'circle' };
      await expect(handler.process(job)).rejects.toThrow('not about a media item');
    });

    it('rethrows a provider throttle signal as the queue rate-limit error, keeping the retry-after', async () => {
      mockFaceDetectionService.processMediaItem.mockRejectedValue(
        Object.assign(new Error('slow down'), { status: 429, headers: { 'retry-after': '5' } }),
      );
      const error = await handler.process(makeJob()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MemoriahubRateLimitError);
      expect((error as MemoriahubRateLimitError).retryAfterMs).toBe(5000);
      expect((error as MemoriahubRateLimitError).throttleKey).toBe('face');
    });

    it('passes a rate-limit error through unchanged', async () => {
      const original = new MemoriahubRateLimitError('face', 1000, 'busy');
      mockFaceDetectionService.processMediaItem.mockRejectedValue(original);
      await expect(handler.process(makeJob())).rejects.toBe(original);
    });

    it('returns undefined (void) on success', async () => {
      // Arrange
      const job = makeJob();
      mockFaceDetectionService.processMediaItem.mockResolvedValue(undefined);

      // Act
      const result = await handler.process(job);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // process() — error propagation
  // -------------------------------------------------------------------------

  describe('process() error propagation', () => {
    it('propagates errors thrown by faceDetectionService.processMediaItem', async () => {
      // Arrange
      const job = makeJob();
      const detectionError = new Error('face detection failed');
      mockFaceDetectionService.processMediaItem.mockRejectedValue(detectionError);

      // Act / Assert
      await expect(handler.process(job)).rejects.toThrow('face detection failed');
    });

    it('does not swallow non-Error rejections', async () => {
      // Arrange
      const job = makeJob();
      mockFaceDetectionService.processMediaItem.mockRejectedValue('string rejection');

      // Act / Assert
      await expect(handler.process(job)).rejects.toBe('string rejection');
    });
  });

  // -------------------------------------------------------------------------
  // node-result surface (distributed worker nodes)
  // -------------------------------------------------------------------------

  describe('node-result surface', () => {
    it('exposes the shared package schema as nodeResultSchema', () => {
      expect(handler.nodeResultSchema).toBe(faceDetectionResultSchema);
      // Sanity: the schema accepts the canned payload used below.
      expect(() => handler.nodeResultSchema.parse(makeNodeResult())).not.toThrow();
    });

    it('persistNodeResult forwards the parsed payload to faceDetectionService.persistFaces', async () => {
      const job = makeJob();
      const result = makeNodeResult();

      await handler.persistNodeResult(job, result);

      expect(mockFaceDetectionService.persistFaces).toHaveBeenCalledTimes(1);
      const [passedJob, passedResult] = mockFaceDetectionService.persistFaces.mock.calls[0];
      expect(passedJob).toEqual(CONTEXT);
      void job;
      expect(passedResult).toEqual(result);
    });

    it('persistNodeResult rejects a schema-invalid payload without touching the service', async () => {
      const bad = { ...makeNodeResult(), faces: [{ boundingBox: { x: 1, y: 1 } }] }; // missing width/height/embedding
      await expect(handler.persistNodeResult(makeJob(), bad)).rejects.toThrow();
      expect(mockFaceDetectionService.persistFaces).not.toHaveBeenCalled();
    });
  });
});
