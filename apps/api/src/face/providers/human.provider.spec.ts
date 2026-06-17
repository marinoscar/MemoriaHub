/**
 * Unit tests for HumanProvider.
 *
 * All heavy deps (@tensorflow/tfjs, @tensorflow/tfjs-backend-wasm,
 * @vladmandic/human, sharp) are mocked so no WASM or GPU code runs.
 *
 * Singleton note: humanInstance is module-level. After the first successful
 * getHuman() call the cached instance is re-used for the lifetime of the test
 * file. Tests that need a *fresh* module (e.g. simulating init failure) use
 * jest.isolateModules / jest.doMock.
 *
 * Mock strategy: the provider loads @vladmandic/human's WASM build via an
 * ABSOLUTE path (require.resolve('@vladmandic/human') → dirname → node-wasm.js)
 * to bypass the package's exports map. A virtual mock keyed to the bare specifier
 * string is never invoked for that absolute require. We therefore compute the
 * same absolute path here and use jest.doMock (not hoisted) so it intercepts
 * the exact path the provider uses.
 */

// ---------------------------------------------------------------------------
// Compute the absolute path the provider will require at module load time.
// We derive it the same way human.provider.ts does:
//   require.resolve('@vladmandic/human') → .../dist/human.node.js
//   dirname(^) + '/human.node-wasm.js'  → .../dist/human.node-wasm.js
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodePath = require('path') as typeof import('path');
const humanWasmAbsPath = nodePath.join(
  nodePath.dirname(require.resolve('@vladmandic/human')),
  'human.node-wasm.js',
);

// ---------------------------------------------------------------------------
// Mock instances — declared before doMock calls so the factory closures
// can reference them. (jest.doMock is NOT hoisted so normal closure rules apply.)
// ---------------------------------------------------------------------------

const mockHumanDetect = jest.fn();
const mockHumanLoad = jest.fn().mockResolvedValue(undefined);
const mockHumanWarmup = jest.fn().mockResolvedValue(undefined);
const MockHumanClass = jest.fn().mockImplementation(() => ({
  load: mockHumanLoad,
  warmup: mockHumanWarmup,
  detect: mockHumanDetect,
}));

const mockSharpInstance = {
  ensureAlpha: jest.fn().mockReturnThis(),
  raw: jest.fn().mockReturnThis(),
  toBuffer: jest.fn(),
};

// ---------------------------------------------------------------------------
// Register mocks via jest.doMock (not hoisted; fires before the first require
// of the module under test, which happens in beforeAll below).
// ---------------------------------------------------------------------------

jest.doMock('@tensorflow/tfjs', () => ({
  setBackend: jest.fn().mockResolvedValue(undefined),
  ready: jest.fn().mockResolvedValue(undefined),
  tensor3d: jest.fn().mockReturnValue({ dispose: jest.fn() }),
}), { virtual: true });

jest.doMock('@tensorflow/tfjs-backend-wasm', () => ({}), { virtual: true });

// Mock the WASM build at its resolved absolute path — this is what the provider
// actually requires at module load time.
jest.doMock(humanWasmAbsPath, () => ({
  Human: MockHumanClass,
  default: MockHumanClass,
}));

jest.doMock('sharp', () => jest.fn().mockReturnValue(mockSharpInstance));

// ---------------------------------------------------------------------------
// Import provider AFTER mocks are registered (dynamic require; NOT a static
// top-level import, because static imports are hoisted above jest.doMock calls).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
let HumanProvider: typeof import('./human.provider').HumanProvider;

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ HumanProvider } = require('./human.provider') as typeof import('./human.provider'));
});

// ---------------------------------------------------------------------------

describe('HumanProvider', () => {
  let provider: InstanceType<typeof HumanProvider>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply default resolved values after clearAllMocks resets them
    mockHumanLoad.mockResolvedValue(undefined);
    mockHumanWarmup.mockResolvedValue(undefined);
    provider = new HumanProvider();
  });

  // -------------------------------------------------------------------------
  // Static properties
  // -------------------------------------------------------------------------

  describe('capabilities', () => {
    it('has detect:true, embed:true, delegatedRecognize:false', () => {
      expect(provider.capabilities).toEqual({
        detect: true,
        embed: true,
        delegatedRecognize: false,
      });
    });
  });

  describe('requiresCredentials', () => {
    it('is false', () => {
      expect(provider.requiresCredentials).toBe(false);
    });
  });

  describe('modelVersion', () => {
    it('equals "human-faceres-1024"', () => {
      expect(provider.modelVersion).toBe('human-faceres-1024');
    });
  });

  // -------------------------------------------------------------------------
  // listModels
  // -------------------------------------------------------------------------

  describe('listModels', () => {
    it('returns ["human-faceres-1024"] statically', async () => {
      const result = await provider.listModels({});
      expect(result).toEqual(['human-faceres-1024']);
    });
  });

  // -------------------------------------------------------------------------
  // testConnection
  // -------------------------------------------------------------------------

  describe('testConnection', () => {
    it('returns {ok:true} when Human initialises successfully', async () => {
      // humanInstance may already be cached from prior test runs — that is fine;
      // the cached instance's load/warmup won't be called again but testConnection
      // still awaits getHuman() and returns ok:true.
      mockHumanDetect.mockResolvedValue({ face: [] });

      const result = await provider.testConnection({});

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:false, error:...} when Human init throws', async () => {
      // Use jest.resetModules() + jest.doMock() to get a fresh module where
      // humanInstance is null and tf.setBackend rejects.
      // We restore the original mocks at the end so subsequent tests are not
      // affected.
      jest.resetModules();

      jest.doMock('@tensorflow/tfjs', () => ({
        setBackend: jest.fn().mockRejectedValue(new Error('WASM load failed')),
        ready: jest.fn().mockResolvedValue(undefined),
        tensor3d: jest.fn().mockReturnValue({ dispose: jest.fn() }),
      }), { virtual: true });
      jest.doMock('@tensorflow/tfjs-backend-wasm', () => ({}), { virtual: true });

      // Must use the absolute path here too — same reason as the outer mock.
      jest.doMock(humanWasmAbsPath, () => ({
        Human: jest.fn().mockImplementation(() => ({
          load: jest.fn().mockResolvedValue(undefined),
          warmup: jest.fn().mockResolvedValue(undefined),
          detect: jest.fn(),
        })),
        default: jest.fn(),
      }));
      jest.doMock('sharp', () =>
        jest.fn().mockReturnValue({
          ensureAlpha: jest.fn().mockReturnThis(),
          raw: jest.fn().mockReturnThis(),
          toBuffer: jest.fn().mockResolvedValue({ data: Buffer.alloc(0), info: { width: 1, height: 1 } }),
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { HumanProvider: HumanProviderFresh } = require('./human.provider') as typeof import('./human.provider');

      const freshProvider = new HumanProviderFresh();
      const result = await freshProvider.testConnection({});

      // Restore original mocks so subsequent test groups are unaffected
      jest.resetModules();
      jest.restoreAllMocks();

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/WASM load failed/);
    });
  });

  // -------------------------------------------------------------------------
  // detect
  // -------------------------------------------------------------------------

  describe('detect', () => {
    const fakeImageBuffer = Buffer.from('fake-image');

    it('returns two DetectedFaces with normalised boxes and unit-length embeddings', async () => {
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: Buffer.alloc(200 * 100 * 4),
        info: { width: 200, height: 100 },
      });

      // face[0]: box [10,20,50,50], embedding [3,4]  → norm=5 → [0.6, 0.8]
      // face[1]: box [100,50,30,30], embedding [0,1] → norm=1 → [0, 1]
      mockHumanDetect.mockResolvedValue({
        face: [
          { box: [10, 20, 50, 50], faceScore: 0.9, embedding: [3, 4] },
          { box: [100, 50, 30, 30], faceScore: 0.8, embedding: [0, 1] },
        ],
      });

      const results = await provider.detect({}, fakeImageBuffer);

      expect(results).toHaveLength(2);

      // First face — normalised to image size 200 x 100
      expect(results[0].boundingBox).toEqual({
        x: 10 / 200,
        y: 20 / 100,
        w: 50 / 200,
        h: 50 / 100,
      });
      expect(results[0].confidence).toBeCloseTo(0.9);

      // Embedding must be L2-unit length
      const emb0 = results[0].embedding!;
      const norm0 = Math.sqrt(emb0.reduce((s, v) => s + v * v, 0));
      expect(norm0).toBeCloseTo(1, 5);
      // [3,4] / 5 = [0.6, 0.8]
      expect(emb0[0]).toBeCloseTo(0.6, 5);
      expect(emb0[1]).toBeCloseTo(0.8, 5);

      // Second face
      expect(results[1].boundingBox).toEqual({
        x: 100 / 200,
        y: 50 / 100,
        w: 30 / 200,
        h: 30 / 100,
      });
      const emb1 = results[1].embedding!;
      const norm1 = Math.sqrt(emb1.reduce((s, v) => s + v * v, 0));
      expect(norm1).toBeCloseTo(1, 5);
    });

    it('returns [] when no faces detected', async () => {
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: Buffer.alloc(100 * 100 * 4),
        info: { width: 100, height: 100 },
      });
      mockHumanDetect.mockResolvedValue({ face: [] });

      const results = await provider.detect({}, fakeImageBuffer);

      expect(results).toEqual([]);
    });

    it('returns face with undefined embedding when face has no embedding', async () => {
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: Buffer.alloc(100 * 100 * 4),
        info: { width: 100, height: 100 },
      });
      mockHumanDetect.mockResolvedValue({
        face: [{ box: [0, 0, 10, 10], faceScore: 0.7 }],
      });

      const results = await provider.detect({}, fakeImageBuffer);

      expect(results).toHaveLength(1);
      expect(results[0].embedding).toBeUndefined();
    });

    it('calls h.detect and completes without error (tensor lifecycle)', async () => {
      // Verifies the detect→dispose flow completes without throwing.
      // The module uses a try/finally to dispose the tensor; if dispose were
      // missing the process would leak memory but not error, so we simply
      // assert the full round-trip returns the expected shape.
      mockSharpInstance.toBuffer.mockResolvedValue({
        data: Buffer.alloc(50 * 50 * 4),
        info: { width: 50, height: 50 },
      });
      mockHumanDetect.mockResolvedValue({ face: [] });

      const results = await provider.detect({}, fakeImageBuffer);

      expect(mockHumanDetect).toHaveBeenCalledTimes(1);
      expect(results).toEqual([]);
    });
  });
});
