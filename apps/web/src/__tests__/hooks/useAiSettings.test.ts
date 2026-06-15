import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAiSettings } from '../../hooks/useAiSettings';

// ---------------------------------------------------------------------------
// Mock the entire AI service module so tests are isolated from network
// ---------------------------------------------------------------------------

vi.mock('../../services/ai', () => ({
  getAiSettings: vi.fn(),
  putAiCredentials: vi.fn(),
  deleteAiCredentials: vi.fn(),
  testAiProvider: vi.fn(),
  getAiModels: vi.fn(),
  putAiSearchFeature: vi.fn(),
}));

import {
  getAiSettings,
  putAiCredentials,
  deleteAiCredentials,
  testAiProvider,
  getAiModels,
  putAiSearchFeature,
} from '../../services/ai';
import type { AiSettingsResponse } from '../../services/ai';

const mockGetAiSettings = vi.mocked(getAiSettings);
const mockPutAiCredentials = vi.mocked(putAiCredentials);
const mockDeleteAiCredentials = vi.mocked(deleteAiCredentials);
const mockTestAiProvider = vi.mocked(testAiProvider);
const mockGetAiModels = vi.mocked(getAiModels);
const mockPutAiSearchFeature = vi.mocked(putAiSearchFeature);

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const mockSettings: AiSettingsResponse = {
  providers: [
    { provider: 'openai', configured: true, enabled: true, last4: 'abcd', baseUrl: null },
  ],
  knownProviders: [
    { provider: 'anthropic', configured: false, enabled: false, last4: null, baseUrl: null },
  ],
  features: {
    search: { provider: 'openai', model: 'gpt-4o' },
  },
  conversations: {
    archiveAfterDays: 30,
    deleteAfterArchiveDays: 30,
  },
};

// ---------------------------------------------------------------------------

describe('useAiSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with settings null, loading false, error null', () => {
      // Never-resolving promise keeps loading indefinitely to capture initial state
      mockGetAiSettings.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useAiSettings());

      expect(result.current.settings).toBeNull();
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('exposes all action functions', () => {
      mockGetAiSettings.mockReturnValue(new Promise(() => {}));

      const { result } = renderHook(() => useAiSettings());

      expect(typeof result.current.fetchSettings).toBe('function');
      expect(typeof result.current.saveCredentials).toBe('function');
      expect(typeof result.current.removeCredentials).toBe('function');
      expect(typeof result.current.testProvider).toBe('function');
      expect(typeof result.current.getModels).toBe('function');
      expect(typeof result.current.saveSearchFeature).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  describe('fetchSettings', () => {
    it('sets loading true while fetching, then false after success', async () => {
      let resolve: (v: AiSettingsResponse) => void;
      const deferred = new Promise<AiSettingsResponse>((res) => { resolve = res; });
      mockGetAiSettings.mockReturnValue(deferred);

      const { result } = renderHook(() => useAiSettings());

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
      mockGetAiSettings.mockResolvedValue(mockSettings);

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.settings).toEqual(mockSettings);
      expect(result.current.error).toBeNull();
    });

    it('sets error string on failure (Error instance)', async () => {
      mockGetAiSettings.mockRejectedValue(new Error('Network failure'));

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('Network failure');
      expect(result.current.settings).toBeNull();
      expect(result.current.loading).toBe(false);
    });

    it('sets fallback error message for non-Error throws', async () => {
      mockGetAiSettings.mockRejectedValue('plain string error');

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('Failed to load AI settings');
    });

    it('clears previous error on subsequent successful fetch', async () => {
      mockGetAiSettings.mockRejectedValueOnce(new Error('First failure'));

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBe('First failure');

      mockGetAiSettings.mockResolvedValueOnce(mockSettings);

      await act(async () => {
        await result.current.fetchSettings();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.settings).toEqual(mockSettings);
    });
  });

  // -------------------------------------------------------------------------
  describe('saveCredentials', () => {
    it('calls putAiCredentials with the correct arguments', async () => {
      mockPutAiCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.saveCredentials('openai', { apiKey: 'sk-test', enabled: true });
      });

      expect(mockPutAiCredentials).toHaveBeenCalledWith('openai', {
        apiKey: 'sk-test',
        enabled: true,
      });
    });

    it('forwards the baseUrl when provided', async () => {
      mockPutAiCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.saveCredentials('openai', {
          apiKey: 'key',
          baseUrl: 'https://custom.endpoint',
        });
      });

      expect(mockPutAiCredentials).toHaveBeenCalledWith('openai', {
        apiKey: 'key',
        baseUrl: 'https://custom.endpoint',
      });
    });

    it('propagates errors from putAiCredentials', async () => {
      mockPutAiCredentials.mockRejectedValue(new Error('Save failed'));

      const { result } = renderHook(() => useAiSettings());

      await expect(
        act(async () => {
          await result.current.saveCredentials('openai', { apiKey: 'bad' });
        }),
      ).rejects.toThrow('Save failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('removeCredentials', () => {
    it('calls deleteAiCredentials with the provider', async () => {
      mockDeleteAiCredentials.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.removeCredentials('openai');
      });

      expect(mockDeleteAiCredentials).toHaveBeenCalledWith('openai');
    });

    it('propagates errors from deleteAiCredentials', async () => {
      mockDeleteAiCredentials.mockRejectedValue(new Error('Delete failed'));

      const { result } = renderHook(() => useAiSettings());

      await expect(
        act(async () => {
          await result.current.removeCredentials('openai');
        }),
      ).rejects.toThrow('Delete failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('testProvider', () => {
    it('calls testAiProvider with provider and model, returns result', async () => {
      mockTestAiProvider.mockResolvedValue({ ok: true });

      const { result } = renderHook(() => useAiSettings());

      let testResult: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        testResult = await result.current.testProvider('openai', 'gpt-4o');
      });

      expect(mockTestAiProvider).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o' });
      expect(testResult).toEqual({ ok: true });
    });

    it('returns ok:false with error when test fails', async () => {
      mockTestAiProvider.mockResolvedValue({ ok: false, error: 'Bad credentials' });

      const { result } = renderHook(() => useAiSettings());

      let testResult: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        testResult = await result.current.testProvider('openai', 'gpt-4o');
      });

      expect(testResult?.ok).toBe(false);
      expect(testResult?.error).toBe('Bad credentials');
    });

    it('propagates errors from testAiProvider', async () => {
      mockTestAiProvider.mockRejectedValue(new Error('Test threw'));

      const { result } = renderHook(() => useAiSettings());

      await expect(
        act(async () => {
          await result.current.testProvider('openai', 'gpt-4o');
        }),
      ).rejects.toThrow('Test threw');
    });
  });

  // -------------------------------------------------------------------------
  describe('getModels', () => {
    it('calls getAiModels with the provider and returns the list', async () => {
      mockGetAiModels.mockResolvedValue(['gpt-4o', 'gpt-4', 'gpt-3.5-turbo']);

      const { result } = renderHook(() => useAiSettings());

      let models: string[] | undefined;
      await act(async () => {
        models = await result.current.getModels('openai');
      });

      expect(mockGetAiModels).toHaveBeenCalledWith('openai');
      expect(models).toEqual(['gpt-4o', 'gpt-4', 'gpt-3.5-turbo']);
    });

    it('returns an empty array when no models are available', async () => {
      mockGetAiModels.mockResolvedValue([]);

      const { result } = renderHook(() => useAiSettings());

      let models: string[] | undefined;
      await act(async () => {
        models = await result.current.getModels('unknown-provider');
      });

      expect(models).toEqual([]);
    });

    it('propagates errors from getAiModels', async () => {
      mockGetAiModels.mockRejectedValue(new Error('Models fetch failed'));

      const { result } = renderHook(() => useAiSettings());

      await expect(
        act(async () => {
          await result.current.getModels('openai');
        }),
      ).rejects.toThrow('Models fetch failed');
    });
  });

  // -------------------------------------------------------------------------
  describe('saveSearchFeature', () => {
    it('calls putAiSearchFeature with provider and model', async () => {
      mockPutAiSearchFeature.mockResolvedValue(undefined);

      const { result } = renderHook(() => useAiSettings());

      await act(async () => {
        await result.current.saveSearchFeature('openai', 'gpt-4o');
      });

      expect(mockPutAiSearchFeature).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-4o' });
    });

    it('propagates errors from putAiSearchFeature', async () => {
      mockPutAiSearchFeature.mockRejectedValue(new Error('Feature save failed'));

      const { result } = renderHook(() => useAiSettings());

      await expect(
        act(async () => {
          await result.current.saveSearchFeature('openai', 'gpt-4o');
        }),
      ).rejects.toThrow('Feature save failed');
    });
  });
});
