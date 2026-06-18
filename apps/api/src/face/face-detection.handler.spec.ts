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

import { FaceDetectionHandler } from './face-detection.handler';
import { EnrichmentJob, JobReason, JobStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'face_detection',
    mediaItemId: 'media-1',
    circleId: 'circle-1',
    status: JobStatus.pending,
    reason: JobReason.upload,
    priority: 0,
    providerKey: null,
    modelVersion: null,
    payload: null,
    attempts: 0,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FaceDetectionHandler', () => {
  let mockRegistry: { register: jest.Mock };
  let mockFaceDetectionService: { processMediaItem: jest.Mock };
  let handler: FaceDetectionHandler;

  beforeEach(() => {
    mockRegistry = { register: jest.fn() };
    mockFaceDetectionService = { processMediaItem: jest.fn() };
    // Instantiate directly — no NestJS testing module needed for this pure unit test
    handler = new FaceDetectionHandler(
      mockRegistry as any,
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
    it('calls registry.register() with itself when the module initializes', () => {
      handler.onModuleInit();

      expect(mockRegistry.register).toHaveBeenCalledTimes(1);
      expect(mockRegistry.register).toHaveBeenCalledWith(handler);
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
      expect(mockFaceDetectionService.processMediaItem).toHaveBeenCalledWith(job);
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
});
