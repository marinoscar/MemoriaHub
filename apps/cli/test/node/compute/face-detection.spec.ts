/**
 * test/node/compute/face-detection.spec.ts
 *
 * Unit tests for node/compute/face-detection.ts's provider branching:
 *   - faceProvider omitted/'human' (default) keeps using the existing Human
 *     detector path unchanged.
 *   - faceProvider: 'compreface' calls the shared package's
 *     detectComprefaceFaces instead, tags the result with the CompreFace
 *     provider/model version constants, and propagates a network error
 *     WITHOUT catching it (no silent fallback to Human).
 *
 * `@memoriahub/enrichment-compute/*` subpaths and `../../src/config.js`'s
 * `loadConfig` are mocked via jest.unstable_mockModule (mirrors
 * self-test.spec.ts's convention) so no heavy optionalDependencies or real
 * config file are touched. The input file is a real temp file on disk (the
 * module reads it via `fs.readFileSync`), containing arbitrary bytes since
 * `prepareImageForProcessing` is mocked and never actually decodes it.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// getFaceDetector() in the module under test does a REAL `fs.existsSync()`
// check on the Human model directory before calling the (mocked)
// `createFaceDetector`, and short-circuits to a hard failure if the
// directory isn't present on disk. This repo/CI environment doesn't ship
// the downloaded Human model files, so point `FACE_HUMAN_MODEL_PATH` (the
// module's highest-precedence override — see resolveModelBasePath()) at
// `os.tmpdir()`, which always exists, so the existence check passes and
// control reaches the mocked `createFaceDetector` for every Human-path test
// below regardless of whether real model files are installed.
process.env['FACE_HUMAN_MODEL_PATH'] = os.tmpdir();

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../../../src/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockPrepareImageForProcessing = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/image', () => ({
  prepareImageForProcessing: mockPrepareImageForProcessing,
}));

const mockCreateFaceDetector = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/face', () => ({
  createFaceDetector: mockCreateFaceDetector,
  FACE_MODEL_VERSION: 'human-faceres-1024',
  FACE_PROVIDER_KEY: 'human',
}));

const mockDetectComprefaceFaces = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/face-compreface', () => ({
  detectComprefaceFaces: mockDetectComprefaceFaces,
  COMPREFACE_MODEL_VERSION: 'compreface-arcface-mobilefacenet-128',
  COMPREFACE_PROVIDER_KEY: 'compreface',
}));

const { default: computeFaceDetection } = await import('../../../src/node/compute/face-detection.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let inputPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-face-detection-compute-'));
  inputPath = path.join(tmpDir, 'input.jpg');
  fs.writeFileSync(inputPath, Buffer.from('fake-image-bytes'));

  mockLoadConfig.mockReset();
  mockPrepareImageForProcessing.mockReset();
  mockCreateFaceDetector.mockReset();
  mockDetectComprefaceFaces.mockReset();

  // Default: preprocessing "succeeds" with a plausible upright buffer/dims.
  mockPrepareImageForProcessing.mockResolvedValue({
    buffer: Buffer.from('prepared-bytes'),
    width: 800,
    height: 600,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Default (Human) path — unchanged behavior
// ---------------------------------------------------------------------------

describe('computeFaceDetection — human (default)', () => {
  it('uses the Human detector when faceProvider is omitted from config', async () => {
    // A present-but-empty config (logged in, no node.faceProvider set) — NOT
    // a null/missing config, which is now a hard failure (see the "throws"
    // test below).
    mockLoadConfig.mockReturnValue({});
    mockCreateFaceDetector.mockResolvedValue({
      detect: jest.fn().mockResolvedValue({
        width: 800,
        height: 600,
        faces: [{ boundingBox: { x: 1, y: 2, width: 3, height: 4 }, confidence: 0.9, embedding: [0.1] }],
      }),
    });

    const result = (await computeFaceDetection(inputPath, {})) as {
      providerKey: string;
      modelVersion: string;
      faces: unknown[];
    };

    expect(result.providerKey).toBe('human');
    expect(result.modelVersion).toBe('human-faceres-1024');
    expect(result.faces).toHaveLength(1);
    expect(mockDetectComprefaceFaces).not.toHaveBeenCalled();
  });

  it('uses the Human detector when faceProvider is explicitly "human"', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'human' } });
    mockCreateFaceDetector.mockResolvedValue({
      detect: jest.fn().mockResolvedValue({ width: 800, height: 600, faces: [] }),
    });

    const result = (await computeFaceDetection(inputPath, {})) as { providerKey: string };
    expect(result.providerKey).toBe('human');
    expect(mockDetectComprefaceFaces).not.toHaveBeenCalled();
  });

  it('throws (does not silently default to human) when loadConfig() returns null', async () => {
    // Previously a null/missing config silently defaulted the provider to
    // 'human'. That's now a hard failure — on a CompreFace-configured node,
    // silently falling back to Human would write embeddings in the wrong
    // (1024-d Human vs 128-d CompreFace) vector space. The engine's normal
    // job-failure + retry/backoff path handles the thrown error.
    mockLoadConfig.mockReturnValue(null);

    await expect(computeFaceDetection(inputPath, {})).rejects.toThrow(
      /could not load node config/,
    );
    expect(mockCreateFaceDetector).not.toHaveBeenCalled();
    expect(mockDetectComprefaceFaces).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CompreFace path
// ---------------------------------------------------------------------------

describe('computeFaceDetection — compreface opt-in', () => {
  it('calls detectComprefaceFaces (not the Human detector) with the prepared buffer', async () => {
    mockLoadConfig.mockReturnValue({
      node: { faceProvider: 'compreface', comprefaceUrl: 'http://localhost:9999' },
    });
    mockDetectComprefaceFaces.mockResolvedValue([]);

    await computeFaceDetection(inputPath, {});

    expect(mockDetectComprefaceFaces).toHaveBeenCalledWith(
      'http://localhost:9999',
      Buffer.from('prepared-bytes'),
    );
    expect(mockCreateFaceDetector).not.toHaveBeenCalled();
  });

  it('defaults comprefaceUrl to http://localhost:3000 when unset', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'compreface' } });
    mockDetectComprefaceFaces.mockResolvedValue([]);

    await computeFaceDetection(inputPath, {});

    expect(mockDetectComprefaceFaces).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.any(Buffer),
    );
  });

  it('tags the result with the CompreFace provider/model version and maps faces to the DTO shape', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'compreface' } });
    mockDetectComprefaceFaces.mockResolvedValue([
      {
        boundingBox: { x: 10, y: 20, w: 100, h: 120 },
        confidence: 0.87,
        landmarks: { nose: [1, 2] },
        embedding: [0.6, 0.8],
      },
    ]);

    const result = (await computeFaceDetection(inputPath, {})) as {
      providerKey: string;
      modelVersion: string;
      imageWidth: number;
      imageHeight: number;
      faces: Array<{
        boundingBox: { x: number; y: number; width: number; height: number };
        confidence: number;
        landmarks: unknown;
        embedding: number[];
      }>;
    };

    expect(result.providerKey).toBe('compreface');
    expect(result.modelVersion).toBe('compreface-arcface-mobilefacenet-128');
    expect(result.imageWidth).toBe(800);
    expect(result.imageHeight).toBe(600);
    expect(result.faces).toHaveLength(1);
    expect(result.faces[0].boundingBox).toEqual({ x: 10, y: 20, width: 100, height: 120 });
    expect(result.faces[0].confidence).toBe(0.87);
    expect(result.faces[0].landmarks).toEqual({ nose: [1, 2] });
    expect(result.faces[0].embedding).toEqual([0.6, 0.8]);
  });

  it('defaults a missing embedding to [] (matching the Human path convention)', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'compreface' } });
    mockDetectComprefaceFaces.mockResolvedValue([
      { boundingBox: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.5 },
    ]);

    const result = (await computeFaceDetection(inputPath, {})) as {
      faces: Array<{ embedding: number[] }>;
    };

    expect(result.faces[0].embedding).toEqual([]);
  });

  it('propagates a network error from detectComprefaceFaces WITHOUT catching it (no fallback to Human)', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'compreface' } });
    mockDetectComprefaceFaces.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(computeFaceDetection(inputPath, {})).rejects.toThrow('ECONNREFUSED');
    expect(mockCreateFaceDetector).not.toHaveBeenCalled();
  });

  it('falls back to a direct sharp metadata read for dimensions when preprocessing reports 0x0', async () => {
    mockLoadConfig.mockReturnValue({ node: { faceProvider: 'compreface' } });
    // prepareImageForProcessing failure convention: width/height 0, buffer unchanged.
    mockPrepareImageForProcessing.mockResolvedValue({ buffer: Buffer.alloc(0), width: 0, height: 0 });
    mockDetectComprefaceFaces.mockResolvedValue([]);

    // Write a real tiny JPEG so the sharp() fallback can decode real dimensions.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(Buffer.alloc(4 * 4 * 3), { raw: { width: 4, height: 4, channels: 3 } })
      .jpeg()
      .toBuffer();
    fs.writeFileSync(inputPath, jpeg);

    const result = (await computeFaceDetection(inputPath, {})) as {
      imageWidth: number;
      imageHeight: number;
    };

    expect(result.imageWidth).toBe(4);
    expect(result.imageHeight).toBe(4);
  });
});
