import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  MemoriahubAndroidPortMissingError,
  MemoriahubWebHostProvider,
  useMemoriahubAndroid,
} from '../../src/core/headless/index.js';
import type { MemoriahubAndroidPort } from '../../src/core/headless/index.js';
import { createFakeMemoriahubWebHost } from '../../src/core/testing/index.js';

const port: MemoriahubAndroidPort = {
  appName: 'Product X',
  legacyPackageName: 'example.legacy',
  mediaSyncDeepLink: (path) => `example://media-sync${path ? `/${path}` : ''}`,
  isRunningInTwa: () => false,
  getInstalledAppVersion: () => null,
  useAndroidRelease: () => ({ release: null, isLoading: false, error: null }),
  useAndroidDownloadLink: () => ({ downloadLink: async () => ({ url: '/dl', expiresAt: '2030-01-01T00:00:00Z' }) }),
};

describe('useMemoriahubAndroid', () => {
  it('throws a named error when the host has no Android port', () => {
    const { host } = createFakeMemoriahubWebHost();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      renderHook(() => useMemoriahubAndroid(), {
        wrapper: ({ children }) => <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>,
      }),
    ).toThrow(MemoriahubAndroidPortMissingError);
    spy.mockRestore();
  });

  it('returns the port the host supplies', () => {
    const { host } = createFakeMemoriahubWebHost({ android: port });
    const { result } = renderHook(() => useMemoriahubAndroid(), {
      wrapper: ({ children }) => <MemoriahubWebHostProvider host={host}>{children}</MemoriahubWebHostProvider>,
    });
    expect(result.current.appName).toBe('Product X');
    expect(result.current.mediaSyncDeepLink('files')).toBe('example://media-sync/files');
  });
});
