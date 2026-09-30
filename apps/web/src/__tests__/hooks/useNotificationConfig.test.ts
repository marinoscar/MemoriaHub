/**
 * Issue #486 — `useNotificationConfig`, a plain fetch-on-mount hook over
 * `GET /api/notifications/config`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../services/notifications', () => ({
  getNotificationConfig: vi.fn(),
}));

import { useNotificationConfig } from '../../hooks/useNotificationConfig';
import { getNotificationConfig } from '../../services/notifications';
import type { NotificationClientConfig } from '../../types/notifications';

const mockGet = vi.mocked(getNotificationConfig);

const config: NotificationClientConfig = {
  pushEnabled: true,
  vapidPublicKey: 'key',
  browserEnabled: true,
  pushTypes: ['upload_completed'],
};

describe('useNotificationConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts loading with a null config — "not known yet", never "disabled"', () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useNotificationConfig());
    expect(result.current.config).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('resolves the config', async () => {
    mockGet.mockResolvedValue(config);
    const { result } = renderHook(() => useNotificationConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(config);
  });

  it('reports an error and keeps config null on failure', async () => {
    mockGet.mockRejectedValue(new Error('nope'));
    const { result } = renderHook(() => useNotificationConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('nope');
    expect(result.current.config).toBeNull();
  });

  it('refresh re-reads', async () => {
    mockGet.mockResolvedValue(config);
    const { result } = renderHook(() => useNotificationConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    mockGet.mockResolvedValue({ ...config, pushEnabled: false, vapidPublicKey: null });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.config?.pushEnabled).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
