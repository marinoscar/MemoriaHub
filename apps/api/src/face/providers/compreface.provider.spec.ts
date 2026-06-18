/**
 * Unit tests for ComprefaceProvider (keyless CompreFace Core engine).
 *
 * Uses global fetch mock — no real HTTP calls.
 * The provider is keyless: no x-api-key header, no apiKey in credentials.
 * baseUrl resolution: creds.baseUrl → FACE_COMPREFACE_URL env → default.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { ComprefaceProvider } from './compreface.provider';
import type { FaceProviderCredentials } from './face-provider.interface';

// Credentials that supply a custom baseUrl (no apiKey needed)
const credsWithBaseUrl: FaceProviderCredentials = {
  baseUrl: 'http://compreface-core:3000',
};

// Credentials with no baseUrl — provider must fall back to env/default
const emptyCreds: FaceProviderCredentials = {};

describe('ComprefaceProvider', () => {
  let provider: ComprefaceProvider;
  let originalEnv: string | undefined;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ComprefaceProvider();
    originalEnv = process.env.FACE_COMPREFACE_URL;
    delete process.env.FACE_COMPREFACE_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FACE_COMPREFACE_URL;
    } else {
      process.env.FACE_COMPREFACE_URL = originalEnv;
    }
  });

  // ---------------------------------------------------------------------------
  // Static properties
  // ---------------------------------------------------------------------------
  describe('requiresCredentials', () => {
    it('is false (keyless provider)', () => {
      expect(provider.requiresCredentials).toBe(false);
    });
  });

  describe('modelVersion', () => {
    it('equals "compreface-arcface-mobilefacenet-128"', () => {
      expect(provider.modelVersion).toBe('compreface-arcface-mobilefacenet-128');
    });
  });

  // ---------------------------------------------------------------------------
  // capabilities
  // ---------------------------------------------------------------------------
  describe('capabilities', () => {
    it('has detect:true, embed:true, delegatedRecognize:false', () => {
      expect(provider.capabilities).toEqual({
        detect: true,
        embed: true,
        delegatedRecognize: false,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // listModels
  // ---------------------------------------------------------------------------
  describe('listModels', () => {
    it('returns ["compreface-arcface-mobilefacenet-128"] statically', async () => {
      const result = await provider.listModels(credsWithBaseUrl);
      expect(result).toEqual(['compreface-arcface-mobilefacenet-128']);
    });

    it('returns the model version without querying the network', async () => {
      const result = await provider.listModels(emptyCreds);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toEqual(['compreface-arcface-mobilefacenet-128']);
    });
  });

  // ---------------------------------------------------------------------------
  // baseUrl resolution
  // ---------------------------------------------------------------------------
  describe('baseUrl resolution', () => {
    it('uses creds.baseUrl when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await provider.detect({ baseUrl: 'http://custom-host:9999' }, Buffer.from('img'));

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://custom-host:9999');
    });

    it('falls back to FACE_COMPREFACE_URL env when creds has no baseUrl', async () => {
      process.env.FACE_COMPREFACE_URL = 'http://from-env:4242';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await provider.detect(emptyCreds, Buffer.from('img'));

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://from-env:4242');
    });

    it('falls back to hard-coded default http://compreface-core:3000 when no creds or env', async () => {
      // FACE_COMPREFACE_URL is unset in beforeEach
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      await provider.detect(emptyCreds, Buffer.from('img'));

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://compreface-core:3000');
    });
  });

  // ---------------------------------------------------------------------------
  // detect
  // ---------------------------------------------------------------------------
  describe('detect', () => {
    const testImage = Buffer.from('fake-image-data');

    // Helper: build a minimal CompreFace core detect response
    function makeDetectResponse(
      faces: Array<{
        x_min: number;
        y_min: number;
        x_max: number;
        y_max: number;
        probability: number;
        embedding?: number[];
      }>,
    ) {
      return {
        result: faces.map(f => ({
          box: {
            x_min: f.x_min,
            y_min: f.y_min,
            x_max: f.x_max,
            y_max: f.y_max,
            probability: f.probability,
          },
          ...(f.embedding !== undefined && { embedding: f.embedding }),
        })),
      };
    }

    it('POSTs to {baseUrl}/find_faces with face_plugins=calculator query param', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeDetectResponse([]),
      });

      await provider.detect(credsWithBaseUrl, testImage);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/find_faces');
      expect(calledUrl).toContain('face_plugins=calculator');
    });

    it('POSTs to {baseUrl}/find_faces with det_prob_threshold=0.8 query param', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeDetectResponse([]),
      });

      await provider.detect(credsWithBaseUrl, testImage);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('det_prob_threshold=0.8');
    });

    it('does NOT send x-api-key header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeDetectResponse([]),
      });

      await provider.detect(credsWithBaseUrl, testImage);

      const callOptions = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = callOptions?.headers as Record<string, string> | undefined;
      // headers may be undefined (no headers set) or an object without x-api-key
      if (headers) {
        expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('x-api-key');
      }
      // If headers is undefined, the assertion passes trivially — no key was sent.
    });

    it('sends the image as multipart form data with field name "file"', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeDetectResponse([]),
      });

      await provider.detect(credsWithBaseUrl, testImage);

      const callOptions = mockFetch.mock.calls[0][1] as RequestInit;
      expect(callOptions.method).toBe('POST');
      expect(callOptions.body).toBeInstanceOf(FormData);
      const form = callOptions.body as FormData;
      expect(form.get('file')).toBeTruthy();
    });

    it('maps CompreFace core box fields to {x,y,w,h} bounding box', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () =>
          makeDetectResponse([
            { x_min: 10, y_min: 20, x_max: 110, y_max: 120, probability: 0.99 },
          ]),
      });

      const results = await provider.detect(credsWithBaseUrl, testImage);

      expect(results).toHaveLength(1);
      expect(results[0].boundingBox).toEqual({ x: 10, y: 20, w: 100, h: 100 });
    });

    it('maps confidence from box.probability', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () =>
          makeDetectResponse([
            { x_min: 0, y_min: 0, x_max: 50, y_max: 50, probability: 0.87 },
          ]),
      });

      const results = await provider.detect(credsWithBaseUrl, testImage);

      expect(results[0].confidence).toBeCloseTo(0.87);
    });

    it('L2-normalizes the embedding (128-element fixture) when present', async () => {
      // Build a 128-element raw embedding — all 1s, norm = sqrt(128)
      const rawEmbedding = new Array(128).fill(1);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () =>
          makeDetectResponse([
            {
              x_min: 0,
              y_min: 0,
              x_max: 10,
              y_max: 10,
              probability: 0.9,
              embedding: rawEmbedding,
            },
          ]),
      });

      const results = await provider.detect(credsWithBaseUrl, testImage);

      const emb = results[0].embedding!;
      expect(emb).toBeDefined();
      expect(emb).toHaveLength(128);

      // Must be unit length after L2 normalization
      const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('L2-normalizes a small embedding correctly ([3,4] → [0.6,0.8])', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () =>
          makeDetectResponse([
            {
              x_min: 0,
              y_min: 0,
              x_max: 10,
              y_max: 10,
              probability: 0.9,
              embedding: [3, 4],
            },
          ]),
      });

      const results = await provider.detect(credsWithBaseUrl, testImage);

      const emb = results[0].embedding!;
      expect(emb[0]).toBeCloseTo(0.6, 5);
      expect(emb[1]).toBeCloseTo(0.8, 5);
    });

    it('returns empty array when result is []', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      const results = await provider.detect(credsWithBaseUrl, testImage);

      expect(results).toEqual([]);
    });

    it('throws when fetch returns non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.detect(credsWithBaseUrl, testImage)).rejects.toThrow(/500/);
    });

    it('returns [] when CompreFace 400 indicates no face found', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"message":"400 Bad Request: No face is found in the given image"}',
      });

      await expect(provider.detect(credsWithBaseUrl, testImage)).resolves.toEqual([]);
    });

    it('throws when CompreFace 400 has a different error message', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"message":"Bad image format or unsupported file type"}',
      });

      await expect(provider.detect(credsWithBaseUrl, testImage)).rejects.toThrow();
    });

    it('throws when fetch returns 500', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.detect(credsWithBaseUrl, testImage)).rejects.toThrow(/500/);
    });

    it('does NOT require an apiKey — detect succeeds with empty creds (uses default baseUrl)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => makeDetectResponse([]),
      });

      // Should not throw even with no credentials at all
      await expect(provider.detect(emptyCreds, testImage)).resolves.toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe('testConnection', () => {
    it('calls GET {baseUrl}/status (no body, no x-api-key)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'OK' }),
      });

      await provider.testConnection(credsWithBaseUrl);

      const [calledUrl, callOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe('http://compreface-core:3000/status');
      expect(callOptions.method).toBe('GET');

      const headers = callOptions?.headers as Record<string, string> | undefined;
      if (headers) {
        expect(Object.keys(headers).map(k => k.toLowerCase())).not.toContain('x-api-key');
      }
    });

    it('returns {ok:true} when HTTP 200 and body.status === "OK"', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'OK' }),
      });

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:false, error:...} when HTTP 200 but body.status !== "OK"', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'LOADING' }),
      });

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/LOADING/);
    });

    it('returns {ok:false, error:...} when HTTP 200 but body has no status field', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ available_plugins: {} }),
      });

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result.ok).toBe(false);
    });

    it('returns {ok:false, error:...} when fetch returns non-200 (e.g. 503)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
      });

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/503/);
    });

    it('returns {ok:false, error:...} when fetch returns 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/401/);
    });

    it('returns {ok:false, error:...} when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.testConnection(credsWithBaseUrl);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNREFUSED/);
    });

    it('uses default baseUrl when creds is empty (no x-api-key either)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'OK' }),
      });

      const result = await provider.testConnection(emptyCreds);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://compreface-core:3000/status');
      expect(result).toEqual({ ok: true });
    });

    it('uses FACE_COMPREFACE_URL env as baseUrl when no creds.baseUrl', async () => {
      process.env.FACE_COMPREFACE_URL = 'http://env-host:5555';

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'OK' }),
      });

      await provider.testConnection(emptyCreds);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('http://env-host:5555/status');
    });
  });
});
