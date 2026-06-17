import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFaceSettings } from '../../hooks/useFaceSettings';

// ---------------------------------------------------------------------------
// Mock the entire face service module so tests are isolated from network
// ---------------------------------------------------------------------------

vi.mock('../../services/face', () => ({
  getFaceSettings: vi.fn(),
  putFaceCredentials: vi.fn(),
  deleteFaceCredentials: vi.fn(),
  testFaceProvider: vi.fn(),
  getFaceModels: vi.fn(),
  putFaceDetectionFeature: vi.fn(),
}));

import {
  getFaceSettings,
  putFaceCredentials,
  deleteFaceCredentials,
  testFaceProvider,
  getFaceModels,
  putFaceDetectionFeature,
} from '../../services/face';
import type { FaceSettingsResponse } from '../../services/face';

const mockGetFaceSettings = vi.mocked(getFaceSettings);
const mockPutFaceCredentials = vi.mocked(putFaceCredentials);
const mockDeleteFaceCredentials = vi.mocked(deleteFaceCredentials);
const mockTestFaceProvider = vi.mocked(testFaceProvider);
const mockGetFaceModels = vi.mocked(getFaceModels);
const mockPutFaceDetectionFeature = vi.mocked(putFaceDetectionFeature);

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const mockSettings: FaceSettingsResponse = {
  providers: [
    {
      provider: 'compreface',
      configured: true,
      enabled: true,
      last4: 'abcd',
      baseUrl: 'http://cf:8000',
      region: null,
      capabilities: { detect: true, embed: true, delegatedRecognize: false },
    },
  ],
  knownProviders: [
    {
      provider: 'rekognition',
      configured: false,
      enabled: false,
      last4: null,
      baseUrl: null,
      region: null,
      capabilities: { detect: true, embed: false, delegatedRecognize: true },
    },
  ],
  features: {
    detection: { provider: 'compreface', model: 'arcface-r100-v1' },
  },
};

// ---------------------------------------------------------------------------

describe('useFaceSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with settings null, loading false, error null', () => {
      // Never-resolving promise keeps loading indefinitely to capture initial state
      mockGetFaceSettings.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useFaceSettings());

      expect(result.current.settings).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('exposes all action functions', () => {
      mockGetFaceSettings.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useFaceSettings());

      expect(typeof result.current.fetchSettings).toBe('function');
      expect(typeof result.current.saveCredentials).toBe('function');
      expect(typeof result.current.removeCredentials).toBe('function');
      expect(typeof result.current.testProvider).toBe('function');
      expect(typeof result.current.getModels).toBe('function');
      expect(typeof result.current.saveDetectionFeature).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  describe('fetchSettings', () => {
    it('sets loading true while fetching, then false after success', async () => {
      let resolve: (v: FaceSettingsResponse) => void;
      const deferred = new Promise<FaceSettingsResponse>((res) => { resolve = res; });
      mockGetFaceSettings.mockReturnValue(deferred);

      const { result } = renderHook(() => useFaceSettings());

      act(() => {
        void result.current.fetchSettings();
      });

      expect(result.current.loading).toBe(true);

      await act(async () => {
        resolve!(mockSettings);
        await deferred;
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
    });

    it('populates settings on success', async () => {
      mockGetFaceSettings.mockResolvedValue(mockSettings);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.settings).toEqual(mockSettings);
      expect(result.current.error).toBeNull();
    });

    it('sets error string on failure (Error instance)', async () => {
      mockGetFaceSettings.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('Network failure');
      expect(result.current.settings).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    it('sets fallback error message for non-Error throws', async () => {
      mockGetFaceSettings.mockRejectedValue('plain string error');

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('Failed to load face settings');
    });

    it('clears previous error on subsequent successful fetch', async () => {
      mockGetFaceSettings.mockRejectedValueOnce(new Error('First failure'));

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('First failure');

      mockGetFaceSettings.mockResolvedValueOnce(mockSettings);

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.settings).toEqual(mockSettings);
    });
  });

  // -------------------------------------------------------------------------
  describe('saveCredentials', () => {
    it('calls putFaceCredentials with the correct arguments', async () => {
      mockPutFaceCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.saveCredentials('compreface', { apiKey: 'cf-key', enabled: true });
      });

      expect(mockPutFaceCredentials).toHaveBeenCalledWith('compreface', {
        apiKey: 'cf-key',
        enabled: true,
      });
    });

    it('forwards baseUrl when provided', async () => {
      mockPutFaceCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.saveCredentials('compreface', {
          apiKey: 'key',
          baseUrl: 'http://compreface:8000',
        });
      });

      expect(mockPutFaceCredentials).toHaveBeenCalledWith('compreface', {
        apiKey: 'key',
        baseUrl: 'http://compreface:8000',
      });
    });

    it('forwards region when provided', async () => {
      mockPutFaceCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.saveCredentials('rekognition', { region: 'us-west-2' });
      });

      expect(mockPutFaceCredentials).toHaveBeenCalledWith('rekognition', { region: 'us-west-2' });
    });

    it('propagates errors from putFaceCredentials', async () => {
      mockPutFaceCredentials.mockRejectedValue(new Error('Save failed'));

      const { result } = renderHook(() => useFaceSettings());

      await expect(
        act(async () => {
          await result.current.saveCredentials('compreface', { apiKey: 'bad' });
        }),
      ).rejects.toThrow('Save failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('removeCredentials', () => {
    it('calls deleteFaceCredentials with the provider', async () => {
      mockDeleteFaceCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.removeCredentials('compreface');
      });

      expect(mockDeleteFaceCredentials).toHaveBeenCalledWith('compreface');
    });

    it('propagates errors from deleteFaceCredentials', async () => {
      mockDeleteFaceCredentials.mockRejectedValue(new Error('Delete failed'));

      const { result } = renderHook(() => useFaceSettings());

      await expect(
        act(async () => {
          await result.current.removeCredentials('compreface');
        }),
      ).rejects.toThrow('Delete failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('testProvider', () => {
    it('calls testFaceProvider with provider and model, returns result', async () => {
      mockTestFaceProvider.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useFaceSettings());

      let testResult: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        testResult = await result.current.testProvider('compreface', 'arcface-r100-v1');
      });

      expect(mockTestFaceProvider).toHaveBeenCalledWith({
        provider: 'compreface',
        model: 'arcface-r100-v1',
      });
      expect(testResult).toEqual({ ok: true });
    });

    it('returns ok:false with error when test fails', async () => {
      mockTestFaceProvider.mockResolvedValue({ ok: false, error: 'Bad credentials' });

      const { result } = renderHook(() => useFaceSettings());

      let testResult: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        testResult = await result.current.testProvider('compreface', 'arcface-r100-v1');
      });

      expect(testResult?.ok).toBe(false);
      expect(testResult?.error).toBe('Bad credentials');
    });

    it('propagates errors from testFaceProvider', async () => {
      mockTestFaceProvider.mockRejectedValue(new Error('Test threw'));

      const { result } = renderHook(() => useFaceSettings());

      await expect(
        act(async () => {
          await result.current.testProvider('compreface', 'arcface-r100-v1');
        }),
      ).rejects.toThrow('Test threw');
    });
  });

  // -------------------------------------------------------------------------
  describe('getModels', () => {
    it('calls getFaceModels with the provider and returns the list', async () => {
      mockGetFaceModels.mockResolvedValue(['arcface-r100-v1']);

      const { result } = renderHook(() => useFaceSettings());

      let models: string[] | undefined;
      await act(async () => {
        models = await result.current.getModels('compreface');
      });

      expect(mockGetFaceModels).toHaveBeenCalledWith('compreface');
      expect(models).toEqual(['arcface-r100-v1']);
    });

    it('returns an empty array when no models are available', async () => {
      mockGetFaceModels.mockResolvedValue([]);

      const { result } = renderHook(() => useFaceSettings());

      let models: string[] | undefined;
      await act(async () => {
        models = await result.current.getModels('unknown-provider');
      });

      expect(models).toEqual([]);
    });

    it('propagates errors from getFaceModels', async () => {
      mockGetFaceModels.mockRejectedValue(new Error('Models fetch failed'));

      const { result } = renderHook(() => useFaceSettings());

      await expect(
        act(async () => {
          await result.current.getModels('compreface');
        }),
      ).rejects.toThrow('Models fetch failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('saveDetectionFeature', () => {
    it('calls putFaceDetectionFeature with provider and model', async () => {
      mockPutFaceDetectionFeature.mockResolvedValue(undefined);

      const { result } = renderHook(() => useFaceSettings());

      await act(async () => {
        await result.current.saveDetectionFeature('compreface', 'arcface-r100-v1');
      });

      expect(mockPutFaceDetectionFeature).toHaveBeenCalledWith({
        provider: 'compreface',
        model: 'arcface-r100-v1',
      });
    });

    it('propagates errors from putFaceDetectionFeature', async () => {
      mockPutFaceDetectionFeature.mockRejectedValue(new Error('Feature save failed'));

      const { result } = renderHook(() => useFaceSettings());

      await expect(
        act(async () => {
          await result.current.saveDetectionFeature('compreface', 'arcface-r100-v1');
        }),
      ).rejects.toThrow('Feature save failed');
    });
  });
});
