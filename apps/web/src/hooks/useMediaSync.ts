/**
 * Fetch hooks over `services/mediaSync.ts` and `services/androidApp.ts`
 * (issue #515, epic #498).
 *
 * The house fetch-hook contract: `useIsMounted()` guards every post-`await`
 * setState, an error becomes a message, and `refresh` resolves rather than
 * throws (the error is captured for rendering).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listDeviceDiagnostics,
  listDeviceRuns,
  listDevices,
  mediaSyncErrorMessage,
  type MediaSyncDevice,
  type MediaSyncReportSummary,
  type MediaSyncRun,
} from '../services/mediaSync';
import { getLatestRelease, type PublicRelease } from '../services/androidApp';
import { useIsMounted } from './useIsMounted';

interface Loaded<T> {
  data: T;
  isLoading: boolean;
  error: string | null;
  /** Reload; shows the loading state. */
  refresh: () => Promise<void>;
  /** Reload without the loading state (polling, after a write). */
  reload: () => Promise<void>;
}

function useLoad<T>(
  fetcher: () => Promise<T>,
  initial: T,
  fallback: string,
  enabled: boolean,
): Loaded<T> {
  const [data, setData] = useState<T>(initial);
  const [isLoading, setIsLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(
    async (silent: boolean) => {
      try {
        if (!silent) setIsLoading(true);
        const next = await fetcher();
        if (!isMounted()) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (isMounted()) setError(mediaSyncErrorMessage(err, fallback));
      } finally {
        if (isMounted() && !silent) setIsLoading(false);
      }
    },
    [fetcher, fallback, isMounted],
  );

  const refresh = useCallback(() => load(false), [load]);
  const reload = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (enabled) void refresh();
    else setIsLoading(false);
  }, [enabled, refresh]);

  return { data, isLoading, error, refresh, reload };
}

/** Is the document visible? (Polling pauses in a background tab.) */
function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Call `tick` every `intervalMs` while the page is visible, and once when it
 * becomes visible again. `intervalMs <= 0` disables polling.
 */
export function useVisiblePolling(tick: () => void, intervalMs: number, enabled = true): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return undefined;
    const timer = window.setInterval(() => {
      if (isVisible()) tickRef.current();
    }, intervalMs);
    const onVisibility = () => {
      if (isVisible()) tickRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, intervalMs]);
}

/** Refetch cadence of the Media Sync page (issue #515: every 30 s while visible). */
export const MEDIA_SYNC_POLL_MS = 30_000;

const NO_DEVICES: MediaSyncDevice[] = [];
const NO_RUNS: MediaSyncRun[] = [];
const NO_REPORTS: MediaSyncReportSummary[] = [];

/** `GET /api/media-sync/devices`, optionally polled while the page is visible. */
export function useMediaSyncDevices(options: { enabled?: boolean; pollMs?: number } = {}) {
  const { enabled = true, pollMs = 0 } = options;
  const fetcher = useCallback(() => listDevices(), []);
  const { data, reload, ...rest } = useLoad(
    fetcher,
    NO_DEVICES,
    'Failed to load your phones',
    enabled,
  );
  useVisiblePolling(() => void reload(), pollMs, enabled);
  return { devices: data, reload, ...rest };
}

/** `GET /api/media-sync/devices/:id/runs`, once `enabled` (a section was opened). */
export function useDeviceRuns(deviceId: string, enabled = true) {
  const fetcher = useCallback(() => listDeviceRuns(deviceId, 100), [deviceId]);
  const { data, ...rest } = useLoad(fetcher, NO_RUNS, 'Failed to load the sync history', enabled);
  return { runs: data, ...rest };
}

/** `GET /api/media-sync/devices/:id/diagnostics`, once `enabled`. */
export function useDeviceDiagnostics(deviceId: string, enabled = true) {
  const fetcher = useCallback(() => listDeviceDiagnostics(deviceId), [deviceId]);
  const { data, ...rest } = useLoad(
    fetcher,
    NO_REPORTS,
    'Failed to load the diagnostic reports',
    enabled,
  );
  return { reports: data, ...rest };
}

/**
 * `GET /api/android-app/releases/latest` while `enabled`: the current APK, or
 * `null` when none is published (the API's 404 `NO_RELEASE`).
 */
export function useLatestRelease(enabled = true) {
  const fetcher = useCallback(() => getLatestRelease(), []);
  const { data, ...rest } = useLoad<PublicRelease | null>(
    fetcher,
    null,
    'Failed to load the Android app release',
    enabled,
  );
  return { release: data, ...rest };
}
