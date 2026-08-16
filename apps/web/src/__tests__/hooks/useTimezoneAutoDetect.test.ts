/**
 * `useTimezoneAutoDetect` — unit tests (issue #444).
 *
 * The three behaviours worth pinning down are the ones a regression would
 * silently break: exactly ONE silent PATCH when nothing is stored, NO write at
 * all when something is, and ask-don't-act on a mismatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTimezoneAutoDetect } from '../../hooks/useTimezoneAutoDetect';
import { api } from '../../services/api';
import { detectTimeZone } from '../../utils/timezone';

vi.mock('../../utils/timezone', async () => {
  const actual =
    await vi.importActual<typeof import('../../utils/timezone')>('../../utils/timezone');
  return { ...actual, detectTimeZone: vi.fn(() => 'Europe/Madrid') };
});

const mockDetect = vi.mocked(detectTimeZone);

const USER = { id: 'user-1' };

describe('useTimezoneAutoDetect', () => {
  let patchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDetect.mockReturnValue('Europe/Madrid');
    sessionStorage.clear();
    patchSpy = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({} as never) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('stored value is null (never set)', () => {
    it('PATCHes the detected zone exactly once, silently', async () => {
      const onTimezoneApplied = vi.fn();

      const { result, rerender } = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: null },
          onTimezoneApplied,
        }),
      );

      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
      expect(patchSpy).toHaveBeenCalledWith('/user-settings', {
        timezone: 'Europe/Madrid',
      });
      // Silent: no prompt is raised for the fill-in case.
      expect(result.current.mismatch).toBeNull();
      await waitFor(() =>
        expect(onTimezoneApplied).toHaveBeenCalledWith('Europe/Madrid'),
      );

      // Re-renders must not repeat the write.
      rerender();
      rerender();
      expect(patchSpy).toHaveBeenCalledTimes(1);
    });

    it('does not PATCH when the browser reports no usable zone', async () => {
      mockDetect.mockReturnValue(null);

      const { result } = renderHook(() =>
        useTimezoneAutoDetect({ user: { ...USER, timezone: null } }),
      );

      await Promise.resolve();
      expect(patchSpy).not.toHaveBeenCalled();
      expect(result.current.mismatch).toBeNull();
    });

    it('swallows a failed PATCH — login must not break', async () => {
      patchSpy.mockRejectedValue(new Error('network down'));
      const onTimezoneApplied = vi.fn();
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      const { result } = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: null },
          onTimezoneApplied,
        }),
      );

      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
      // Let the rejection settle and any unhandled-rejection tick fire.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
      expect(onTimezoneApplied).not.toHaveBeenCalled();
      // The hook stays usable; nothing is surfaced to the user.
      expect(result.current.mismatch).toBeNull();
    });
  });

  describe('a value is already stored', () => {
    it('does not PATCH when the stored zone matches the browser', async () => {
      const { result } = renderHook(() =>
        useTimezoneAutoDetect({ user: { ...USER, timezone: 'Europe/Madrid' } }),
      );

      await Promise.resolve();
      expect(patchSpy).not.toHaveBeenCalled();
      expect(result.current.mismatch).toBeNull();
    });

    it('does not PATCH on a mismatch — it asks instead', async () => {
      const { result } = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );

      await waitFor(() =>
        expect(result.current.mismatch).toEqual({
          stored: 'America/Costa_Rica',
          detected: 'Europe/Madrid',
        }),
      );
      expect(patchSpy).not.toHaveBeenCalled();
    });

    it('does not PATCH when the stored zone is an explicit UTC choice', async () => {
      const { result } = renderHook(() =>
        useTimezoneAutoDetect({ user: { ...USER, timezone: 'UTC' } }),
      );

      await waitFor(() => expect(result.current.mismatch).not.toBeNull());
      expect(patchSpy).not.toHaveBeenCalled();
    });
  });

  describe('mismatch resolution', () => {
    it('writes the detected zone when the user accepts', async () => {
      const onTimezoneApplied = vi.fn();
      const { result } = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
          onTimezoneApplied,
        }),
      );

      await waitFor(() => expect(result.current.mismatch).not.toBeNull());

      await act(async () => {
        await result.current.applyDetected();
      });

      expect(patchSpy).toHaveBeenCalledWith('/user-settings', {
        timezone: 'Europe/Madrid',
      });
      expect(onTimezoneApplied).toHaveBeenCalledWith('Europe/Madrid');
      expect(result.current.mismatch).toBeNull();
    });

    it('rethrows a failed accept so the caller can report it', async () => {
      patchSpy.mockRejectedValue(new Error('nope'));
      const { result } = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );

      await waitFor(() => expect(result.current.mismatch).not.toBeNull());

      await expect(
        act(async () => {
          await result.current.applyDetected();
        }),
      ).rejects.toThrow('nope');

      // Still asking — a failed write must not look like a decision.
      expect(result.current.mismatch).not.toBeNull();
    });

    it('does not re-nag after a dismissal, even on a fresh mount', async () => {
      const first = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );

      await waitFor(() => expect(first.result.current.mismatch).not.toBeNull());
      act(() => first.result.current.dismiss());
      expect(first.result.current.mismatch).toBeNull();
      first.unmount();

      const second = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(second.result.current.mismatch).toBeNull();
    });

    it('still asks about a genuinely different move after a dismissal', async () => {
      const first = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );
      await waitFor(() => expect(first.result.current.mismatch).not.toBeNull());
      act(() => first.result.current.dismiss());
      first.unmount();

      mockDetect.mockReturnValue('Asia/Tokyo');
      const second = renderHook(() =>
        useTimezoneAutoDetect({
          user: { ...USER, timezone: 'America/Costa_Rica' },
        }),
      );

      await waitFor(() =>
        expect(second.result.current.mismatch).toEqual({
          stored: 'America/Costa_Rica',
          detected: 'Asia/Tokyo',
        }),
      );
    });
  });

  describe('session boundaries', () => {
    it('does nothing while there is no user', async () => {
      const { result } = renderHook(() => useTimezoneAutoDetect({ user: null }));

      await Promise.resolve();
      expect(patchSpy).not.toHaveBeenCalled();
      expect(result.current.mismatch).toBeNull();
    });

    it('re-evaluates when a different user signs in', async () => {
      const { rerender } = renderHook(
        ({ userId }: { userId: string }) =>
          useTimezoneAutoDetect({ user: { id: userId, timezone: null } }),
        { initialProps: { userId: 'user-1' } },
      );

      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));

      rerender({ userId: 'user-2' });
      await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(2));
    });
  });
});
