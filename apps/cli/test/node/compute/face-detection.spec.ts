/**
 * test/node/compute/face-detection.spec.ts
 *
 * Unit tests for node/compute/face-detection.ts, which is CompreFace-only
 * (issue #113 — the Human/WASM pipeline was removed entirely):
 *   - always calls the shared package's detectComprefaceFaces, tagging the
 *     result with the CompreFace provider/model version constants;
 *   - maps CompreFace's {x,y,w,h} box onto the DTO's {x,y,width,height};
 *   - surfaces an unreachable sidecar as a CapabilityUnavailableError keyed
 *     on 'compreface' (no fallback provider exists to degrade to);
 *   - falls back to a direct sharp metadata read for image dimensions when
 *     prepareImageForProcessing reports 0x0.
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

const mockDetectComprefaceFaces = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/face-compreface', () => ({
  detectComprefaceFaces: mockDetectComprefaceFaces,
  COMPREFACE_MODEL_VERSION: 'compreface-arcface-mobilefacenet-128',
  COMPREFACE_PROVIDER_KEY: 'compreface',
}));

const { default: computeFaceDetection } = await import('../../../src/node/compute/face-detection.js');
const { CapabilityUnavailableError } = await import('../../../src/node/capabilities.js');

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

describe('computeFaceDetection — compreface-only', () => {
  it('calls detectComprefaceFaces with the configured sidecar URL and prepared buffer', async () => {
    mockLoadConfig.mockReturnValue({ node: { comprefaceUrl: 'http://localhost:9999' } });
    mockDetectComprefaceFaces.mockResolvedValue([]);

    await computeFaceDetection(inputPath, {});

    expect(mockDetectComprefaceFaces).toHaveBeenCalledWith(
      'http://localhost:9999',
      Buffer.from('prepared-bytes'),
    );
  });

  it('defaults comprefaceUrl to http://localhost:3000 when unset', async () => {
    mockLoadConfig.mockReturnValue({});
    mockDetectComprefaceFaces.mockResolvedValue([]);

    await computeFaceDetection(inputPath, {});

    expect(mockDetectComprefaceFaces).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.any(Buffer),
    );
  });

  it('still uses the default sidecar URL when loadConfig() returns null', async () => {
    // A missing/unreadable config no longer needs to be a hard failure: there
    // is no provider to get wrong, only a URL to default.
    mockLoadConfig.mockReturnValue(null);
    mockDetectComprefaceFaces.mockResolvedValue([]);

    await computeFaceDetection(inputPath, {});

    expect(mockDetectComprefaceFaces).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.any(Buffer),
    );
  });

  it('tags the result with the CompreFace provider/model version and maps faces to the DTO shape', async () => {
    mockLoadConfig.mockReturnValue({});
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

  it('defaults a missing embedding to []', async () => {
    mockLoadConfig.mockReturnValue({});
    mockDetectComprefaceFaces.mockResolvedValue([
      { boundingBox: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.5 },
    ]);

    const result = (await computeFaceDetection(inputPath, {})) as {
      faces: Array<{ embedding: number[] }>;
    };

    expect(result.faces[0].embedding).toEqual([]);
  });

  it('surfaces a network error as a CapabilityUnavailableError keyed on compreface', async () => {
    mockLoadConfig.mockReturnValue({});
    mockDetectComprefaceFaces.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(computeFaceDetection(inputPath, {})).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );

    mockDetectComprefaceFaces.mockRejectedValue(new Error('ECONNREFUSED'));
    const err = await computeFaceDetection(inputPath, {}).catch(
      (e: unknown) => e as InstanceType<typeof CapabilityUnavailableError>,
    );
    expect(err.capability).toBe('compreface');
    expect(err.detail).toMatch(/ECONNREFUSED/);
  });

  it('falls back to a direct sharp metadata read for dimensions when preprocessing reports 0x0', async () => {
    mockLoadConfig.mockReturnValue({});
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
