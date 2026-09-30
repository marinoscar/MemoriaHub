/**
 * Load, save, generate, rotate and remove the deployment's Web Push (VAPID)
 * configuration. Epic #481, issue #487.
 *
 * TWO SEPARATE FLAG GROUPS, on purpose. `save` (the enable switch plus the
 * subject) is a routine, non-destructive edit. `generate` / `rotate` / `remove`
 * share one `isActing` / `actionError` pair, because they are triggered from
 * the same confirmation flow and only one is ever in flight — collapsing them
 * into `save`'s flags would make the ordinary Save button spin during a
 * rotation, or vice versa.
 *
 * Every write RESOLVES `true`/`false` rather than throwing: every caller is a
 * click handler that needs to branch, and the error is already captured.
 *
 * THE RESPONSE IS ALWAYS THE NEW BASELINE. Each call returns the full admin
 * view and the hook adopts it — including after `remove`, which comes back
 * `configured: false` and flips the page to its empty state with no reload.
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../services/api';
import {
  generatePushConfig,
  getPushConfig,
  removePushConfig,
  rotatePushConfig,
  updatePushConfig,
} from '../services/pushConfig';
import type {
  PushConfigAdminView,
  PushConfigSubjectInput,
  UpdatePushConfigInput,
} from '../services/pushConfig';
import { useIsMounted } from './useIsMounted';

/** 403 is named explicitly — it is the one failure an admin can act on themselves. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage web push configuration';
    return err.message || fallback;
  }
  return fallback;
}

export interface UsePushConfigReturn {
  config: PushConfigAdminView | null;
  isLoading: boolean;
  loadError: string | null;

  isSaving: boolean;
  saveError: string | null;
  save: (input: UpdatePushConfigInput) => Promise<boolean>;
  clearSaveError: () => void;

  isActing: boolean;
  actionError: string | null;
  clearActionError: () => void;
  generate: (input?: PushConfigSubjectInput) => Promise<boolean>;
  rotate: (input?: PushConfigSubjectInput) => Promise<boolean>;
  remove: () => Promise<boolean>;

  refresh: () => Promise<void>;
}

export function usePushConfig(): UsePushConfigReturn {
  const [config, setConfig] = useState<PushConfigAdminView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMounted = useIsMounted();

  const fetchConfig = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await getPushConfig();
      if (isMounted()) setConfig(data);
    } catch (err) {
      if (isMounted()) setLoadError(messageFor(err, 'Failed to load web push configuration'));
    } finally {
      if (isMounted()) setIsLoading(false);
    }
  }, [isMounted]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  const save = useCallback(
    async (input: UpdatePushConfigInput): Promise<boolean> => {
      try {
        setIsSaving(true);
        setSaveError(null);
        const data = await updatePushConfig(input);
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          // The only 409 on PUT: enabling with no key pair. The row may have
          // been removed in another tab — reload so the page shows the truth.
          await fetchConfig();
          if (isMounted()) {
            setSaveError(
              err.message ||
                'Web push cannot be enabled until a key pair has been generated.',
            );
          }
          return false;
        }
        if (isMounted()) setSaveError(messageFor(err, 'Failed to save web push configuration'));
        return false;
      } finally {
        if (isMounted()) setIsSaving(false);
      }
    },
    [fetchConfig, isMounted],
  );

  const runAction = useCallback(
    async (operation: () => Promise<PushConfigAdminView>, fallback: string): Promise<boolean> => {
      try {
        setIsActing(true);
        setActionError(null);
        const data = await operation();
        if (isMounted()) setConfig(data);
        return true;
      } catch (err) {
        if (isMounted()) setActionError(messageFor(err, fallback));
        return false;
      } finally {
        if (isMounted()) setIsActing(false);
      }
    },
    [isMounted],
  );

  const generate = useCallback(
    (input: PushConfigSubjectInput = {}) =>
      runAction(() => generatePushConfig(input), 'Failed to generate a key pair'),
    [runAction],
  );

  const rotate = useCallback(
    (input: PushConfigSubjectInput = {}) =>
      runAction(() => rotatePushConfig(input), 'Failed to rotate the key pair'),
    [runAction],
  );

  const remove = useCallback(
    () => runAction(() => removePushConfig(), 'Failed to remove the web push configuration'),
    [runAction],
  );

  const clearSaveError = useCallback(() => setSaveError(null), []);
  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    config,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isActing,
    actionError,
    clearActionError,
    generate,
    rotate,
    remove,
    refresh: fetchConfig,
  };
}
