/**
 * `usePushConfig` — epic #481, issue #487. The service is mocked; this covers
 * the hook's load/save/action state machine and its adopt-the-response rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, waitFor } from '@testing-library/react';
import { renderHookWithProviders } from '../utils/hook-utils';
import { ApiError } from '../../services/api';
import type { PushConfigAdminView } from '../../services/pushConfig';

vi.mock('../../services/pushConfig', () => ({
  getPushConfig: vi.fn(),
  updatePushConfig: vi.fn(),
  generatePushConfig: vi.fn(),
  rotatePushConfig: vi.fn(),
  removePushConfig: vi.fn(),
}));

import {
  generatePushConfig,
  getPushConfig,
  removePushConfig,
  rotatePushConfig,
  updatePushConfig,
} from '../../services/pushConfig';
import { usePushConfig } from '../../hooks/usePushConfig';

const base: PushConfigAdminView = {
  enabled: true,
  configured: true,
  active: true,
  publicKey: 'BPUB',
  subject: null,
  effectiveSubject: 'mailto:default@example.com',
  privateKeyStatus: { configured: true, last4: 'abcd', updatedAt: null },
  settingsError: null,
  updatedAt: null,
  updatedById: null,
};

describe('usePushConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPushConfig).mockResolvedValue(base);
  });

  it('loads the config on mount', async () => {
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.config).toEqual(base);
    expect(result.current.loadError).toBeNull();
  });

  it('names a 403 on load', async () => {
    vi.mocked(getPushConfig).mockRejectedValue(new ApiError('Forbidden', 403));
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loadError).toMatch(/do not have permission/);
  });

  it('adopts the saved response as the new baseline', async () => {
    vi.mocked(updatePushConfig).mockResolvedValue({ ...base, enabled: false, active: false });
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ enabled: false });
    });

    expect(ok).toBe(true);
    expect(updatePushConfig).toHaveBeenCalledWith({ enabled: false });
    expect(result.current.config?.enabled).toBe(false);
  });

  it('reloads and reports on a 409 save (enabling with no key pair)', async () => {
    vi.mocked(updatePushConfig).mockRejectedValue(
      new ApiError('No key pair has been generated', 409),
    );
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.save({ enabled: true });
    });

    expect(ok).toBe(false);
    expect(getPushConfig).toHaveBeenCalledTimes(2);
    expect(result.current.saveError).toBe('No key pair has been generated');
  });

  it('runs generate / rotate / remove through the shared action flags', async () => {
    vi.mocked(generatePushConfig).mockResolvedValue(base);
    vi.mocked(rotatePushConfig).mockResolvedValue({ ...base, publicKey: 'BNEW' });
    vi.mocked(removePushConfig).mockResolvedValue({ ...base, configured: false, publicKey: null });
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.generate({ subject: 'mailto:a@b.co' });
    });
    expect(generatePushConfig).toHaveBeenCalledWith({ subject: 'mailto:a@b.co' });

    await act(async () => {
      await result.current.rotate();
    });
    expect(result.current.config?.publicKey).toBe('BNEW');

    await act(async () => {
      await result.current.remove();
    });
    expect(result.current.config?.configured).toBe(false);
    expect(result.current.isActing).toBe(false);
  });

  it('captures an action failure and resolves false', async () => {
    vi.mocked(rotatePushConfig).mockRejectedValue(new ApiError('Nothing configured yet', 409));
    const { result } = renderHookWithProviders(() => usePushConfig());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.rotate();
    });

    expect(ok).toBe(false);
    expect(result.current.actionError).toBe('Nothing configured yet');
    act(() => result.current.clearActionError());
    expect(result.current.actionError).toBeNull();
  });
});
