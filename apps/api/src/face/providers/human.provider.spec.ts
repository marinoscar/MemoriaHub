/**
 * Unit tests for HumanProvider.
 *
 * All heavy deps (@tensorflow/tfjs, @tensorflow/tfjs-backend-wasm,
 * @vladmandic/human, sharp) are mocked so no WASM or GPU code runs.
 *
 * Isolation strategy: every test starts with a fresh module registry.
 * beforeEach calls jest.resetModules(), re-registers ALL doMocks, and THEN
 * requires + instantiates HumanProvider. This guarantees the provider's
 * top-level require() calls always hit the mocks — even when Jest runs
 * multiple spec files in the same worker.
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
// Mock fn references — declared at top level so factory closures can reference
// them across beforeEach re-registrations.
// ---------------------------------------------------------------------------

const mockHumanDetect = jest.fn();
const mockHumanLoad = jest.fn();
const mockHumanWarmup = jest.fn();
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
// Helper: register all mocks into the current (freshly reset) module registry.
// Called from beforeEach after jest.resetModules() so every test gets a clean
// provider module with every dep mocked before the first require().
// ---------------------------------------------------------------------------

function registerAllMocks(): void {
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

  // Belt-and-suspenders: also mock the bare specifier in case any indirect
  // require uses it.
  jest.doMock('@vladmandic/human', () => ({
    Human: MockHumanClass,
    default: MockHumanClass,
  }));

  jest.doMock('sharp', () => jest.fn().mockReturnValue(mockSharpInstance));
}

// ---------------------------------------------------------------------------
// Provider instance — populated fresh in every beforeEach.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let provider: any;

beforeEach(() => {
  // 1. Wipe the module registry so no cached real modules survive.
  jest.resetModules();

  // 2. Reset all mock fn state.
  jest.clearAllMocks();

  // 3. Re-apply default resolved values (clearAllMocks removed them).
  mockHumanLoad.mockResolvedValue(undefined);
  mockHumanWarmup.mockResolvedValue(undefined);
  mockHumanDetect.mockResolvedValue({ face: [] });

  // 4. Register every mock into the fresh registry BEFORE the provider is loaded.
  registerAllMocks();

  // 5. Now require and instantiate — provider's top-level requires hit the mocks.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HumanProvider } = require('./human.provider') as typeof import('./human.provider');
  provider = new HumanProvider();
});

afterEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('HumanProvider', () => {
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
      // mockHumanLoad already resolves (set in beforeEach); just ensure detect
      // also resolves so getHuman() completes and testConnection returns ok:true.
      mockHumanDetect.mockResolvedValue({ face: [] });

      const result = await provider.testConnection({});

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:false, error:...} when Human init throws', async () => {
      // The provider uses a lazy singleton (getHuman). Because beforeEach already
      // created a fresh provider (no calls made yet), humanInstance is still null
      // in this module copy. We override mockHumanLoad to reject BEFORE the first
      // call to testConnection(), which internally calls getHuman() → h.load().
      mockHumanLoad.mockRejectedValueOnce(new Error('WASM load failed'));

      const result = await provider.testConnection({});

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
      const norm0 = Math.sqrt(emb0.reduce((s: number, v: number) => s + v * v, 0));
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
      const norm1 = Math.sqrt(emb1.reduce((s: number, v: number) => s + v * v, 0));
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
