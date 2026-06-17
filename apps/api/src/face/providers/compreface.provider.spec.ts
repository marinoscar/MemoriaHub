/**
 * Unit tests for ComprefaceProvider.
 *
 * Uses global fetch mock — no real HTTP calls.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { ComprefaceProvider } from './compreface.provider';
import type { FaceProviderCredentials } from './face-provider.interface';

const validCreds: FaceProviderCredentials = {
  apiKey: 'test-api-key',
  baseUrl: 'http://compreface:8000',
};

describe('ComprefaceProvider', () => {
  let provider: ComprefaceProvider;

  beforeEach(() => {
    mockFetch.mockReset();
    provider = new ComprefaceProvider();
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
    it('returns ["arcface-r100-v1"] statically', async () => {
      const result = await provider.listModels(validCreds);
      expect(result).toEqual(['arcface-r100-v1']);
    });
  });

  // ---------------------------------------------------------------------------
  // detect
  // ---------------------------------------------------------------------------
  describe('detect', () => {
    const testImage = Buffer.from('fake-image-data');

    it('parses CompreFace bounding box correctly', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              box: { x_min: 10, y_min: 20, x_max: 110, y_max: 120, probability: 0.99 },
            },
          ],
        }),
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results).toHaveLength(1);
      expect(results[0].boundingBox).toEqual({ x: 10, y: 20, w: 100, h: 100 });
    });

    it('maps confidence from box.probability', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              box: { x_min: 0, y_min: 0, x_max: 50, y_max: 50, probability: 0.87 },
            },
          ],
        }),
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results[0].confidence).toBeCloseTo(0.87);
    });

    it('L2-normalizes the embedding when present', async () => {
      const rawEmbedding = [3, 4]; // norm = 5; normalized = [0.6, 0.8]
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          result: [
            {
              box: { x_min: 0, y_min: 0, x_max: 10, y_max: 10, probability: 0.9 },
              embedding: rawEmbedding,
            },
          ],
        }),
      });

      const results = await provider.detect(validCreds, testImage);

      const emb = results[0].embedding!;
      expect(emb).toBeDefined();
      const norm = Math.sqrt(emb.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    });

    it('returns empty array when result is []', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ result: [] }),
      });

      const results = await provider.detect(validCreds, testImage);

      expect(results).toEqual([]);
    });

    it('throws when fetch returns non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(provider.detect(validCreds, testImage)).rejects.toThrow(/500/);
    });

    it('throws when baseUrl is missing', async () => {
      const creds: FaceProviderCredentials = { apiKey: 'key' };
      await expect(provider.detect(creds, testImage)).rejects.toThrow(/baseUrl/i);
    });

    it('throws when apiKey is missing', async () => {
      const creds: FaceProviderCredentials = { baseUrl: 'http://compreface:8000' };
      await expect(provider.detect(creds, testImage)).rejects.toThrow(/apiKey/i);
    });
  });

  // ---------------------------------------------------------------------------
  // testConnection
  // ---------------------------------------------------------------------------
  describe('testConnection', () => {
    it('returns {ok:false, error:...} when baseUrl is missing', async () => {
      const result = await provider.testConnection({ apiKey: 'key' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/baseUrl/i);
    });

    it('returns {ok:false, error:...} when apiKey is missing', async () => {
      const result = await provider.testConnection({ baseUrl: 'http://compreface:8000' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/apiKey/i);
    });

    it('returns {ok:true} when fetch returns 200', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      const result = await provider.testConnection(validCreds);

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:true} when fetch returns 400 (no face found proves connectivity)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400 });

      const result = await provider.testConnection(validCreds);

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:true} for other 4xx non-auth errors (e.g. 422)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 422 });

      const result = await provider.testConnection(validCreds);

      expect(result).toEqual({ ok: true });
    });

    it('returns {ok:false, error:...} when fetch returns 401', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      const result = await provider.testConnection(validCreds);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/401/);
    });

    it('returns {ok:false, error:...} when fetch returns 403', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403 });

      const result = await provider.testConnection(validCreds);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/403/);
    });

    it('returns {ok:false, error:...} when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await provider.testConnection(validCreds);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNREFUSED/);
    });
  });
});
