/**
 * Fetch hooks over `services/androidApp.ts` for the admin Android app page
 * (`/admin/settings/android`, issue #516, epic #498).
 *
 * House contract: `useIsMounted()` guards every `setState` past an `await`;
 * an `ApiError` becomes its message (403 named explicitly); writes RESOLVE to
 * a result rather than throwing, with the API's `details.reason` attached so
 * the page can branch on it (force retry, bump hint, field errors).
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  deleteRelease,
  errorReason,
  getAndroidAppConfig,
  listReleases,
  makeReleaseCurrent,
  putAndroidAppConfig,
  uploadRelease,
  type AdminRelease,
  type AndroidAppConfig,
  type TrustedApp,
  type UploadProgress,
  type UploadReleaseInput,
} from '../services/androidApp';
import { useIsMounted } from './useIsMounted';

export function androidAppErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to do this.';
    return err.message || fallback;
  }
  return fallback;
}

/** What a failed write answered: the message to show and the API's `details.reason`. */
export interface AndroidAppWriteError {
  message: string;
  reason: string | null;
}

export type WriteResult<T> = { ok: true; value: T } | { ok: false; error: AndroidAppWriteError };

function writeError(err: unknown, fallback: string): AndroidAppWriteError {
  return { message: androidAppErrorMessage(err, fallback), reason: errorReason(err) };
}

/** `GET` / `PUT /api/admin/android-app` */
export function useAndroidAppConfig() {
  const [config, setConfig] = useState<AndroidAppConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const next = await getAndroidAppConfig();
      if (isMounted()) setConfig(next);
    } catch (err) {
      if (isMounted()) setError(androidAppErrorMessage(err, 'Failed to load the Android app settings'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Replaces the whole trusted list; the response is the saved state. */
  const save = useCallback(
    async (trustedApps: TrustedApp[]): Promise<WriteResult<AndroidAppConfig>> => {
      try {
        setIsSaving(true);
        const next = await putAndroidAppConfig(trustedApps);
        if (isMounted()) setConfig(next);
        return { ok: true, value: next };
      } catch (err) {
        return { ok: false, error: writeError(err, 'Failed to save the trusted signing keys') };
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [isMounted],
  );

  return { config, isLoading, error, isSaving, save, refresh };
}

/**
 * The admin release list and its writes. Every write re-reads the list:
 * making one release current clears the flag on another, which only the
 * server knows.
 */
export function useAndroidReleases() {
  const [releases, setReleases] = useState<AdminRelease[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const isMounted = useIsMounted();

  const refresh = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const next = await listReleases();
      if (isMounted()) setReleases(next);
    } catch (err) {
      if (isMounted()) setError(androidAppErrorMessage(err, 'Failed to load the Android app releases'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async <T>(work: () => Promise<T>, fallback: string): Promise<WriteResult<T>> => {
      try {
        const value = await work();
        await refresh();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: writeError(err, fallback) };
      }
    },
    [refresh],
  );

  const upload = useCallback(
    async (input: UploadReleaseInput) => {
      setIsUploading(true);
      setProgress({ loaded: 0, total: input.apk.size });
      try {
        return await run(
          () =>
            uploadRelease(input, (p) => {
              if (isMounted()) setProgress(p);
            }),
          'Failed to upload the release',
        );
      } finally {
        if (isMounted()) {
          setIsUploading(false);
          setProgress(null);
        }
      }
    },
    [run, isMounted],
  );

  const makeCurrent = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        return await run(() => makeReleaseCurrent(id), 'Failed to make the release current');
      } finally {
        if (isMounted()) setBusyId(null);
      }
    },
    [run, isMounted],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        return await run(() => deleteRelease(id), 'Failed to delete the release');
      } finally {
        if (isMounted()) setBusyId(null);
      }
    },
    [run, isMounted],
  );

  return { releases, isLoading, error, refresh, busyId, isUploading, progress, upload, makeCurrent, remove };
}
