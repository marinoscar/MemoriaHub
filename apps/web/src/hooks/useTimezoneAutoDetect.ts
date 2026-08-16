import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { detectTimeZone } from '../utils/timezone';

/**
 * A stored zone that disagrees with the browser's — the traveller case, where
 * we ASK rather than act.
 */
export interface TimezoneMismatch {
  stored: string;
  detected: string;
}

/**
 * Per-session dismissal record. Keyed by the exact `stored → detected` pair so
 * dismissing "you look like you're in Europe/Paris" does not also mute a later,
 * genuinely different move to Asia/Tokyo.
 */
const DISMISS_KEY = 'memoriahub.timezonePrompt.dismissed';

function dismissalToken(stored: string, detected: string): string {
  return `${stored}->${detected}`;
}

function readDismissal(): string | null {
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    // Private-mode Safari and some in-app browsers throw on access.
    return null;
  }
}

function writeDismissal(token: string): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, token);
  } catch {
    // Dismissal degrades to "for this render" — never worth failing over.
  }
}

interface UseTimezoneAutoDetectOptions {
  /**
   * The signed-in user, or `null` when there is no session. Only `id` and the
   * RAW `timezone` are read — `null` there means "never set", which is what
   * makes the silent fill-in safe.
   */
  user: { id: string; timezone: string | null } | null;
  /**
   * Called with the zone actually written, so the caller can update its local
   * copy of the user. Without this, a later remount would see the stale `null`
   * and PATCH a second time.
   */
  onTimezoneApplied?: (timezone: string) => void;
}

interface UseTimezoneAutoDetectReturn {
  /** Non-null only in the ask-don't-act case. */
  mismatch: TimezoneMismatch | null;
  /** Accept the browser's zone. Rejects on failure so the caller can report it. */
  applyDetected: () => Promise<void>;
  /** Keep the stored zone; do not ask again this session. */
  dismiss: () => void;
}

/**
 * Login-time time-zone auto-detection (issue #444, epic #440).
 *
 * ⚠️ This runs ONCE PER SESSION, not once per page. It is called from
 * `AuthProvider` — which mounts once at the app root and is not remounted by
 * navigation — and is additionally ref-guarded on the user id. That placement
 * is the whole point: the `syncTheme` docblock in `useUserSettings` records
 * what happened (issue #392) when a settings consumer was hung off the app
 * shell and quietly started writing on every page load. An auto-PATCH with
 * that shape would be the same bug, plus a prompt that reappears on every
 * navigation.
 *
 * Three cases, keyed on the RAW stored value:
 *
 *   stored === null       never chose  → silently PATCH the detected zone.
 *                                        Fire-and-forget: a failure here must
 *                                        never block or break login.
 *   stored === detected   agreement    → do nothing.
 *   stored !== detected   disagreement → ASK. Never auto-apply: a user who
 *                                        deliberately set their home zone must
 *                                        not have it stomped by an airport
 *                                        browser.
 */
export function useTimezoneAutoDetect({
  user,
  onTimezoneApplied,
}: UseTimezoneAutoDetectOptions): UseTimezoneAutoDetectReturn {
  const [mismatch, setMismatch] = useState<TimezoneMismatch | null>(null);

  // Which user id has already been handled. Reset on sign-out so a second
  // sign-in within the same page load is evaluated again.
  const handledUserId = useRef<string | null>(null);

  // Held in a ref so a caller passing an inline arrow cannot re-trigger the
  // effect — which would defeat the once-per-session guarantee above.
  const onAppliedRef = useRef(onTimezoneApplied);
  useEffect(() => {
    onAppliedRef.current = onTimezoneApplied;
  }, [onTimezoneApplied]);

  useEffect(() => {
    if (!user) {
      handledUserId.current = null;
      setMismatch(null);
      return;
    }
    if (handledUserId.current === user.id) return;
    handledUserId.current = user.id;

    const detected = detectTimeZone();
    if (!detected) return;

    const stored = user.timezone;

    if (stored === null || stored === undefined) {
      // Never set: fill it in silently. No UI, no await, no blocking — and a
      // terminal catch so a failed write can never surface as an unhandled
      // rejection in the middle of the login flow.
      api
        .patch('/user-settings', { timezone: detected })
        .then(() => onAppliedRef.current?.(detected))
        .catch(() => {
          /* best-effort: the user can still set it on /settings */
        });
      return;
    }

    if (stored === detected) return;
    if (readDismissal() === dismissalToken(stored, detected)) return;

    setMismatch({ stored, detected });
  }, [user]);

  const applyDetected = useCallback(async () => {
    if (!mismatch) return;
    await api.patch('/user-settings', { timezone: mismatch.detected });
    onAppliedRef.current?.(mismatch.detected);
    setMismatch(null);
  }, [mismatch]);

  const dismiss = useCallback(() => {
    if (mismatch) writeDismissal(dismissalToken(mismatch.stored, mismatch.detected));
    setMismatch(null);
  }, [mismatch]);

  return { mismatch, applyDetected, dismiss };
}
