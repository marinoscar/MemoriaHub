/**
 * test/node/self-test.spec.ts
 *
 * Unit tests for node/self-test.ts's operational self-tests.
 *
 * Strategy:
 *   - `testSharp` is exercised WITHOUT any mocking — sharp needs no external
 *     model file and is safe to run for real in CI.
 *   - `testClip` / `testHuman` / `testTesseract` mock the corresponding
 *     `@memoriahub/enrichment-compute/*` subpath exports via
 *     jest.unstable_mockModule so the tests never depend on the heavy
 *     optionalDependencies (onnxruntime-node, @vladmandic/human,
 *     tesseract.js) actually being installed in CI — only the "is a model
 *     file present on disk" branch and the "does the compute call
 *     succeed/fail" branch are under test here.
 *   - `MODELS_DIR` is pointed at a per-test temp directory so no real
 *     ~/.memoriahub/models is touched and model-file presence is fully
 *     controlled by each test.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Mock the enrichment-compute subpaths BEFORE importing the module under
// test, so self-test.ts's top-level imports resolve to these stubs.
// ---------------------------------------------------------------------------

const mockCreateClipSession = jest.fn();
const mockEmbedImageWithSession = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/clip', () => ({
  createClipSession: mockCreateClipSession,
  embedImageWithSession: mockEmbedImageWithSession,
}));

const mockCreateFaceDetector = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/face', () => ({
  createFaceDetector: mockCreateFaceDetector,
}));

const mockCreateOcrEngine = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/ocr', () => ({
  createOcrEngine: mockCreateOcrEngine,
}));

const { testSharp, testClip, testHuman, testTesseract, runOperationalSelfTests } = await import(
  '../../src/node/self-test.js'
);
type CapabilityStatus = { available: boolean; detail?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let prevModelsDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-self-test-'));
  prevModelsDir = process.env['MODELS_DIR'];
  process.env['MODELS_DIR'] = tmpDir;
  delete process.env['FACE_HUMAN_MODEL_PATH'];
  mockCreateClipSession.mockReset();
  mockEmbedImageWithSession.mockReset();
  mockCreateFaceDetector.mockReset();
  mockCreateOcrEngine.mockReset();
});

afterEach(() => {
  if (prevModelsDir === undefined) delete process.env['MODELS_DIR'];
  else process.env['MODELS_DIR'] = prevModelsDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// testSharp — real, unmocked
// ---------------------------------------------------------------------------

describe('testSharp', () => {
  it('decodes and re-encodes a tiny synthetic buffer for real', async () => {
    const result = await testSharp();
    expect(result.available).toBe(true);
    expect(result.detail).toMatch(/roundtrip ok/);
  });
});

// ---------------------------------------------------------------------------
// testClip
// ---------------------------------------------------------------------------

describe('testClip', () => {
  it('reports not-yet-operational (graceful skip) when the model file is absent', async () => {
    const result: CapabilityStatus = await testClip();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/not downloaded yet/);
    expect(mockCreateClipSession).not.toHaveBeenCalled();
  });

  it('is operational when the model is present and embedding succeeds', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clip-vit-b32-vision-quantized.onnx'), Buffer.from([0x08, 0, 0]));
    mockCreateClipSession.mockResolvedValue({ fake: 'session' });
    mockEmbedImageWithSession.mockResolvedValue(new Array(512).fill(0.01));

    const result = await testClip();
    expect(result.available).toBe(true);
    expect(result.detail).toMatch(/512-d vector/);
    expect(mockCreateClipSession).toHaveBeenCalledWith(
      path.join(tmpDir, 'clip-vit-b32-vision-quantized.onnx'),
    );
  });

  it('downgrades to unavailable when the embedding output has the wrong dimensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clip-vit-b32-vision-quantized.onnx'), Buffer.from([0x08]));
    mockCreateClipSession.mockResolvedValue({ fake: 'session' });
    mockEmbedImageWithSession.mockResolvedValue([1, 2, 3]); // wrong length

    const result = await testClip();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/unexpected output/);
  });

  it('downgrades to unavailable (never throws) when session creation fails', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clip-vit-b32-vision-quantized.onnx'), Buffer.from([0x08]));
    mockCreateClipSession.mockRejectedValue(new Error('onnx session create failed'));

    const result = await testClip();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/CLIP self-test failed/);
    expect(result.detail).toMatch(/onnx session create failed/);
  });
});

// ---------------------------------------------------------------------------
// testHuman
// ---------------------------------------------------------------------------

describe('testHuman', () => {
  it('reports not-yet-operational (graceful skip) when Human model files are absent', async () => {
    const result = await testHuman();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/not present/);
    expect(mockCreateFaceDetector).not.toHaveBeenCalled();
  });

  it('is operational when Human model files are present and detection succeeds', async () => {
    fs.mkdirSync(path.join(tmpDir, 'human'));
    mockCreateFaceDetector.mockResolvedValue({
      detect: jest.fn().mockResolvedValue({ width: 64, height: 64, faces: [] }),
    });

    const result = await testHuman();
    expect(result.available).toBe(true);
    expect(result.detail).toMatch(/ran end-to-end/);
    expect(mockCreateFaceDetector).toHaveBeenCalledWith({
      modelBasePath: path.join(tmpDir, 'human'),
    });
  });

  it('honors FACE_HUMAN_MODEL_PATH as an override', async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-human-override-'));
    process.env['FACE_HUMAN_MODEL_PATH'] = overrideDir;
    mockCreateFaceDetector.mockResolvedValue({
      detect: jest.fn().mockResolvedValue({ width: 64, height: 64, faces: [] }),
    });

    try {
      const result = await testHuman();
      expect(result.available).toBe(true);
      expect(mockCreateFaceDetector).toHaveBeenCalledWith({ modelBasePath: overrideDir });
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it('downgrades to unavailable (never throws) when detection throws', async () => {
    fs.mkdirSync(path.join(tmpDir, 'human'));
    mockCreateFaceDetector.mockRejectedValue(new Error('model load failed'));

    const result = await testHuman();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/Human self-test failed/);
  });
});

// ---------------------------------------------------------------------------
// testTesseract
// ---------------------------------------------------------------------------

describe('testTesseract', () => {
  it('reports not-yet-operational (graceful skip) when language data is absent', async () => {
    const result = await testTesseract();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/language data not present/);
    expect(mockCreateOcrEngine).not.toHaveBeenCalled();
  });

  it('is operational when language data is present and init/terminate succeed', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tesseract'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tesseract', 'eng.traineddata'), Buffer.from('fake'));
    const terminate = jest.fn().mockResolvedValue(undefined);
    mockCreateOcrEngine.mockResolvedValue({ languages: ['eng'], recognizeFrame: jest.fn(), terminate });

    const result = await testTesseract();
    expect(result.available).toBe(true);
    expect(result.detail).toMatch(/init\/terminate ok/);
    expect(terminate).toHaveBeenCalled();
  });

  it('accepts a gzipped traineddata file as present', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tesseract'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tesseract', 'eng.traineddata.gz'), Buffer.from('fake'));
    mockCreateOcrEngine.mockResolvedValue({
      languages: ['eng'],
      recognizeFrame: jest.fn(),
      terminate: jest.fn().mockResolvedValue(undefined),
    });

    const result = await testTesseract();
    expect(result.available).toBe(true);
  });

  it('downgrades to unavailable (never throws) when engine creation fails', async () => {
    fs.mkdirSync(path.join(tmpDir, 'tesseract'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'tesseract', 'eng.traineddata'), Buffer.from('fake'));
    mockCreateOcrEngine.mockRejectedValue(new Error('worker init failed'));

    const result = await testTesseract();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/tesseract self-test failed/);
  });
});

// ---------------------------------------------------------------------------
// runOperationalSelfTests — orchestration
// ---------------------------------------------------------------------------

describe('runOperationalSelfTests', () => {
  it('only exercises capabilities reported present, passing the rest through unchanged', async () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      onnxruntime: { available: false, detail: 'onnxruntime-node not installed' },
      human: { available: false, detail: '@vladmandic/human not installed' },
      tesseract: { available: false, detail: 'tesseract.js not installed' },
      ffmpeg: { available: true, detail: 'ffmpeg on PATH' },
      ffprobe: { available: false, detail: 'ffprobe not found on PATH' },
    };

    const result = await runOperationalSelfTests(caps);

    // sharp was present → really exercised (real, unmocked self-test).
    expect(result['sharp']?.available).toBe(true);
    expect(result['sharp']?.detail).toMatch(/roundtrip ok/);

    // Everything else was NOT present → passed through unchanged, and no
    // mocked compute function was invoked.
    expect(result['onnxruntime']).toEqual(caps['onnxruntime']);
    expect(result['human']).toEqual(caps['human']);
    expect(result['tesseract']).toEqual(caps['tesseract']);
    expect(result['ffmpeg']).toEqual(caps['ffmpeg']);
    expect(result['ffprobe']).toEqual(caps['ffprobe']);
    expect(mockCreateClipSession).not.toHaveBeenCalled();
    expect(mockCreateFaceDetector).not.toHaveBeenCalled();
    expect(mockCreateOcrEngine).not.toHaveBeenCalled();
  });

  it('exercises every present capability and downgrades ones that fail their self-test', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clip-vit-b32-vision-quantized.onnx'), Buffer.from([0x08]));
    mockCreateClipSession.mockResolvedValue({ fake: 'session' });
    mockEmbedImageWithSession.mockResolvedValue(new Array(512).fill(0));

    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      onnxruntime: { available: true, detail: 'onnxruntime-node' },
      human: { available: true, detail: '@vladmandic/human' }, // model dir absent → downgraded
      tesseract: { available: true, detail: 'tesseract.js' }, // lang data absent → downgraded
    };

    const result = await runOperationalSelfTests(caps);

    expect(result['sharp']?.available).toBe(true);
    expect(result['onnxruntime']?.available).toBe(true);
    expect(result['human']?.available).toBe(false);
    expect(result['human']?.detail).toMatch(/not present/);
    expect(result['tesseract']?.available).toBe(false);
    expect(result['tesseract']?.detail).toMatch(/language data not present/);
  });
});
