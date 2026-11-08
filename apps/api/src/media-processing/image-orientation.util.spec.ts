/**
 * Unit tests for image-orientation.util.ts
 *
 * Tests prepareImageForProcessing and getOrientedDimensions with a mocked sharp,
 * including orientation-swap logic and fallback/error paths.
 */

// ---------------------------------------------------------------------------
// Sharp mock — must be at top so Jest hoisting picks it up.
// We use __esModule: true so that dynamic import('sharp').default resolves
// to the `default` export, which is the jest.fn() below.
// ---------------------------------------------------------------------------

jest.mock('sharp', () => {
  const mockPipelineFactory = jest.fn();
  return {
    __esModule: true,
    default: mockPipelineFactory,
  };
});

import { prepareImageForProcessing, getOrientedDimensions } from './image-orientation.util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSharpDefault(): jest.Mock {
  return jest.requireMock('sharp').default as jest.Mock;
}

function makePipeline(overrides: {
  toBufferResult?: { data: Buffer; info: { width: number; height: number } };
  metadataResult?: { width?: number; height?: number; orientation?: number };
  toBufferError?: Error;
  metadataError?: Error;
} = {}) {
  const toBufferResult = overrides.toBufferResult ?? {
    data: Buffer.from('processed'),
    info: { width: 1000, height: 800 },
  };
  const metadataResult = overrides.metadataResult ?? { width: 1000, height: 800, orientation: 1 };

  return {
    rotate: jest.fn().mockReturnThis(),
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: overrides.toBufferError
      ? jest.fn().mockRejectedValue(overrides.toBufferError)
      : jest.fn().mockResolvedValue(toBufferResult),
    metadata: overrides.metadataError
      ? jest.fn().mockRejectedValue(overrides.metadataError)
      : jest.fn().mockResolvedValue(metadataResult),
  };
}

// ---------------------------------------------------------------------------
// Tests: prepareImageForProcessing
// ---------------------------------------------------------------------------

describe('prepareImageForProcessing', () => {
  let sharpDefault: jest.Mock;

  beforeEach(() => {
    sharpDefault = getSharpDefault();
    sharpDefault.mockClear();
    sharpDefault.mockReturnValue(makePipeline());
  });

  it('calls sharp with input buffer, chains rotate, jpeg and toBuffer', async () => {
    const input = Buffer.from('input');
    await prepareImageForProcessing(input);

    expect(sharpDefault).toHaveBeenCalledWith(input);
    const pipeline = sharpDefault.mock.results[0].value;
    expect(pipeline.rotate).toHaveBeenCalled();
    expect(pipeline.jpeg).toHaveBeenCalledWith({ quality: 90 });
    expect(pipeline.toBuffer).toHaveBeenCalledWith({ resolveWithObject: true });
  });

  it('returns buffer and dims from sharp toBuffer info', async () => {
    const processedData = Buffer.from('processed-data');
    sharpDefault.mockReturnValue(
      makePipeline({
        toBufferResult: { data: processedData, info: { width: 640, height: 480 } },
      }),
    );

    const result = await prepareImageForProcessing(Buffer.from('input'));

    expect(result.buffer).toBe(processedData);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
  });

  it('calls resize with maxDim when opts.maxDim is provided', async () => {
    const input = Buffer.from('input');
    await prepareImageForProcessing(input, { maxDim: 512 });

    const pipeline = sharpDefault.mock.results[0].value;
    expect(pipeline.resize).toHaveBeenCalledWith({
      width: 512,
      height: 512,
      fit: 'inside',
      withoutEnlargement: true,
    });
  });

  it('does NOT call resize when opts.maxDim is not provided', async () => {
    await prepareImageForProcessing(Buffer.from('input'));

    const pipeline = sharpDefault.mock.results[0].value;
    expect(pipeline.resize).not.toHaveBeenCalled();
  });

  it('does NOT call resize when opts is provided without maxDim', async () => {
    await prepareImageForProcessing(Buffer.from('input'), {});

    const pipeline = sharpDefault.mock.results[0].value;
    expect(pipeline.resize).not.toHaveBeenCalled();
  });

  it('returns { buffer: original, width: 0, height: 0 } when sharp throws', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ toBufferError: new Error('corrupt image') }),
    );

    const original = Buffer.from('raw-bytes');
    const result = await prepareImageForProcessing(original);

    expect(result.buffer).toBe(original);
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });

  it('never throws even when sharp fails', async () => {
    sharpDefault.mockImplementation(() => {
      throw new Error('sharp init failed');
    });

    await expect(prepareImageForProcessing(Buffer.from('x'))).resolves.toBeDefined();
  });

  it('never throws when sharp constructor itself throws', async () => {
    sharpDefault.mockImplementation(() => {
      throw new Error('cannot load sharp');
    });

    const result = await prepareImageForProcessing(Buffer.from('raw'));
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: getOrientedDimensions
// ---------------------------------------------------------------------------

describe('getOrientedDimensions', () => {
  let sharpDefault: jest.Mock;

  beforeEach(() => {
    sharpDefault = getSharpDefault();
    sharpDefault.mockClear();
    sharpDefault.mockReturnValue(makePipeline());
  });

  it('returns original dims when orientation is 1 (no rotation)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 1920, height: 1080, orientation: 1 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('returns original dims when orientation is undefined', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 800, height: 600 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 800, height: 600 });
  });

  it('returns original dims when orientation is 2 (horizontal flip)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 1920, height: 1080, orientation: 2 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('returns original dims when orientation is 3 (180°)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 1920, height: 1080, orientation: 3 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('returns original dims when orientation is 4 (vertical flip)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 1920, height: 1080, orientation: 4 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 1920, height: 1080 });
  });

  it('does NOT swap for orientation 2, 3, or 4 (flips, 180°)', async () => {
    for (const orientation of [2, 3, 4]) {
      sharpDefault.mockReturnValue(
        makePipeline({ metadataResult: { width: 1920, height: 1080, orientation } }),
      );
      const result = await getOrientedDimensions(Buffer.from('img'));
      expect(result).toEqual({ width: 1920, height: 1080 });
    }
  });

  it('swaps width and height when orientation is 5', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 4000, height: 3000, orientation: 5 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 3000, height: 4000 });
  });

  it('swaps width and height when orientation is 6 (90° CW)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 4000, height: 2252, orientation: 6 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 2252, height: 4000 });
  });

  it('swaps width and height when orientation is 7', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 4000, height: 3000, orientation: 7 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 3000, height: 4000 });
  });

  it('swaps width and height when orientation is 8 (90° CCW)', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 4000, height: 3000, orientation: 8 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toEqual({ width: 3000, height: 4000 });
  });

  it('returns null when meta.width is undefined', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { height: 600 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toBeNull();
  });

  it('returns null when meta.height is undefined', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 800 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toBeNull();
  });

  it('returns null when sharp throws', async () => {
    sharpDefault.mockReturnValue(
      makePipeline({ metadataError: new Error('cannot read metadata') }),
    );

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toBeNull();
  });

  it('returns null when sharp constructor throws', async () => {
    sharpDefault.mockImplementation(() => {
      throw new Error('sharp init error');
    });

    const result = await getOrientedDimensions(Buffer.from('img'));

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // REGRESSION guard: orientation 6 must swap axes
  // If this logic is removed, this test is the CI tripwire.
  // -------------------------------------------------------------------------
  it('REGRESSION: orientation 6 image (raw 4000x2252) returns display dims 2252x4000', async () => {
    // A portrait photo taken on a phone: stored as 4000px wide, 2252px tall
    // with EXIF orientation=6 (needs 90° CW rotation to display upright).
    // The display (user-visible) dimensions must be width=2252, height=4000.
    sharpDefault.mockReturnValue(
      makePipeline({ metadataResult: { width: 4000, height: 2252, orientation: 6 } }),
    );

    const result = await getOrientedDimensions(Buffer.from('portrait-photo'));

    expect(result).not.toBeNull();
    expect(result!.width).toBe(2252);
    expect(result!.height).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// Tests: applyOrientationTransform — REAL sharp round-trip
//
// Unlike the suites above, these tests exercise the real `sharp` native
// binary rather than the module-level `jest.mock('sharp', ...)` at the top
// of this file. A destructive rotate/flip is exactly the kind of logic that
// a hand-rolled mock could get subtly wrong (e.g. asserting rotate(90) was
// called without verifying the actual output pixels are rotated), so this
// suite temporarily unmocks 'sharp' and re-requires a fresh copy of the
// module under test so its internal `await import('sharp')` resolves to the
// real, unmocked package.
//
// If the native sharp binary cannot run in this sandbox, these tests will
// fail/error at the `beforeAll` or first `it` — see the task report for
// whether that happened here.
// ---------------------------------------------------------------------------

describe('applyOrientationTransform (real sharp round-trip)', () => {
  let realApplyOrientationTransform: typeof import('./image-orientation.util').applyOrientationTransform;
  let realSharp: typeof import('sharp').default;

  beforeAll(() => {
    jest.resetModules();
    jest.unmock('sharp');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    realSharp = require('sharp').default ?? require('sharp');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    realApplyOrientationTransform = require('./image-orientation.util').applyOrientationTransform;
  });

  afterAll(() => {
    // Restore module registry state; the mocked `sharp` import at the top of
    // this file is re-applied automatically the next time a fresh test file
    // loads it, so no explicit re-mock is needed here since this is the last
    // suite in the file.
    jest.resetModules();
  });

  async function makeTestJpeg(width: number, height: number): Promise<Buffer> {
    return realSharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 50, b: 50 },
      },
    })
      .jpeg()
      .toBuffer();
  }

  it('rotate_left swaps dimensions (4x2 -> 2x4) and re-encodes as a valid JPEG', async () => {
    const input = await makeTestJpeg(4, 2);

    const result = await realApplyOrientationTransform(input, 'rotate_left');

    expect(result.width).toBe(2);
    expect(result.height).toBe(4);

    const meta = await realSharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(4);
  });

  it('rotate_right swaps dimensions (4x2 -> 2x4) and re-encodes as a valid JPEG', async () => {
    const input = await makeTestJpeg(4, 2);

    const result = await realApplyOrientationTransform(input, 'rotate_right');

    expect(result.width).toBe(2);
    expect(result.height).toBe(4);

    const meta = await realSharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(4);
  });

  it('flip_horizontal keeps dimensions (4x2 -> 4x2) and re-encodes as a valid JPEG', async () => {
    const input = await makeTestJpeg(4, 2);

    const result = await realApplyOrientationTransform(input, 'flip_horizontal');

    expect(result.width).toBe(4);
    expect(result.height).toBe(2);

    const meta = await realSharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(2);
  });

  it('flip_vertical keeps dimensions (4x2 -> 4x2) and re-encodes as a valid JPEG', async () => {
    const input = await makeTestJpeg(4, 2);

    const result = await realApplyOrientationTransform(input, 'flip_vertical');

    expect(result.width).toBe(4);
    expect(result.height).toBe(2);

    const meta = await realSharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(2);
  });

  it('throws a descriptive error when given bytes that are not a valid image', async () => {
    const garbage = Buffer.from('this is not an image at all');

    await expect(
      realApplyOrientationTransform(garbage, 'rotate_right'),
    ).rejects.toThrow('Image orientation transform failed');
  });
});
