/**
 * Unit tests for VisualEmbeddingService.
 *
 * Covers:
 *  - preprocessImageForClip: golden-value CLIP mean/std normalization on a
 *    synthetic uniform-color pixel buffer, width=0 guard, sharp-throw guard
 *  - l2Normalize: unit-vector output, zero-vector fallback (no NaN)
 *  - looksLikeOnnxModel: magic-byte + size heuristic
 *  - Degraded mode: a failed ONNX session load flips isAvailable() to false
 *    permanently and is only attempted once (no retry storm)
 *  - hasEmbedding: row-existence probe used for backfill/batch idempotency
 *  - persistEmbedding: $executeRaw upsert of the vector row
 *
 * (Byte download moved OUT of this service with the compute/persist split —
 * DuplicateDetectionService downloads once and feeds embedImage a buffer;
 * see duplicate-detection.service.spec.ts for the download-path coverage.)
 *
 * sharp and onnxruntime-node are mocked — real image decode / native ONNX
 * inference would require test fixtures and platform-specific binaries,
 * mirroring the convention in burst/visual-hash.processor.spec.ts.
 */

// ---------------------------------------------------------------------------
// Top-level mocks (must precede all imports)
// ---------------------------------------------------------------------------

const mockOrtInferenceSessionCreate = jest.fn();
const mockOrtTensor = jest.fn().mockImplementation((type, data, dims) => ({ type, data, dims }));

jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: (...args: unknown[]) => mockOrtInferenceSessionCreate(...args) },
  Tensor: (...args: unknown[]) => mockOrtTensor(...args),
}));

const mockSharpToBuffer = jest.fn();
const mockSharpResize = jest.fn().mockReturnThis();
const mockSharpRemoveAlpha = jest.fn().mockReturnThis();
const mockSharpRaw = jest.fn().mockReturnThis();
const mockSharpPipeline = {
  resize: mockSharpResize,
  removeAlpha: mockSharpRemoveAlpha,
  raw: mockSharpRaw,
  toBuffer: mockSharpToBuffer,
};
jest.mock('sharp', () => {
  const mockSharpFn = jest.fn().mockReturnValue(mockSharpPipeline);
  (mockSharpFn as any).default = mockSharpFn;
  return mockSharpFn;
});

// The preprocessing seam moved into the shared parity package — mock the
// package's image module (the clip module imports prepareImageForProcessing
// from there internally). setComputeLogger must be present because the API's
// image-orientation.util re-export module calls it at import time.
jest.mock('@memoriahub/enrichment-compute/image', () => ({
  setComputeLogger: jest.fn(),
  prepareImageForProcessing: jest.fn().mockResolvedValue({
    buffer: Buffer.from('prepared'),
    width: 224,
    height: 224,
  }),
}));

// fs: avoid any real network download / disk I/O. existsSync=true means
// ensureModel() short-circuits before ever calling fetch().
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  promises: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import {
  VisualEmbeddingService,
  preprocessImageForClip,
  l2Normalize,
  looksLikeOnnxModel,
  VISUAL_EMBEDDING_MODEL_TAG,
} from './visual-embedding.service';
import { PrismaService } from '../prisma/prisma.service';
import { prepareImageForProcessing } from '@memoriahub/enrichment-compute/image';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';

const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;
const CLIP_IMAGE_SIZE = 224;

// ---------------------------------------------------------------------------
// Section A: pure preprocessing functions (no DI)
// ---------------------------------------------------------------------------

describe('preprocessImageForClip (pure function)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prepareImageForProcessing as jest.Mock).mockResolvedValue({
      buffer: Buffer.from('prepared'),
      width: 224,
      height: 224,
    });
  });

  it('produces a 3x224x224 planar Float32Array (length matches CHW layout for batch size 1)', async () => {
    const numPixels = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE;
    const uniformRgb = new Uint8Array(3 * numPixels);
    for (let i = 0; i < numPixels; i++) {
      uniformRgb[i * 3] = 255; // R
      uniformRgb[i * 3 + 1] = 0; // G
      uniformRgb[i * 3 + 2] = 0; // B
    }
    mockSharpToBuffer.mockResolvedValue({ data: uniformRgb, info: { width: 224, height: 224 } });

    const result = await preprocessImageForClip(Buffer.from('irrelevant'));

    expect(result).not.toBeNull();
    // 1 (batch) x 3 (channels) x 224 x 224 = 3 * 224 * 224 total float elements
    expect(result!.length).toBe(3 * CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE);
  });

  it('applies CLIP mean/std normalization correctly per channel plane (golden values)', async () => {
    const numPixels = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE;
    const uniformRgb = new Uint8Array(3 * numPixels);
    for (let i = 0; i < numPixels; i++) {
      uniformRgb[i * 3] = 255; // R = 1.0 normalized
      uniformRgb[i * 3 + 1] = 0; // G = 0.0 normalized
      uniformRgb[i * 3 + 2] = 128; // B = 128/255 normalized
    }
    mockSharpToBuffer.mockResolvedValue({ data: uniformRgb, info: { width: 224, height: 224 } });

    const result = await preprocessImageForClip(Buffer.from('irrelevant'));
    expect(result).not.toBeNull();

    const expectedR = (1 - CLIP_MEAN[0]) / CLIP_STD[0];
    const expectedG = (0 - CLIP_MEAN[1]) / CLIP_STD[1];
    const expectedB = (128 / 255 - CLIP_MEAN[2]) / CLIP_STD[2];

    // Planar layout: [0, numPixels) = R plane, [numPixels, 2*numPixels) = G plane,
    // [2*numPixels, 3*numPixels) = B plane. Uniform color -> every entry in a
    // plane must equal the same normalized value.
    expect(result![0]).toBeCloseTo(expectedR, 5);
    expect(result![numPixels - 1]).toBeCloseTo(expectedR, 5);
    expect(result![numPixels]).toBeCloseTo(expectedG, 5);
    expect(result![2 * numPixels - 1]).toBeCloseTo(expectedG, 5);
    expect(result![2 * numPixels]).toBeCloseTo(expectedB, 5);
    expect(result![3 * numPixels - 1]).toBeCloseTo(expectedB, 5);
  });

  it('resizes with fit:"fill" to the fixed CLIP input size and strips alpha before raw extraction', async () => {
    const numPixels = CLIP_IMAGE_SIZE * CLIP_IMAGE_SIZE;
    mockSharpToBuffer.mockResolvedValue({
      data: new Uint8Array(3 * numPixels),
      info: { width: 224, height: 224 },
    });

    await preprocessImageForClip(Buffer.from('irrelevant'));

    expect(mockSharpResize).toHaveBeenCalledWith(CLIP_IMAGE_SIZE, CLIP_IMAGE_SIZE, { fit: 'fill' });
    expect(mockSharpRemoveAlpha).toHaveBeenCalled();
    expect(mockSharpRaw).toHaveBeenCalled();
  });

  it('returns null without calling sharp when prepareImageForProcessing reports width=0', async () => {
    (prepareImageForProcessing as jest.Mock).mockResolvedValueOnce({
      buffer: Buffer.alloc(0),
      width: 0,
      height: 0,
    });

    const result = await preprocessImageForClip(Buffer.from('corrupt'));

    expect(result).toBeNull();
    expect(mockSharpToBuffer).not.toHaveBeenCalled();
  });

  it('returns null (never throws) when sharp processing rejects', async () => {
    mockSharpToBuffer.mockRejectedValueOnce(new Error('sharp decode failed'));

    await expect(preprocessImageForClip(Buffer.from('irrelevant'))).resolves.toBeNull();
  });
});

describe('l2Normalize (pure function)', () => {
  it('normalizes a vector to unit length (3-4-5 triangle)', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
  });

  it('resulting vector has magnitude 1 for an arbitrary vector', () => {
    const result = l2Normalize([1, 2, 3, 4]);
    const magnitude = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('does not divide by zero (all-zero vector stays all-zero, no NaN)', () => {
    const result = l2Normalize([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
    expect(result.some((v) => Number.isNaN(v))).toBe(false);
  });

  it('a single-element vector normalizes to [1] (or [-1] for negative input)', () => {
    expect(l2Normalize([5])).toEqual([1]);
    expect(l2Normalize([-5])).toEqual([-1]);
  });
});

describe('looksLikeOnnxModel (pure function)', () => {
  it('returns true for a buffer starting with the protobuf field-1 varint byte (0x08) and length > 4', () => {
    const buf = Buffer.from([0x08, 0x01, 0x02, 0x03, 0x04]);
    expect(looksLikeOnnxModel(buf)).toBe(true);
  });

  it('returns false when the leading byte is not 0x08', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(looksLikeOnnxModel(buf)).toBe(false);
  });

  it('returns false when the buffer is too short (<= 4 bytes) even with the correct leading byte', () => {
    const buf = Buffer.from([0x08, 0x01, 0x02]);
    expect(looksLikeOnnxModel(buf)).toBe(false);
  });

  it('returns false for an HTML error page (common failure mode for a bad download URL)', () => {
    const buf = Buffer.from('<!doctype html><html>...');
    expect(looksLikeOnnxModel(buf)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section B: degraded mode via the real loadSession() path
// ---------------------------------------------------------------------------

describe('VisualEmbeddingService — degraded mode', () => {
  let service: VisualEmbeddingService;
  let mockPrisma: MockPrismaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisualEmbeddingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<VisualEmbeddingService>(VisualEmbeddingService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('isAvailable() is true before any load attempt has occurred', () => {
    expect(service.isAvailable()).toBe(true);
  });

  it('embedImage returns null and isAvailable() flips to false when InferenceSession.create rejects', async () => {
    mockOrtInferenceSessionCreate.mockRejectedValue(new Error('unsupported platform'));

    const result = await service.embedImage(Buffer.from('irrelevant'));

    expect(result).toBeNull();
    expect(service.isAvailable()).toBe(false);
  });

  it('only attempts InferenceSession.create ONCE even across multiple embedImage calls (no retry storm)', async () => {
    mockOrtInferenceSessionCreate.mockRejectedValue(new Error('unsupported platform'));

    await service.embedImage(Buffer.from('a'));
    await service.embedImage(Buffer.from('b'));
    await service.embedImage(Buffer.from('c'));

    expect(mockOrtInferenceSessionCreate).toHaveBeenCalledTimes(1);
  });

  it('degraded mode persists permanently — a later embedImage call does not re-attempt the load', async () => {
    mockOrtInferenceSessionCreate.mockRejectedValue(new Error('boom'));
    await service.embedImage(Buffer.from('first'));
    expect(service.isAvailable()).toBe(false);

    mockOrtInferenceSessionCreate.mockClear();
    // Even if the underlying dependency would now succeed, degraded=true short-circuits.
    mockOrtInferenceSessionCreate.mockResolvedValue({ inputNames: ['x'], outputNames: ['y'], run: jest.fn() });

    const result = await service.embedImage(Buffer.from('second'));

    expect(result).toBeNull();
    expect(mockOrtInferenceSessionCreate).not.toHaveBeenCalled();
  });

  it('logs the degraded-mode message at error level (not warn) — GitHub issue #110 loudness regression guard', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    mockOrtInferenceSessionCreate.mockRejectedValue(new Error('unsupported platform'));

    await service.embedImage(Buffer.from('irrelevant'));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('VisualEmbeddingService running in degraded mode'),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('VisualEmbeddingService running in degraded mode'),
    );

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Section B.2: onApplicationBootstrap — eager boot-time native-runtime probe
// added for GitHub issue #110 (musl/glibc mismatch silently degrading CLIP
// dedup until the first lazy embed call). See the method's own doc comment
// in visual-embedding.service.ts for the rationale.
// ---------------------------------------------------------------------------

describe('VisualEmbeddingService — onApplicationBootstrap', () => {
  let service: VisualEmbeddingService;
  let mockPrisma: MockPrismaService;
  const ORIGINAL_NODE_ENV = process.env['NODE_ENV'];

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [VisualEmbeddingService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get<VisualEmbeddingService>(VisualEmbeddingService);
  });

  afterEach(() => {
    service.onModuleDestroy();
    process.env['NODE_ENV'] = ORIGINAL_NODE_ENV;
  });

  it('is a no-op under NODE_ENV=test: isAvailable() stays true and no bootstrap log is emitted', async () => {
    process.env['NODE_ENV'] = 'test';
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await service.onApplicationBootstrap();

    expect(service.isAvailable()).toBe(true);
    // Returns before reaching either the success-log or failure-log branch.
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('onnxruntime native runtime'));
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('onnxruntime native runtime'));

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('logs success and leaves isAvailable() true when the dynamic import resolves (NODE_ENV != test)', async () => {
    process.env['NODE_ENV'] = 'production';
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    // The file-level jest.mock('onnxruntime-node', ...) factory (top of this
    // file) resolves successfully, so `await import('onnxruntime-node')`
    // succeeds for this instance.
    await service.onApplicationBootstrap();

    expect(service.isAvailable()).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('onnxruntime native runtime loaded'),
    );

    logSpy.mockRestore();
  });

  it('sets degraded state and logs at error when the dynamic import rejects (NODE_ENV != test)', async () => {
    // The shared top-of-file `jest.mock('onnxruntime-node', ...)` always
    // resolves, so exercising the rejection branch requires temporarily
    // swapping the module registry's mock factory for 'onnxruntime-node' to
    // a throwing one, then re-requiring a fresh VisualEmbeddingService class
    // bound to it. NOTE: an earlier attempt wrapped this in
    // `jest.isolateModulesAsync` to scope the throwing mock to just this
    // instance, but the sandbox did not reliably hold across the `await
    // import(...)` microtask boundary inside `onApplicationBootstrap` — the
    // fresh instance kept observing the shared success mock instead of the
    // throwing one. `jest.resetModules()` + `jest.doMock()` on the shared
    // (non-sandboxed) registry is used instead, with the original mock
    // restored immediately after via `finally` so no other test in this file
    // is affected.
    jest.resetModules();
    jest.doMock('onnxruntime-node', () => {
      throw new Error('libonnxruntime.so.1: cannot open shared object file (musl/glibc mismatch)');
    });

    let errorSpy: jest.SpyInstance | undefined;
    try {
      const freshModule = require('./visual-embedding.service') as typeof import('./visual-embedding.service');
      // `jest.resetModules()` above also gives '@nestjs/common' a fresh
      // module instance, so `freshModule`'s internal `new Logger(...)` binds
      // to a DIFFERENT class object than the `Logger` imported at the top of
      // this file. Spy on the Logger class from the SAME (reset) registry
      // freshModule resolved against, or the spy silently never intercepts
      // (and the real logger prints to the console instead).
      const freshCommon = require('@nestjs/common') as typeof import('@nestjs/common');
      errorSpy = jest.spyOn(freshCommon.Logger.prototype, 'error').mockImplementation();

      const freshService = new freshModule.VisualEmbeddingService(mockPrisma as unknown as PrismaService);
      process.env['NODE_ENV'] = 'production';

      await freshService.onApplicationBootstrap();

      expect(freshService.isAvailable()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('onnxruntime native runtime failed to load'),
      );
    } finally {
      errorSpy?.mockRestore();
      // Restore the shared success mock and module registry so every test
      // after this one in the file (and the top-level `service` instance
      // constructed from the original module binding) keeps working.
      jest.resetModules();
      jest.doMock('onnxruntime-node', () => ({
        InferenceSession: { create: (...args: unknown[]) => mockOrtInferenceSessionCreate(...args) },
        Tensor: (...args: unknown[]) => mockOrtTensor(...args),
      }));
    }
  });
});

// ---------------------------------------------------------------------------
// Section C: persistence half (hasEmbedding / persistEmbedding)
// ---------------------------------------------------------------------------

describe('VisualEmbeddingService — persistence half', () => {
  let service: VisualEmbeddingService;
  let mockPrisma: MockPrismaService;

  const MEDIA_ITEM_ID = 'media-1';
  const CIRCLE_ID = 'circle-1';

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma = createMockPrismaService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisualEmbeddingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<VisualEmbeddingService>(VisualEmbeddingService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('hasEmbedding', () => {
    it('returns true when an embedding row exists', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([{ exists: 1 }]);

      await expect(service.hasEmbedding(MEDIA_ITEM_ID)).resolves.toBe(true);
    });

    it('returns false when no embedding row exists', async () => {
      (mockPrisma.$queryRaw as jest.Mock).mockResolvedValue([]);

      await expect(service.hasEmbedding(MEDIA_ITEM_ID)).resolves.toBe(false);
    });
  });

  describe('persistEmbedding', () => {
    it('upserts the vector row via a single $executeRaw', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.persistEmbedding(MEDIA_ITEM_ID, CIRCLE_ID, [0.1, 0.2, 0.3]);

      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('tags the row with VISUAL_EMBEDDING_MODEL_TAG when no model is given', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.persistEmbedding(MEDIA_ITEM_ID, CIRCLE_ID, [0.1, 0.2]);

      // $executeRaw is a tagged-template call: values are the interpolations.
      const callArgs = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0];
      expect(callArgs).toContain(VISUAL_EMBEDDING_MODEL_TAG);
    });

    it('passes an explicit model tag through to the row', async () => {
      (mockPrisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      await service.persistEmbedding(MEDIA_ITEM_ID, CIRCLE_ID, [0.1, 0.2], 'some-future-model');

      const callArgs = (mockPrisma.$executeRaw as jest.Mock).mock.calls[0];
      expect(callArgs).toContain('some-future-model');
    });
  });
});
